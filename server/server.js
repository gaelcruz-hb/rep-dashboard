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

// ── SQL helpers ────────────────────────────────────────────────────────────────
const DATE_TRUNC = {
  today:     `CURRENT_DATE()`,
  yesterday: `DATE_ADD(CURRENT_DATE(), -1)`,
  week:      `DATE_TRUNC('WEEK', CURRENT_DATE())`,
  last_week: `DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)`,
  month:     `DATE_TRUNC('MONTH', CURRENT_DATE())`,
  last_month:`DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))`,
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
