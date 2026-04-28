import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

import express from "express";
import cors from "cors";
import { query, getDiagnostics, resetConnection } from "./databricksClient.js";

const app = express();
const PORT = process.env.DATABRICKS_APP_PORT || process.env.PORT || 3001;
const isDev = !process.env.DATABRICKS_APP_PORT;

if (isDev) {
  app.use(cors({ origin: ["http://localhost:5173", "http://localhost:5174"] }));
}
app.use(express.json());

// Serve the built frontend in production (Databricks Apps)
if (!isDev) {
  const distPath = path.resolve(__dirname, "../dist");
  app.use(express.static(distPath));
}

// ── Table refs ─────────────────────────────────────────────────────────────────
const CASE    = 'Prod_redshift_replica.bizops_staging.crm_case';
const USER    = 'Prod_redshift_replica.bizops_staging.crm_user';
const TD      = 'Prod_redshift_replica.bizops_staging.talkdesk_fact_calls';
const LAI_SCORE  = 'prod_raw.level_ai.homebase_instascore';
const LAI_ASR    = 'prod_raw.level_ai.homebase_level_asr_asrlog';
const LAI_USER   = 'prod_raw.level_ai.homebase_accounts_user';
const LAI_QA     = 'prod_raw.level_ai.homebase_qa_metrics';

// ── Instascore category weights (from LevelAI Rubric Settings) ─────────────────
const INSTASCORE_CATEGORY_WEIGHTS = {
  'Own your Impact':      25,
  'Move Fast Learn Fast': 20,
  'Be Customer Obsessed': 20,
  'Purple Standard':      20,
  'In Service':           15,
};

// Returns max QUESTION_SCORE_PCNT for a question using substring matching.
// Immune to appended option text in the DB (e.g. '... "Sell Made Sell Attempt No Attempt"').
function questionMaxPcnt(questionText) {
  const t = (questionText || '').toLowerCase();
  if (t.includes('make the sell')) return 200;
  if (t.includes('accurate product terms')) return 200;
  return 100;
}

// Both multi-point questions store scores at half-scale in the DB (max=100 instead of 200).
// Multiply by 2 to normalize: Sell Attempt 50→100, Sell Made 100→200, Resolved 100→200, Partially 50→100.
function adjustedScore(item) {
  const t = (item.question || '').toLowerCase();
  if (t.includes('make the sell') || t.includes('accurate product terms')) {
    return (item.score ?? 0) * 2;
  }
  return item.score ?? 0;
}

function weightedInstascore(categoryScores) {
  const present = categoryScores.filter(
    c => INSTASCORE_CATEGORY_WEIGHTS[c.category] != null && c.score != null && !isNaN(c.score)
  );
  if (!present.length) return null;
  const presentWeight  = present.reduce((s, c) => s + INSTASCORE_CATEGORY_WEIGHTS[c.category], 0);
  const missingWeight  = 100 - presentWeight;
  const distributed    = missingWeight / present.length;   // equal share to each present category
  return Math.round(
    present.reduce((s, c) => s + c.score * (INSTASCORE_CATEGORY_WEIGHTS[c.category] + distributed), 0) / 100
  );
}

// ── SQL helpers ────────────────────────────────────────────────────────────────
const DATE_TRUNC = {
  today:     `CURRENT_DATE()`,
  yesterday: `DATE_ADD(CURRENT_DATE(), -1)`,
  week:      `DATE_TRUNC('WEEK', CURRENT_DATE())`,
  last_week: `DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)`,
  month:     `DATE_TRUNC('MONTH', CURRENT_DATE())`,
  last_month:`DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))`,
  last_30:   `DATE_SUB(CURRENT_DATE(), 30)`,
  quarter:   `DATE_TRUNC('QUARTER', CURRENT_DATE())`,
  year:      `DATE_TRUNC('YEAR', CURRENT_DATE())`,
};

const ISO_RE   = /^\d{4}-\d{2}-\d{2}$/;
const SFID_RE  = /^[a-zA-Z0-9]{15,18}$/;

function createdSince({ period = 'week', startDate, endDate } = {}, alias = '') {
  const col = alias ? `${alias}.createddate` : 'createddate';
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(${col}) BETWEEN '${startDate}' AND '${endDate}'`;
  return `DATE(${col}) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
}

function closedSince({ period = 'week', startDate, endDate } = {}, alias = '') {
  const col = alias ? `${alias}.closeddate` : 'closeddate';
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(${col}) BETWEEN '${startDate}' AND '${endDate}'`;
  return `DATE(${col}) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
}

function ownerWhere({ ownerIds, ownerId } = {}) {
  const raw = ownerIds || ownerId || null;
  if (!raw) return '';
  const ids = String(raw).split(',').map(s => s.trim()).filter(s => SFID_RE.test(s));
  if (!ids.length) return '';
  return `AND ownerid IN (${ids.map(s => `'${s}'`).join(', ')})`;
}

function tdPeriod(period) {
  return DATE_TRUNC[period] || DATE_TRUNC.week;
}

function userInfoShape(rows) {
  return rows.map(u => ({
    Id: u.Id,
    Name: u.Name,
    Department: u.Department ?? null,
    UserRole: { Name: u.role_name ?? null },
  }));
}

// ── GET /api/overview-data ─────────────────────────────────────────────────────
app.get("/api/overview-data", async (req, res) => {
  const p = req.query;
  const ow = ownerWhere(p);
  const cl = closedSince(p);
  const cd = createdSince(p);

  try {
    const [statusRows, closedTodayRows, avgRespRows, emailsTodayRows, dailyRows, hourlyRows, totalClosedRows] =
      await Promise.all([
        query(`SELECT status AS Status, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND isclosed = 'false' AND ${cd} ${ow}
               GROUP BY status`),
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${cl} ${ow}`),
        query(`SELECT AVG(CAST(case_response_time_hours__c AS DOUBLE)) AS avg_hrs
               FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${cl} AND case_response_time_hours__c IS NOT NULL ${ow}`),
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND origin = 'Email'
               AND ${cd} ${ow}`),
        query(`SELECT DATE_FORMAT(closeddate, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${cl} ${ow}
               GROUP BY day ORDER BY day`),
        query(`SELECT HOUR(createddate) AS hr, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND DATE(createddate) = CURRENT_DATE() ${ow}
               GROUP BY hr ORDER BY hr`),
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${cl} ${ow}`),
      ]);

    res.json({
      statusTotals:      { records: statusRows },
      closedToday:       Number(closedTodayRows[0]?.cnt ?? 0),
      avgResponseHrs:    Number(avgRespRows[0]?.avg_hrs ?? 0),
      emailsToday:       Number(emailsTodayRows[0]?.cnt ?? 0),
      dailyClosed14d:    { records: dailyRows },
      hourlyNew:         { records: hourlyRows },
      totalClosedPeriod: Number(totalClosedRows[0]?.cnt ?? 0),
    });
  } catch (err) {
    console.error('❌ [overview-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Returns a SQL WHERE fragment for the "prior" comparison period, or null if none exists.
function priorClosedClause(period) {
  switch (period) {
    case 'today':
      return `DATE(closeddate) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'week':
      return `DATE(closeddate) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)
              AND DATE(closeddate) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_week':
      return `DATE(closeddate) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -14)
              AND DATE(closeddate) < DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)`;
    case 'month':
      return `DATE(closeddate) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))
              AND DATE(closeddate) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(closeddate) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -2))
              AND DATE(closeddate) < DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))`;
    default:
      return null;
  }
}

// ── GET /api/rep-detail ────────────────────────────────────────────────────────
app.get("/api/rep-detail", async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });

  const owId  = `AND ownerid = '${ownerId}'`;
  const cl    = closedSince({ period, startDate, endDate });
  const isCustom = startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate);
  const priorClause = isCustom ? null : priorClosedClause(period);
  const hasPrior = priorClause !== null;

  try {
    const queries = [
      // 1. All currently-open cases for this rep (not period-filtered)
      query(`SELECT id AS Id, casenumber AS CaseNumber, subject AS Subject,
                    status AS Status, createddate AS CreatedDate,
                    lastmodifieddate AS LastModifiedDate,
                    CAST(case_response_time_hours__c AS DOUBLE) AS Case_Response_Time_Hours__c
             FROM ${CASE}
             WHERE is_current = true AND isclosed = 'false' ${owId}
             ORDER BY createddate ASC`),
      // 2. Closed count for current period
      query(`SELECT COUNT(*) AS cnt FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true' AND ${cl} ${owId}`),
      // 3. Avg response time for current period
      query(`SELECT AVG(CAST(case_response_time_hours__c AS DOUBLE)) AS avg_hrs
             FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true'
             AND ${cl} AND case_response_time_hours__c IS NOT NULL ${owId}`),
      // 4. CSAT for this rep (all-time — CSAT data is sparse)
      query(`SELECT ownerid AS OwnerId,
                    AVG(CAST(satisfaction_score__c AS DOUBLE)) AS Satisfaction_Score__c
             FROM ${CASE}
             WHERE is_current = true AND satisfaction_score__c IS NOT NULL ${owId}
             GROUP BY ownerid`),
      // 5. Avg response time across ALL cases (open + closed) created in period
      query(`SELECT AVG(CAST(case_response_time_hours__c AS DOUBLE)) AS avg_hrs_all
             FROM ${CASE}
             WHERE is_current = true
             AND DATE(createddate) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}
             AND case_response_time_hours__c IS NOT NULL ${owId}`),
    ];

    // 6. Prior period closed count — only when a comparison exists
    if (hasPrior) {
      queries.push(
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${priorClause} ${owId}`)
      );
    }

    const [cases, closedRow, avgRespRow, csatRows, avgRespAllRow, priorRow] = await Promise.all(queries);

    res.json({
      cases:              { records: cases },
      closedPeriod:       Number(closedRow[0]?.cnt ?? 0),
      closedPriorPeriod:  hasPrior ? Number(priorRow[0]?.cnt ?? 0) : 0,
      hasPrior,
      avgResponseHrs:     Number(avgRespRow[0]?.avg_hrs ?? 0),
      avgResponseHrsAll:  avgRespAllRow[0]?.avg_hrs_all != null ? Number(avgRespAllRow[0].avg_hrs_all) : null,
      csatData:           { records: csatRows },
    });
  } catch (err) {
    console.error('❌ [rep-detail]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/cases-data ────────────────────────────────────────────────────────
app.get("/api/cases-data", async (req, res) => {
  const p = req.query;
  const ow = ownerWhere(p);
  const cl = closedSince(p);

  try {
    const [ahtData, csatData, closedWeek, userInfo] = await Promise.all([
      query(`SELECT c.ownerid AS OwnerId, u.name AS Name,
                    AVG(CAST(c.case_response_time_hours__c AS DOUBLE)) AS avgRespHrs,
                    COUNT(*) AS cnt
             FROM ${CASE} c
             JOIN ${USER} u ON c.ownerid = u.id AND u.is_current = true
             WHERE c.is_current = true AND c.isclosed = 'true'
             AND ${cl} AND c.case_response_time_hours__c IS NOT NULL ${ow}
             GROUP BY c.ownerid, u.name`),
      query(`SELECT ownerid AS OwnerId,
                    AVG(CAST(satisfaction_score__c AS DOUBLE)) AS Satisfaction_Score__c
             FROM ${CASE}
             WHERE is_current = true AND satisfaction_score__c IS NOT NULL ${ow}
             GROUP BY ownerid`),
      query(`SELECT ownerid AS OwnerId, COUNT(*) AS cnt FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true' AND ${cl} ${ow}
             GROUP BY ownerid`),
      query(`SELECT u.id AS Id, u.name AS Name, u.team__c AS role_name, u.department AS Department
             FROM ${USER} u
             WHERE u.is_current = true AND u.isactive = 'true' AND u.usertype = 'Standard'`),
    ]);

    res.json({
      ahtData:    { records: ahtData.map(r => ({ ...r, Owner: { Name: r.Name } })) },
      csatData:   { records: csatData },
      closedWeek: { records: closedWeek },
      userInfo:   { records: userInfo.map(u => ({ Id: u.Id, Name: u.Name, UserRole: { Name: u.role_name }, Department: u.Department })) },
    });
  } catch (err) {
    console.error('❌ [cases-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/volume-data ───────────────────────────────────────────────────────
app.get("/api/volume-data", async (req, res) => {
  const p = req.query;
  const ow = ownerWhere(p);

  try {
    const [originToday, hourlyToday, daily14d, typeBreakdown, emailDaily14d, totalOpen] =
      await Promise.all([
        query(`SELECT origin AS Origin, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND DATE(createddate) = CURRENT_DATE() ${ow}
               GROUP BY origin ORDER BY cnt DESC`),
        query(`SELECT HOUR(createddate) AS hr, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND DATE(createddate) = CURRENT_DATE() ${ow}
               GROUP BY hr ORDER BY hr`),
        query(`SELECT DATE_FORMAT(createddate, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true
               AND DATE(createddate) >= DATE_SUB(CURRENT_DATE(), 14) ${ow}
               GROUP BY day ORDER BY day`),
        query(`SELECT type AS Type, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND DATE(createddate) = CURRENT_DATE() ${ow}
               GROUP BY type ORDER BY cnt DESC`),
        query(`SELECT DATE_FORMAT(createddate, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
               FROM ${CASE}
               WHERE is_current = true AND origin = 'Email'
               AND DATE(createddate) >= DATE_SUB(CURRENT_DATE(), 14) ${ow}
               GROUP BY day ORDER BY day`),
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND isclosed = 'false' ${ow}`),
      ]);

    res.json({
      originToday:   { records: originToday },
      hourlyToday:   { records: hourlyToday },
      daily14d:      { records: daily14d },
      typeBreakdown: { records: typeBreakdown },
      emailDaily14d: { records: emailDaily14d },
      totalOpen:     Number(totalOpen[0]?.cnt ?? 0),
    });
  } catch (err) {
    console.error('❌ [volume-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/sla-data ──────────────────────────────────────────────────────────
app.get("/api/sla-data", async (req, res) => {
  const p = req.query;
  const cd = createdSince(p, 'c');
  const ow = ownerWhere(p);

  try {
    const rows = await query(`
      SELECT c.id AS Id, c.casenumber AS CaseNumber, c.subject AS Subject,
             c.description AS Description,
             c.status AS Status, c.isclosed AS IsClosed,
             c.ownerid AS OwnerId, u.name AS owner_name,
             c.createddate AS CreatedDate, c.lastmodifieddate AS LastModifiedDate,
             CAST(c.case_response_time_hours__c AS DOUBLE) AS Case_Response_Time_Hours__c
      FROM ${CASE} c
      JOIN ${USER} u ON c.ownerid = u.id AND u.is_current = true
      WHERE c.is_current = true AND ${cd} ${ow}
      ORDER BY c.createddate DESC
      LIMIT 2000
    `);

    res.json({
      records: rows.map(r => ({
        ...r,
        Owner: { Name: r.owner_name },
        IsClosed: r.IsClosed === 'true',
      })),
    });
  } catch (err) {
    console.error('❌ [sla-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/resolution-data ───────────────────────────────────────────────────
app.get("/api/resolution-data", async (req, res) => {
  const p = req.query;
  const cl = closedSince(p, 'c');
  const cd = createdSince(p, 'c');
  const ow = ownerWhere(p);

  try {
    const [closedCases, createdByRep, dailyCreated, dailyClosed] = await Promise.all([
      query(`SELECT c.id AS Id, c.casenumber AS CaseNumber,
                    c.ownerid AS OwnerId, u.name AS owner_name,
                    c.createddate AS CreatedDate, c.closeddate AS ClosedDate,
                    c.isescalated AS IsEscalated,
                    CAST(c.reopens__c AS INT) AS Reopens__c
             FROM ${CASE} c
             JOIN ${USER} u ON c.ownerid = u.id AND u.is_current = true
             WHERE c.is_current = true AND c.isclosed = 'true' AND ${cl} ${ow}
             ORDER BY c.closeddate DESC LIMIT 2000`),
      query(`SELECT c.ownerid AS OwnerId, u.name AS owner_name, COUNT(*) AS cnt
             FROM ${CASE} c
             JOIN ${USER} u ON c.ownerid = u.id AND u.is_current = true
             WHERE c.is_current = true AND ${cd} ${ow}
             GROUP BY c.ownerid, u.name`),
      query(`SELECT DATE_FORMAT(createddate, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
             FROM ${CASE}
             WHERE is_current = true AND DATE(createddate) >= DATE_SUB(CURRENT_DATE(), 14) ${ow}
             GROUP BY day ORDER BY day`),
      query(`SELECT DATE_FORMAT(closeddate, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
             FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true'
             AND DATE(closeddate) >= DATE_SUB(CURRENT_DATE(), 14) ${ow}
             GROUP BY day ORDER BY day`),
    ]);

    res.json({
      closedCases: {
        records: closedCases.map(r => ({
          ...r,
          Owner: { Name: r.owner_name },
          IsEscalated: r.IsEscalated === 'true',
        }))
      },
      createdByRep: { records: createdByRep.map(r => ({ ...r, Owner: { Name: r.owner_name } })) },
      dailyCreated: { records: dailyCreated },
      dailyClosed:  { records: dailyClosed },
    });
  } catch (err) {
    console.error('❌ [resolution-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/manager-data ──────────────────────────────────────────────────────
app.get("/api/manager-data", async (req, res) => {
  const p = req.query;
  const ow = ownerWhere(p);
  const cl = closedSince(p);

  try {
    const [openByStatus, closedWeek, avgResponse, csatData, userInfo] = await Promise.all([
      query(`SELECT c.ownerid AS OwnerId, u.name AS Name, c.status AS Status, COUNT(*) AS cnt
             FROM ${CASE} c
             JOIN ${USER} u ON c.ownerid = u.id AND u.is_current = true
             WHERE c.is_current = true AND c.isclosed = 'false' ${ow}
             GROUP BY c.ownerid, u.name, c.status`),
      query(`SELECT ownerid AS OwnerId, COUNT(*) AS cnt FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true' AND ${cl} ${ow}
             GROUP BY ownerid`),
      query(`SELECT ownerid AS OwnerId,
                    AVG(CAST(case_response_time_hours__c AS DOUBLE)) AS avgRespHrs
             FROM ${CASE}
             WHERE is_current = true AND isclosed = 'true'
             AND ${cl} AND case_response_time_hours__c IS NOT NULL ${ow}
             GROUP BY ownerid`),
      query(`SELECT ownerid AS OwnerId,
                    AVG(CAST(satisfaction_score__c AS DOUBLE)) AS Satisfaction_Score__c
             FROM ${CASE}
             WHERE is_current = true AND satisfaction_score__c IS NOT NULL ${ow}
             GROUP BY ownerid`),
      query(`SELECT u.id AS Id, u.name AS Name,
                    u.team__c AS role_name, u.department AS Department
             FROM ${USER} u
             WHERE u.is_current = true AND u.isactive = 'true' AND u.usertype = 'Standard'`),
    ]);

    res.json({
      openByStatus: { records: openByStatus },
      closedWeek:   { records: closedWeek },
      avgResponse:  { records: avgResponse },
      csatData:     { records: csatData },
      userInfo:     { records: userInfoShape(userInfo) },
    });
  } catch (err) {
    console.error('❌ [manager-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/channels-data ─────────────────────────────────────────────────────
app.get("/api/channels-data", async (req, res) => {
  const { period = 'week', startDate, endDate } = req.query;
  const since = (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    ? `DATE(start_time) BETWEEN '${startDate}' AND '${endDate}'`
    : `DATE(start_time) >= ${tdPeriod(period)}`;

  try {
    const [summary, volumeByDay, endedBy, byAgent] = await Promise.all([
      query(`SELECT COUNT(*) AS cnt,
                    AVG(waiting_time) AS avgWait, AVG(talk_time) AS avgDur
             FROM ${TD} WHERE ${since}`),
      query(`SELECT DATE_FORMAT(start_time, 'yyyy-MM-dd') AS day, COUNT(*) AS cnt
             FROM ${TD}
             WHERE DATE(start_time) >= DATE_SUB(CURRENT_DATE(), 14)
             GROUP BY day ORDER BY day`),
      query(`SELECT hangup AS EndedBy, COUNT(*) AS cnt
             FROM ${TD} WHERE ${since} GROUP BY hangup`),
      query(`SELECT t.agent_name AS owner_name, COUNT(*) AS cnt,
                    AVG(t.waiting_time) AS avgWait
             FROM ${TD} t WHERE ${since}
             GROUP BY t.agent_name ORDER BY cnt DESC`),
    ]);

    res.json({
      summary:     { records: summary },
      volumeByDay: { records: volumeByDay },
      endedBy:     { records: endedBy },
      byAgent:     { records: byAgent.map(r => ({ OwnerId: null, Owner: { Name: r.owner_name }, cnt: r.cnt, avgWait: r.avgWait })) },
    });
  } catch (err) {
    console.error('❌ [channels-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/rep-list ──────────────────────────────────────────────────────────
app.get("/api/rep-list", async (_req, res) => {
  try {
    const rows = await query(`
      SELECT u.id AS Id, u.name AS Name
      FROM ${USER} u
      WHERE u.is_current = true AND u.isactive = 'true' AND u.usertype = 'Standard'
      ORDER BY u.name
    `);
    res.json({ records: rows.map(r => ({ Id: r.Id, Name: r.Name })) });
  } catch (err) {
    console.error('❌ [rep-list]', err.message);
    res.json({ records: [] });
  }
});

// ── GET /api/instascore ────────────────────────────────────────────────────────
app.get('/api/instascore', async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });

  const periodClause = (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    ? `DATE(asr.CREATED) BETWEEN '${startDate}' AND '${endDate}'`
    : `DATE(asr.CREATED) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;

  const baseJoin = `
    FROM (
      SELECT * FROM ${LAI_SCORE}
      WHERE RUBRIC_TITLE = 'Unstoppable Call Experience (IS)'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1
    ) ins
    JOIN ${LAI_ASR}  asr ON asr.ID   = ins.ASR_LOG_ID
    JOIN ${LAI_USER} u   ON u.ID     = asr.USER_ID
    JOIN ${USER}     sf  ON LOWER(sf.email) = LOWER(u.EMAIL)
    WHERE sf.id = '${ownerId}'
      AND sf.is_current = true
      AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
      AND ${periodClause}
  `;

  try {
    const [categoryRows, sectionRows, questionRows, rubricRows, conversationRows] = await Promise.all([
      query(`
        SELECT
          ins.CATEGORY_ID                                      AS category_id,
          ins.CATEGORY                                         AS category,
          AVG(CAST(ins.CATEGORY_SCORE_PCNT AS DOUBLE))        AS avg_pct,
          COUNT(DISTINCT ins.ASR_LOG_ID)                       AS conversation_count
        ${baseJoin}
        GROUP BY ins.CATEGORY_ID, ins.CATEGORY
        ORDER BY ins.CATEGORY
      `),
      query(`
        SELECT
          ins.SECTION_ID                                       AS section_id,
          ins.SECTION                                          AS section,
          ins.CATEGORY_ID                                      AS category_id,
          ins.CATEGORY                                         AS category,
          AVG(CAST(ins.SECTION_SCORE_PCNT AS DOUBLE))         AS avg_pct,
          COUNT(DISTINCT ins.ASR_LOG_ID)                       AS conversation_count
        ${baseJoin}
        GROUP BY ins.SECTION_ID, ins.SECTION, ins.CATEGORY_ID, ins.CATEGORY
        ORDER BY ins.SECTION
      `),
      query(`
        SELECT
          ins.QUESTION_ID                                      AS question_id,
          ins.QUESTION                                         AS question,
          ins.RUBRIC_ID                                        AS rubric_id,
          ins.RUBRIC_TITLE                                     AS rubric_title,
          AVG(CAST(ins.QUESTION_SCORE_PCNT AS DOUBLE))        AS avg_pct,
          COUNT(DISTINCT ins.ASR_LOG_ID)                       AS conversation_count
        ${baseJoin}
        GROUP BY ins.QUESTION_ID, ins.QUESTION, ins.RUBRIC_ID, ins.RUBRIC_TITLE
        ORDER BY ins.RUBRIC_TITLE, ins.QUESTION
      `),
      query(`
        SELECT
          ins.RUBRIC_ID                                        AS rubric_id,
          ins.RUBRIC_TITLE                                     AS rubric_title,
          AVG(CAST(ins.QUESTION_SCORE_PCNT AS DOUBLE))        AS avg_pct,
          COUNT(DISTINCT ins.ASR_LOG_ID)                       AS conversation_count
        ${baseJoin}
        GROUP BY ins.RUBRIC_ID, ins.RUBRIC_TITLE
        ORDER BY ins.RUBRIC_TITLE
      `),
      // Pre-aggregate per (ASR_LOG_ID, CATEGORY) before any JOINs to prevent row multiplication.
      // N/A questions (NULL score) are excluded so they don't reduce the max denominator.
      // Multi-point question maxes are embedded in the CASE so each conversation's max is accurate.
      query(`
        SELECT
          cat.asr_log_id,
          DATE_FORMAT(asr.CREATED, 'yyyy-MM-dd')              AS conversation_date,
          cat.category,
          cat.category_score                                   AS category_avg_pct,
          cat.question_count,
          MAX(qm.ID)                                           AS qa_metrics_id
        FROM (
          SELECT
            ins.ASR_LOG_ID                                     AS asr_log_id,
            ins.CATEGORY                                       AS category,
            SUM(CASE
                  WHEN LOWER(ins.QUESTION) LIKE '%make the sell%'
                    OR LOWER(ins.QUESTION) LIKE '%accurate product terms%'
                  THEN COALESCE(CAST(ins.QUESTION_SCORE_PCNT AS DOUBLE), 0) * 2
                  ELSE COALESCE(CAST(ins.QUESTION_SCORE_PCNT AS DOUBLE), 0)
                END) * 100.0
              / SUM(CASE
                  WHEN LOWER(ins.QUESTION) LIKE '%make the sell%'          THEN 200.0
                  WHEN LOWER(ins.QUESTION) LIKE '%accurate product terms%' THEN 200.0
                  ELSE 100.0
                END)                                          AS category_score,
            COUNT(ins.QUESTION)                                AS question_count
          FROM (
            SELECT * FROM ${LAI_SCORE}
            WHERE RUBRIC_TITLE = 'Unstoppable Call Experience (IS)'
            QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1
          ) ins
          WHERE ins.QUESTION_SCORE_PCNT IS NOT NULL
            OR (ins.SELECTED_OPTION IS NOT NULL AND LOWER(TRIM(ins.SELECTED_OPTION)) != 'n/a')
          GROUP BY ins.ASR_LOG_ID, ins.CATEGORY
        ) cat
        JOIN (
          SELECT * FROM ${LAI_ASR}
          QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY CREATED DESC) = 1
        ) asr ON asr.ID = cat.asr_log_id
        JOIN ${LAI_USER} u   ON u.ID     = asr.USER_ID
        JOIN ${USER}     sf  ON LOWER(sf.email) = LOWER(u.EMAIL)
        LEFT JOIN ${LAI_QA} qm ON qm.ASR_LOG_ID = cat.asr_log_id
        WHERE sf.id = '${ownerId}'
          AND sf.is_current = true
          AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
          AND ${periodClause}
        GROUP BY cat.asr_log_id, asr.CREATED, cat.category, cat.category_score, cat.question_count
        ORDER BY asr.CREATED DESC, cat.category
      `),
    ]);

    // Group per-category rows by conversation, compute weighted instascore per convo
    const convMap = new Map();
    for (const r of conversationRows) {
      if (!convMap.has(r.asr_log_id)) {
        convMap.set(r.asr_log_id, {
          asr_log_id:        r.asr_log_id,
          conversation_date: r.conversation_date,
          qa_metrics_id:     r.qa_metrics_id != null ? Number(r.qa_metrics_id) : null,
          categories:        [],
          question_count:    0,
        });
      }
      const c = convMap.get(r.asr_log_id);
      c.question_count += Number(r.question_count);
      // category_avg_pct is pre-computed in SQL as sum(score)/sum(max) per scored question
      c.categories.push({ category: r.category, score: r.category_avg_pct != null ? Number(r.category_avg_pct) : null });
    }
    const conversations = Array.from(convMap.values())
      .map(c => ({ ...c, instascore: weightedInstascore(c.categories) }))
      .sort((a, b) => b.conversation_date.localeCompare(a.conversation_date));

    const validScores = conversations.map(c => c.instascore).filter(v => v != null);
    const overall = validScores.length > 0
      ? Math.round(validScores.reduce((s, v) => s + v, 0) / validScores.length)
      : null;
    const conversationCount = conversations.length;

    res.json({
      overall,
      conversationCount,
      byCategory:        categoryRows.map(r => ({
        category_id:        r.category_id,
        category:           r.category,
        avg_pct:            Number(Number(r.avg_pct).toFixed(1)),
        conversation_count: Number(r.conversation_count),
      })),
      bySection:         sectionRows.map(r => ({
        section_id:         r.section_id,
        section:            r.section,
        category_id:        r.category_id,
        category:           r.category,
        avg_pct:            Number(Number(r.avg_pct).toFixed(1)),
        conversation_count: Number(r.conversation_count),
      })),
      byQuestion:        questionRows.map(r => ({
        question_id:        r.question_id,
        question:           r.question,
        rubric_id:          r.rubric_id,
        rubric_title:       r.rubric_title,
        avg_pct:            Number(Number(r.avg_pct).toFixed(1)),
        conversation_count: Number(r.conversation_count),
      })),
      byRubric:          rubricRows.map(r => ({
        rubric_id:          r.rubric_id,
        rubric_title:       r.rubric_title,
        avg_pct:            Number(Number(r.avg_pct).toFixed(1)),
        conversation_count: Number(r.conversation_count),
      })),
      conversations:     conversations.map(c => ({
        asr_log_id:        c.asr_log_id,
        conversation_date: c.conversation_date,
        instascore:        c.instascore,
        question_count:    c.question_count,
        qa_metrics_id:     c.qa_metrics_id,
      })),
    });
  } catch (err) {
    console.error('❌ [instascore]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Archive cases (file-based) ─────────────────────────────────────────────────
const ARCHIVE_FILE = path.resolve(__dirname, 'archived_cases.json');

function readArchive() {
  try {
    return fs.existsSync(ARCHIVE_FILE) ? JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')) : {};
  } catch { return {}; }
}

function writeArchive(data) {
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/archived-cases/:repId', (req, res) => {
  const { repId } = req.params;
  if (!SFID_RE.test(repId)) return res.status(400).json({ error: 'valid repId required' });
  const archive = readArchive();
  res.json({ ids: archive[repId] ?? [] });
});

app.post('/api/archive-case', (req, res) => {
  const { caseId, repId } = req.body ?? {};
  if (!SFID_RE.test(caseId) || !SFID_RE.test(repId))
    return res.status(400).json({ error: 'valid caseId and repId required' });
  const archive = readArchive();
  archive[repId] = [...new Set([...(archive[repId] ?? []), caseId])];
  writeArchive(archive);
  res.json({ ok: true });
});

app.delete('/api/archive-case/:caseId', (req, res) => {
  const { caseId } = req.params;
  if (!SFID_RE.test(caseId)) return res.status(400).json({ error: 'valid caseId required' });
  const archive = readArchive();
  for (const repId of Object.keys(archive)) {
    archive[repId] = archive[repId].filter(id => id !== caseId);
  }
  writeArchive(archive);
  res.json({ ok: true });
});

// ── Goals persistence ──────────────────────────────────────────────────────────
const GOALS_FILE = path.resolve(__dirname, "goals.json");

const DEFAULT_GOALS = {
  closedDay: 15, responseHrs: 4, emailsDay: 20, maxOnHold: 30, maxOpen: 100,
  transferRate: 10, availPct: 55, prodPct: 70, contactsHr: 6,
  slaBreach: 24, instascore: 75, fcrPct: 80, totalPending: 500, avgHoldSec: 120,
};

app.get("/api/goals", (_req, res) => {
  try {
    const data = fs.existsSync(GOALS_FILE)
      ? JSON.parse(fs.readFileSync(GOALS_FILE, "utf8"))
      : DEFAULT_GOALS;
    res.json(data);
  } catch (err) {
    console.error("❌ [Goals] Read error:", err.message);
    res.json(DEFAULT_GOALS);
  }
});

app.post("/api/goals", (req, res) => {
  const validated = {};
  for (const key of Object.keys(DEFAULT_GOALS)) {
    const val = req.body[key];
    if (typeof val === 'number' && isFinite(val)) validated[key] = val;
  }
  if (Object.keys(validated).length === 0) {
    return res.status(400).json({ error: 'Invalid goals payload' });
  }
  try {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(validated, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ [Goals] Write error:", err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /debug/headers — dev only ─────────────────────────────────────────────
if (isDev) {
  app.get("/debug/headers", (req, res) => {
    const relevant = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) =>
        k.includes('auth') || k.includes('token') || k.includes('databricks') || k.includes('forward')
      )
    );
    res.json({ relevant, all: Object.keys(req.headers) });
  });
}

// ── GET /api/diagnostics ───────────────────────────────────────────────────────
app.get('/api/diagnostics', (_req, res) => {
  res.json(getDiagnostics());
});

// ── GET /api/diagnostics/levelai ──────────────────────────────────────────────
app.get('/api/diagnostics/levelai', async (_req, res) => {
  async function check(label, fn) {
    try {
      const result = await fn();
      return { label, ok: true, value: result };
    } catch (err) {
      return { label, ok: false, error: err.message };
    }
  }

  const checks = await Promise.all([
    check('homebase_instascore accessible', async () => {
      const r = await query(`SELECT COUNT(*) AS cnt FROM ${LAI_SCORE}`);
      return `${Number(r[0]?.cnt ?? 0).toLocaleString()} rows`;
    }),
    check('homebase_level_asr_asrlog accessible', async () => {
      const r = await query(`SELECT COUNT(*) AS cnt FROM ${LAI_ASR}`);
      return `${Number(r[0]?.cnt ?? 0).toLocaleString()} rows`;
    }),
    check('homebase_accounts_user accessible', async () => {
      const r = await query(`SELECT COUNT(*) AS cnt FROM ${LAI_USER}`);
      return `${Number(r[0]?.cnt ?? 0).toLocaleString()} rows`;
    }),
    check('CREATED field sample (date format check)', async () => {
      const r = await query(`SELECT CREATED FROM ${LAI_ASR} WHERE CREATED IS NOT NULL LIMIT 3`);
      return r.map(row => row.CREATED).join(' | ') || 'no rows';
    }),
    check('Email join — LevelAI ↔ Salesforce users matched', async () => {
      const r = await query(`
        SELECT COUNT(DISTINCT u.ID) AS cnt
        FROM ${LAI_USER} u
        JOIN ${USER} sf ON LOWER(sf.email) = LOWER(u.EMAIL)
        WHERE sf.is_current = true AND u.IS_ACTIVE = 'true'
      `);
      return `${Number(r[0]?.cnt ?? 0)} agents matched`;
    }),
    check('Conversations in last 30 days', async () => {
      const r = await query(`
        SELECT COUNT(*) AS cnt FROM ${LAI_ASR}
        WHERE DATE(CREATED) >= DATE_SUB(CURRENT_DATE(), 30)
          AND (DELETED IS NULL OR DELETED = 'false')
      `);
      return `${Number(r[0]?.cnt ?? 0).toLocaleString()} conversations`;
    }),
    check('Instascore records in last 30 days (full join)', async () => {
      const r = await query(`
        SELECT COUNT(DISTINCT ins.ASR_LOG_ID) AS cnt
        FROM ${LAI_SCORE} ins
        JOIN ${LAI_ASR} asr ON asr.ID = ins.ASR_LOG_ID
        WHERE DATE(asr.CREATED) >= DATE_SUB(CURRENT_DATE(), 30)
          AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
      `);
      return `${Number(r[0]?.cnt ?? 0).toLocaleString()} scored conversations`;
    }),
    check('Sample matched rep (end-to-end join)', async () => {
      const r = await query(`
        SELECT sf.name AS rep_name, COUNT(DISTINCT ins.ASR_LOG_ID) AS scored_convos
        FROM ${LAI_SCORE} ins
        JOIN ${LAI_ASR} asr ON asr.ID = ins.ASR_LOG_ID
        JOIN ${LAI_USER} u  ON u.ID   = asr.USER_ID
        JOIN ${USER} sf     ON LOWER(sf.email) = LOWER(u.EMAIL)
        WHERE sf.is_current = true
          AND DATE(asr.CREATED) >= DATE_SUB(CURRENT_DATE(), 30)
          AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
        GROUP BY sf.name
        ORDER BY scored_convos DESC
        LIMIT 5
      `);
      if (!r.length) return 'No matched reps found';
      return r.map(row => `${row.rep_name}: ${row.scored_convos} convos`).join(' | ');
    }),
  ]);

  res.json({ checks });
});

// ── GET /api/instascore/conversation/:asr_log_id ──────────────────────────────
app.get('/api/instascore/conversation/:asr_log_id', async (req, res) => {
  const { asr_log_id } = req.params;
  // Allow numeric or alphanumeric IDs
  if (!asr_log_id || !/^[a-zA-Z0-9_-]{1,64}$/.test(asr_log_id))
    return res.status(400).json({ error: 'valid asr_log_id required' });

  try {
    // If the input ID matches a homebase_qa_metrics.id, resolve to the ASR log ID
    const qaLookup = await query(`
      SELECT ASR_LOG_ID FROM ${LAI_QA}
      WHERE CAST(ID AS STRING) = CAST('${asr_log_id}' AS STRING)
      LIMIT 1
    `);
    const resolved_id = qaLookup[0]?.ASR_LOG_ID ?? asr_log_id;

    // Deduplicated source filtered to target rubric — one row per unique question text
    const insFiltered = `(SELECT * FROM ${LAI_SCORE} WHERE CAST(ASR_LOG_ID AS STRING) = CAST('${resolved_id}' AS STRING) AND RUBRIC_TITLE = 'Unstoppable Call Experience (IS)' QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1)`;
    // Deduplicated source across all rubrics — for the rubric breakdown panel
    const insAll = `(SELECT * FROM ${LAI_SCORE} WHERE CAST(ASR_LOG_ID AS STRING) = CAST('${resolved_id}' AS STRING) QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, RUBRIC_TITLE, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1)`;

    const [rows, allRows, asrMeta] = await Promise.all([
      query(`
        SELECT
          ins.RUBRIC_ID             AS rubric_id,
          ins.RUBRIC_TITLE          AS rubric_title,
          ins.CATEGORY_ID           AS category_id,
          ins.CATEGORY              AS category,
          ins.SECTION_ID            AS section_id,
          ins.SECTION               AS section,
          ins.QUESTION_ID           AS question_id,
          ins.QUESTION              AS question,
          ins.QUESTION_SCORE        AS question_score,
          ins.QUESTION_SCORE_PCNT   AS question_score_pcnt,
          ins.CATEGORY_SCORE_PCNT   AS category_score_pcnt,
          ins.SECTION_SCORE_PCNT    AS section_score_pcnt,
          ins.SELECTED_OPTION       AS selected_option
        FROM ${insFiltered} ins
        ORDER BY ins.CATEGORY, ins.SECTION, ins.QUESTION
      `),
      query(`
        SELECT ins.RUBRIC_TITLE AS rubric_title, COUNT(*) AS cnt
        FROM ${insAll} ins
        GROUP BY ins.RUBRIC_TITLE
      `),
      // ASR log metadata — CUSTOM_FIELDS holds call reason and other metadata
      query(`
        SELECT CUSTOM_FIELDS, SUMMARY, CHANNEL, CONVERSATION_STATUS
        FROM ${LAI_ASR}
        WHERE CAST(ID AS STRING) = CAST('${resolved_id}' AS STRING)
        LIMIT 1
      `),
    ]);

    // Parse CUSTOM_FIELDS JSON
    let customFields = null;
    const rawMeta = asrMeta[0];
    if (rawMeta?.CUSTOM_FIELDS) {
      try { customFields = JSON.parse(rawMeta.CUSTOM_FIELDS); } catch { customFields = rawMeta.CUSTOM_FIELDS; }
    }
    const callMeta = rawMeta ? {
      custom_fields:       customFields,
      summary:             rawMeta.SUMMARY ?? null,
      channel:             rawMeta.CHANNEL ?? null,
      conversation_status: rawMeta.CONVERSATION_STATUS ?? null,
    } : null;

    if (!rows.length) {
      return res.json({
        asr_log_id: resolved_id,
        rows: [],
        summary: null,
        call_meta: callMeta,
        all_rubrics: allRows.map(r => ({ rubric_title: r.rubric_title, question_count: Number(r.cnt) })),
        debug: allRows.length === 0
          ? 'No rows found for this ID at all — ID may not exist in homebase_instascore'
          : `ID exists but has no rows for "Unstoppable Call Experience (IS)". Rubrics found: ${allRows.map(r => r.rubric_title).join(', ')}`,
      });
    }

    // Compute weighted instascore: per-category avg → weighted by INSTASCORE_CATEGORY_WEIGHTS
    const catGroups = {};
    for (const r of rows) {
      if (!catGroups[r.category]) catGroups[r.category] = [];
      const v = r.question_score_pcnt != null ? Number(r.question_score_pcnt) : NaN;
      catGroups[r.category].push({
        question:        r.question,
        score:           isNaN(v) ? null : v,
        selected_option: r.selected_option ?? null,
      });
    }
    const isNA = item =>
      item.selected_option == null || item.selected_option.trim().toLowerCase() === 'n/a';
    const categoryScores = Object.entries(catGroups).map(([category, items]) => {
      // "answered" = question was given a real response (not N/A), even if score is 0
      const answered    = items.filter(i => !isNA(i));
      const correct     = answered.filter(i => (i.score ?? 0) > 0).length;
      const sumScore    = answered.reduce((s, i) => s + adjustedScore(i), 0);
      const maxSumScore = answered.reduce((s, i) => s + questionMaxPcnt(i.question), 0);
      const hasMultiPt  = answered.some(i => questionMaxPcnt(i.question) > 100);
      const avgScore    = maxSumScore > 0 ? (sumScore / maxSumScore) * 100 : null;
      return {
        category,
        score:          avgScore,
        question_count: answered.length,
        correct_count:  correct,
        questions:      items,
        sum_score:      hasMultiPt ? sumScore    : null,
        max_score:      hasMultiPt ? maxSumScore : null,
      };
    });
    const instascore = weightedInstascore(categoryScores);

    const presentCats    = categoryScores.filter(c => INSTASCORE_CATEGORY_WEIGHTS[c.category] != null && c.score != null);
    const presentWeight  = presentCats.reduce((s, c) => s + INSTASCORE_CATEGORY_WEIGHTS[c.category], 0);
    const missingCats    = Object.keys(INSTASCORE_CATEGORY_WEIGHTS).filter(cat => !catGroups[cat]);
    const distributed    = presentCats.length > 0 ? (100 - presentWeight) / presentCats.length : 0;
    // Attach adjusted (redistributed) weights to each present category
    const categoryScoresWithWeights = categoryScores.map(c => ({
      ...c,
      original_weight: INSTASCORE_CATEGORY_WEIGHTS[c.category] ?? null,
      adjusted_weight: (c.score != null && INSTASCORE_CATEGORY_WEIGHTS[c.category] != null)
        ? Number((INSTASCORE_CATEGORY_WEIGHTS[c.category] + distributed).toFixed(2))
        : null,
    }));
    const formulaStr = presentCats.map(c => {
      const adj = Number((INSTASCORE_CATEGORY_WEIGHTS[c.category] + distributed).toFixed(1));
      return `${c.category} (${adj}%) = ${c.score.toFixed(1)}`;
    }).join(' | ')
      + (missingCats.length ? ` | Missing (redistributed): ${missingCats.join(', ')}` : '')
      + ` → ${instascore}%`;

    res.json({
      asr_log_id: resolved_id,
      call_meta: callMeta,
      summary: {
        instascore,
        total_questions:  rows.length,
        formula:          formulaStr,
        rubric_filter:    'Unstoppable Call Experience (IS)',
        category_scores:  categoryScoresWithWeights,
      },
      all_rubrics: allRows.map(r => ({ rubric_title: r.rubric_title, question_count: Number(r.cnt) })),
      rows: rows.map(r => ({
        rubric_title:       r.rubric_title,
        category:           r.category,
        section:            r.section,
        question:           r.question,
        question_score:     r.question_score,
        question_score_pcnt: Number(r.question_score_pcnt),
        category_score_pcnt: Number(r.category_score_pcnt),
        section_score_pcnt:  Number(r.section_score_pcnt),
        selected_option:    r.selected_option,
      })),
    });
  } catch (err) {
    console.error('❌ [instascore/conversation]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reconnect ────────────────────────────────────────────────────────
app.post('/api/reconnect', async (_req, res) => {
  try {
    await resetConnection();
    res.json({ ok: true, diagnostics: getDiagnostics() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, diagnostics: getDiagnostics() });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Catch-all: serve index.html for client-side routing (production only) ──────
if (!isDev) {
  app.get("*", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../dist/index.html"));
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Rep Dashboard server running on http://localhost:${PORT}`);
});
