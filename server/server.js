import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

import express from "express";
import cors from "cors";
import { query, getDiagnostics, resetConnection, getDbToken } from "./databricksClient.js";
import { cacheRoute } from "./queryCache.js";

// Short-TTL response cache for read-heavy, pollable endpoints. Collapses identical concurrent
// requests (many users polling the same data) into one Databricks computation per window.
const CACHE_TTL_MS = Number(process.env.API_CACHE_TTL_MS) || 60_000;

const app = express();
const PORT = process.env.DATABRICKS_APP_PORT || process.env.PORT || 3001;
const isDev = !process.env.DATABRICKS_APP_PORT;
if (isDev) {
  app.use(cors({ origin: ["http://localhost:5173", "http://localhost:5174"] }));
}
app.use(express.json({ limit: "100kb" }));

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
const UPGRADES   = 'prod_redshift_replica.bizops.cs_marked_upgrades_with_trials';
const LOCATIONS  = 'prod_redshift_replica.bizops_staging.locations';
const COMPANIES  = 'prod_redshift_replica.bizops_staging.companies';
const TDCALLS        = 'stage_raw.talkdesk.calls';
const TD_STATUS      = 'Prod_redshift_replica.talkdesk.dim_user_status';
const CS_TICKETS     = 'prod_redshift_replica.bizops.cs_tickets_aggregated';
const SRC_MESSAGING  = 'ext_crm.src_messaging_session';
const CRM_TASK       = 'prod_enriched.crm.s_crm_task';
const SRC_TASK       = 'stage_raw.ext_crm.src_task';  // legacy task table — covers months the enriched table is missing
const CONTACT        = 'Prod_redshift_replica.bizops_staging.crm_contact';

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

function mrrDateFilter(period, startDate, endDate) {
  // marked_month is always the 1st of the month, so use marked_at (the actual
  // timestamp) for week/day-level periods and marked_month for month-level ones.
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(upg.marked_at) BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':
      return `DATE(upg.marked_at) = CURRENT_DATE()`;
    case 'yesterday':
      return `DATE(upg.marked_at) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'week':
      return `DATE(upg.marked_at) >= DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_week':
      return `DATE(upg.marked_at) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND DATE(upg.marked_at) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(upg.marked_month) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND DATE(upg.marked_month) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `DATE(upg.marked_at) >= DATE_SUB(CURRENT_DATE(), 30) AND DATE(upg.marked_at) < CURRENT_DATE()`;
    case 'quarter':
      return `DATE(upg.marked_month) >= DATE_TRUNC('QUARTER', CURRENT_DATE())`;
    case 'year':
      return `DATE(upg.marked_month) >= DATE_TRUNC('YEAR', CURRENT_DATE())`;
    default: // 'month' and anything else → current month via marked_month
      return `DATE(upg.marked_month) >= DATE_TRUNC('MONTH', CURRENT_DATE())`;
  }
}

function callsDateFilter(period, startDate, endDate) {
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(t.start_time) BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':     return `DATE(t.start_time) = CURRENT_DATE()`;
    case 'yesterday': return `DATE(t.start_time) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'last_week':
      return `DATE(t.start_time) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND DATE(t.start_time) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(t.start_time) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND DATE(t.start_time) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `DATE(t.start_time) >= DATE_SUB(CURRENT_DATE(), 30) AND DATE(t.start_time) < CURRENT_DATE()`;
    default:
      return `DATE(t.start_time) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
  }
}

function statusDateFilter(period, startDate, endDate) {
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(dsu.status_start_at) BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':     return `DATE(dsu.status_start_at) = CURRENT_DATE()`;
    case 'yesterday': return `DATE(dsu.status_start_at) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'last_week':
      return `DATE(dsu.status_start_at) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND DATE(dsu.status_start_at) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(dsu.status_start_at) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND DATE(dsu.status_start_at) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `DATE(dsu.status_start_at) >= DATE_SUB(CURRENT_DATE(), 30) AND DATE(dsu.status_start_at) < CURRENT_DATE()`;
    default:
      return `DATE(dsu.status_start_at) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
  }
}

// Same windows as statusDateFilter, but the day is resolved in US Central so it
// matches the Central-time grouping used by the status-instances view.
function statusLocalDateFilter(period, startDate, endDate) {
  const day = `DATE(from_utc_timestamp(dsu.status_start_at, 'America/Chicago'))`;
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `${day} BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':     return `${day} = CURRENT_DATE()`;
    case 'yesterday': return `${day} = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'last_week':
      return `${day} >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND ${day} < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `${day} >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND ${day} < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `${day} >= DATE_SUB(CURRENT_DATE(), 30) AND ${day} < CURRENT_DATE()`;
    default:
      return `${day} >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
  }
}

function sessionDateFilter(period, startDate, endDate) {
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(m.createddate) BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':     return `DATE(m.createddate) = CURRENT_DATE()`;
    case 'yesterday': return `DATE(m.createddate) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'last_week':
      return `DATE(m.createddate) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND DATE(m.createddate) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(m.createddate) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND DATE(m.createddate) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `DATE(m.createddate) >= DATE_SUB(CURRENT_DATE(), 30) AND DATE(m.createddate) < CURRENT_DATE()`;
    default:
      return `DATE(m.createddate) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
  }
}

function priorSessionClause(period) {
  const c = priorCallsClause(period);
  return c ? c.replace(/DATE\(t\.start_time\)/g, 'DATE(m.createddate)') : null;
}

function taskCompletedDateFilter(period, startDate, endDate, col = 't.CompletedDateTime') {
  if (startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate))
    return `DATE(${col}) BETWEEN '${startDate}' AND '${endDate}'`;
  switch (period) {
    case 'today':     return `DATE(${col}) = CURRENT_DATE()`;
    case 'yesterday': return `DATE(${col}) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'last_week':
      return `DATE(${col}) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7) AND DATE(${col}) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(${col}) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1)) AND DATE(${col}) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_30':
      return `DATE(${col}) >= DATE_SUB(CURRENT_DATE(), 30) AND DATE(${col}) < CURRENT_DATE()`;
    default:
      return `DATE(${col}) >= ${DATE_TRUNC[period] || DATE_TRUNC.week}`;
  }
}

// Unified completed-tasks / emails fetch. Merges the enriched table (CRM_TASK, full data from
// ~May 2026 on) with the legacy table (SRC_TASK, which covers earlier months the enriched table
// is missing), de-duplicating by Salesforce task Id and preferring the richer enriched row — so
// overlapping months aren't double-counted. Falls back to a single table if the other is
// unreadable (e.g. prod service-principal lacks SELECT), reporting which source was used.
// Returns { count: [{cnt}], rows: [...], source: 'merged'|'enriched'|'legacy'|'none', error }.
// `dateFilterE`/`dateFilterL` let callers (e.g. the prior period, which uses a relative clause
// rather than start/end dates) supply the per-table date WHERE clause directly. `countOnly` skips
// the row fetch when only the de-duped total is needed.
// Row cap for the returned task/email lists — the UI paginates these client-side (100/page).
// The COUNT queries are separate, so totals stay accurate even when the list is capped here.
const TASK_ROW_CAP = Number(process.env.TASK_ROW_CAP) || 2000;
// Allowlist for the task-status filter — keeps the value out of raw SQL. Unknown → 'Completed'.
const TASK_STATUSES = ['Completed', 'Not Started', 'In Progress', 'Waiting on someone else', 'Deferred', 'all'];
const normalizeTaskStatus = s => TASK_STATUSES.includes(s) ? s : 'Completed';

// `emailOnly` filters to email-subtype rows; `shape` picks the display columns/join independently
// ('case' → case number/subject, 'recipient' → contact name/email). `cap` bounds the returned row
// list (pass null for the full timeframe, e.g. CSV export). `status` filters task status —
// 'Completed' (default), a specific value, or 'all' to include every status. Defaults preserve
// prior behavior.
async function fetchCompletedTasks({ ownerId, period, startDate, endDate, emailOnly, shape, cap = TASK_ROW_CAP, dateFilterE, dateFilterL, countOnly = false, status = 'Completed' }) {
  const useCase = (shape ?? (emailOnly ? 'case' : 'recipient')) === 'case';
  const limitClause = cap ? `LIMIT ${cap}` : '';
  const dE = dateFilterE ?? taskCompletedDateFilter(period, startDate, endDate, 't.task_completed_at');
  const dL = dateFilterL ?? taskCompletedDateFilter(period, startDate, endDate, 't.CompletedDateTime');
  const subE = emailOnly ? "AND LOWER(t.task_subtype) = 'email'" : '';
  const subL = emailOnly ? "AND LOWER(t.TaskSubtype) = 'email'" : '';
  // 'all' drops the status predicate; otherwise filter to the exact status (allowlisted by callers).
  const statE = status === 'all' ? '' : `AND t.task_status = '${status}'`;
  const statL = status === 'all' ? '' : `AND t.Status = '${status}'`;
  const whereE = `t.task_owner_id = '${ownerId}' AND t.is_deleted = false ${statE} ${subE} AND ${dE}`;
  const whereL = `t.OwnerId = '${ownerId}' AND t.IsDeleted = 'false' ${statL} ${subL} AND ${dL}`;

  // Display columns differ: 'case' shape joins CASE (case number/subject), 'recipient' joins CONTACT.
  const mergedSelect = useCase
    ? `u.id AS Id, u.subject AS Subject, u.completed_at AS CompletedDateTime, u.status AS Status,
       u.subtype AS TaskSubtype, u.what_id AS case_id, c.casenumber AS case_number, c.subject AS case_subject`
    : `u.id AS Id, u.subject AS Subject, u.description AS Description, u.subtype AS TaskSubtype,
       u.completed_at AS CompletedDateTime, u.status AS Status, ct.name AS recipient_name, ct.email AS recipient_email`;
  const mergedJoin = useCase
    ? `LEFT JOIN ${CASE} c ON c.id = u.what_id AND c.is_current = true`
    : `LEFT JOIN ${CONTACT} ct ON ct.id = u.who_id AND ct.is_current = true`;

  // 1) Preferred path: merge both tables, de-dupe by Id (enriched wins via pref=1).
  const countMerged = `SELECT COUNT(*) AS cnt FROM (
      (SELECT task_id AS id FROM ${CRM_TASK} t WHERE ${whereE})
      UNION
      (SELECT Id AS id FROM ${SRC_TASK} t WHERE ${whereL})
    )`;
  const rowsMerged = `
    WITH unioned AS (
      SELECT task_id AS id, task_subject AS subject, task_description AS description, task_subtype AS subtype,
             CAST(task_completed_at AS TIMESTAMP) AS completed_at, task_status AS status,
             task_who_id AS who_id, task_what_id AS what_id, 1 AS pref
      FROM ${CRM_TASK} t WHERE ${whereE}
      UNION ALL
      SELECT Id, Subject, Description, TaskSubtype,
             CAST(CompletedDateTime AS TIMESTAMP), Status, WhoId, WhatId, 2 AS pref
      FROM ${SRC_TASK} t WHERE ${whereL}
    ),
    deduped AS (
      SELECT * FROM unioned QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY pref) = 1
    )
    SELECT ${mergedSelect} FROM deduped u ${mergedJoin}
    ORDER BY u.completed_at DESC ${limitClause}`;
  try {
    const [count, rows = []] = await Promise.all(countOnly ? [query(countMerged)] : [query(countMerged), query(rowsMerged)]);
    return { count, rows, source: 'merged', error: null };
  } catch (errMerged) {
    console.error(`[rep-detail] merged ${emailOnly ? 'email' : 'task'} query failed for ${ownerId}; trying enriched-only: ${errMerged.message}`);
  }

  // 2) Fallback: enriched only.
  try {
    const sel = useCase
      ? `t.task_id AS Id, t.task_subject AS Subject, t.task_completed_at AS CompletedDateTime, t.task_status AS Status,
         t.task_subtype AS TaskSubtype, t.task_what_id AS case_id, c.casenumber AS case_number, c.subject AS case_subject`
      : `t.task_id AS Id, t.task_subject AS Subject, t.task_description AS Description, t.task_subtype AS TaskSubtype,
         t.task_completed_at AS CompletedDateTime, t.task_status AS Status, ct.name AS recipient_name, ct.email AS recipient_email`;
    const jn = useCase
      ? `LEFT JOIN ${CASE} c ON c.id = t.task_what_id AND c.is_current = true`
      : `LEFT JOIN ${CONTACT} ct ON ct.id = t.task_who_id AND ct.is_current = true`;
    const [count, rows = []] = await Promise.all(countOnly
      ? [query(`SELECT COUNT(*) AS cnt FROM ${CRM_TASK} t WHERE ${whereE}`)]
      : [query(`SELECT COUNT(*) AS cnt FROM ${CRM_TASK} t WHERE ${whereE}`),
         query(`SELECT ${sel} FROM ${CRM_TASK} t ${jn} WHERE ${whereE} ORDER BY t.task_completed_at DESC ${limitClause}`)]);
    return { count, rows, source: 'enriched', error: null };
  } catch (errEnriched) {
    console.error(`[rep-detail] enriched-only ${emailOnly ? 'email' : 'task'} failed for ${ownerId}; trying legacy-only: ${errEnriched.message}`);
  }

  // 3) Last resort: legacy only.
  try {
    const sel = useCase
      ? `t.Id, t.Subject, t.CompletedDateTime, t.Status, t.TaskSubtype, t.WhatId AS case_id,
         c.casenumber AS case_number, c.subject AS case_subject`
      : `t.Id, t.Subject, t.Description, t.TaskSubtype, t.CompletedDateTime, t.Status,
         ct.name AS recipient_name, ct.email AS recipient_email`;
    const jn = useCase
      ? `LEFT JOIN ${CASE} c ON c.id = t.WhatId AND c.is_current = true`
      : `LEFT JOIN ${CONTACT} ct ON ct.id = t.WhoId AND ct.is_current = true`;
    const [count, rows = []] = await Promise.all(countOnly
      ? [query(`SELECT COUNT(*) AS cnt FROM ${SRC_TASK} t WHERE ${whereL}`)]
      : [query(`SELECT COUNT(*) AS cnt FROM ${SRC_TASK} t WHERE ${whereL}`),
         query(`SELECT ${sel} FROM ${SRC_TASK} t ${jn} WHERE ${whereL} ORDER BY t.CompletedDateTime DESC ${limitClause}`)]);
    return { count, rows, source: 'legacy', error: null };
  } catch (errLegacy) {
    console.error(`[rep-detail] legacy-only ${emailOnly ? 'email' : 'task'} also failed for ${ownerId}: ${errLegacy.message}`);
    return { count: [], rows: [], source: 'none', error: errLegacy.message };
  }
}

function priorTaskCompletedClause(period, col = 't.CompletedDateTime') {
  const c = priorCallsClause(period);
  return c ? c.replace(/DATE\(t\.start_time\)/g, `DATE(${col})`) : null;
}

function priorStatusClause(period) {
  const c = priorCallsClause(period);
  return c ? c.replace(/DATE\(t\.start_time\)/g, 'DATE(dsu.status_start_at)') : null;
}

function priorInstaClause(period) {
  const c = priorCallsClause(period);
  return c ? c.replace(/DATE\(t\.start_time\)/g, 'DATE(asr.CREATED)') : null;
}

// 8h workday in seconds — denominator for productivity % since status rows are daily averages
const EXPECTED_DAILY_SECS = 8 * 3600;

// A single 'offline' segment longer than 8h = the rep clocked out for the day/weekend.
// Such segments are excluded from on-clock aggregations so they don't drag productivity.
const CLOCKOUT_THRESHOLD_SECS = 8 * 3600;
const NOT_CLOCKOUT = `NOT (LOWER(dsu.status) = 'offline' AND ` +
  `(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) > ${CLOCKOUT_THRESHOLD_SECS})`;

function computeProductivity(statusRows, channelType) {
  const byStatus = {};
  for (const row of statusRows ?? []) {
    // Exclude 'offline' entirely — it should not appear in the breakdown nor
    // count toward clocked-in time.
    if (String(row.status).trim().toLowerCase() === 'offline') continue;
    byStatus[row.status] = Number(row.avg_secs ?? 0);
  }
  const availSecs  = byStatus['available']  || 0;
  const onCallSecs = byStatus['on a call']  || 0;
  const chatSecs   = byStatus['chat']       || 0;
  let totalSecs;
  if (channelType === 'calls') {
    totalSecs = availSecs + onCallSecs;
  } else if (channelType === 'chats') {
    totalSecs = chatSecs || availSecs;
  } else {
    totalSecs = availSecs + onCallSecs + chatSecs;
  }
  const expectedSecs = EXPECTED_DAILY_SECS;
  const productivityPct = expectedSecs > 0 ? (totalSecs / expectedSecs) * 100 : 0;
  // statusRows already exclude clock-out segments (offline > 8h), so clocked-in =
  // all on-clock status time. On-clock % = productive ÷ clocked-in.
  const clockedInSecs = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const onClockPct = clockedInSecs > 0 ? (totalSecs / clockedInSecs) * 100 : 0;
  // Logged-in time = total time in any non-'offline' status (avg/day). Experimental
  // alternative denominator to the hard-coded 8h expected day.
  const loggedInSecs = Object.entries(byStatus)
    .filter(([s]) => String(s).trim().toLowerCase() !== 'offline')
    .reduce((a, [, secs]) => a + secs, 0);
  const loggedInPct = loggedInSecs > 0 ? (totalSecs / loggedInSecs) * 100 : 0;
  const statusBreakdown = (statusRows ?? [])
    .map(r => ({ status: r.status, avgSecs: Number(r.avg_secs ?? 0) }))
    .filter(({ status }) => String(status).trim().toLowerCase() !== 'offline')
    .sort((a, b) => b.avgSecs - a.avgSecs);
  return { availSecs, onCallSecs, chatSecs, totalSecs, expectedSecs, productivityPct,
           clockedInSecs, onClockPct, loggedInSecs, loggedInPct, byStatus: statusBreakdown };
}

function ownerWhere({ ownerIds, ownerId } = {}) {
  const raw = ownerIds || ownerId || null;
  if (!raw) return '';
  const ids = String(raw).split(',').map(s => s.trim()).filter(s => SFID_RE.test(s));
  if (!ids.length) return '';
  return `AND ownerid IN (${ids.map(s => `'${s}'`).join(', ')})`;
}

function cuOwnerWhere(p = {}) {
  const raw = p.ownerIds || p.ownerId || null;
  if (!raw) return '';
  const ids = String(raw).split(',').map(s => s.trim()).filter(s => SFID_RE.test(s));
  if (!ids.length) return '';
  return `AND cu.id IN (${ids.map(s => `'${s}'`).join(', ')})`;
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
app.get("/api/overview-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const p = req.query;
  const ow = ownerWhere(p);
  const cl = closedSince(p);
  const cd = createdSince(p);

  try {
    const cuOw = cuOwnerWhere(p);
    // Emails SENT (completed email tasks) — merged enriched+legacy, de-duped by task Id, scoped by
    // the same owner filter & period. Matches the Rep Details methodology (NOT origin='Email' cases).
    const ownerTaskE = ow.replace(/ownerid/g, 't.task_owner_id');
    const ownerTaskL = ow.replace(/ownerid/g, 't.OwnerId');
    const emailDateE = taskCompletedDateFilter(p.period, p.startDate, p.endDate, 't.task_completed_at');
    const emailDateL = taskCompletedDateFilter(p.period, p.startDate, p.endDate, 't.CompletedDateTime');
    const emailTasksQuery = query(`
      SELECT COUNT(DISTINCT id) AS total, COUNT(DISTINCT day) AS active_days FROM (
        SELECT t.task_id AS id, DATE(t.task_completed_at) AS day
        FROM ${CRM_TASK} t
        WHERE t.is_deleted = false AND t.task_status = 'Completed' AND LOWER(t.task_subtype) = 'email'
          AND ${emailDateE} ${ownerTaskE}
        UNION ALL
        SELECT t.Id AS id, DATE(t.CompletedDateTime) AS day
        FROM ${SRC_TASK} t
        WHERE t.IsDeleted = 'false' AND t.Status = 'Completed' AND LOWER(t.TaskSubtype) = 'email'
          AND ${emailDateL} ${ownerTaskL}
      )`).catch(() => []);

    const [statusRows, closedTodayRows, avgRespRows, emailsTodayRows, dailyRows, hourlyRows, totalClosedRows, prodRow, prodHourlyRows, mrrRow, mrrByRepRows, callsRow, chatsRow, emailTasksRow] =
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
        query(`SELECT AVG(rep_day_secs) AS avg_productive_secs
               FROM (
                 SELECT DATE(dsu.status_start_at) AS day, cu.id,
                        SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS rep_day_secs
                 FROM ${TD_STATUS} dsu
                 JOIN ${USER} cu ON LOWER(dsu.user_name) = LOWER(cu.name) AND cu.is_current = true
                 WHERE ${statusDateFilter(p.period, p.startDate, p.endDate)}
                   AND LOWER(dsu.status) NOT IN ('offline','break','lunch ','away','meeting/training ','meeting/training','none')
                   ${cuOw}
                 GROUP BY DATE(dsu.status_start_at), cu.id
               ) sub`).catch(() => []),
        query(`SELECT hour_of_day, status, AVG(daily_secs) AS avg_secs
               FROM (
                 SELECT DATE(dsu.status_start_at) AS day,
                        HOUR(dsu.status_start_at) AS hour_of_day,
                        dsu.status,
                        SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS daily_secs
                 FROM ${TD_STATUS} dsu
                 JOIN ${USER} cu ON LOWER(dsu.user_name) = LOWER(cu.name) AND cu.is_current = true
                 WHERE ${statusDateFilter(p.period, p.startDate, p.endDate)}
                   AND LOWER(dsu.status) != 'offline'
                   ${cuOw}
                 GROUP BY DATE(dsu.status_start_at), HOUR(dsu.status_start_at), dsu.status
               ) sub
               GROUP BY hour_of_day, status
               ORDER BY hour_of_day, status`).catch(() => []),
        query(`SELECT SUM(upg.net_price_change) AS mrr_total, COUNT(*) AS upgrade_count
               FROM ${UPGRADES} upg
               JOIN ${USER} cu ON (TRIM(LOWER(cu.name)) = TRIM(LOWER(upg.agent_name)) OR LOWER(upg.agent_name) LIKE TRIM(LOWER(cu.name)) || '%') AND cu.is_current = true
               WHERE ${mrrDateFilter(p.period, p.startDate, p.endDate)}
               ${cuOw}`).catch(() => []),
        query(`SELECT cu.name AS rep_name,
                      SUM(upg.net_price_change) AS mrr_total,
                      COUNT(*) AS upgrade_count
               FROM ${UPGRADES} upg
               JOIN ${USER} cu ON (TRIM(LOWER(cu.name)) = TRIM(LOWER(upg.agent_name)) OR LOWER(upg.agent_name) LIKE TRIM(LOWER(cu.name)) || '%') AND cu.is_current = true
               WHERE ${mrrDateFilter(p.period, p.startDate, p.endDate)}
               ${cuOw}
               GROUP BY cu.name
               ORDER BY mrr_total DESC`).catch(() => []),
        query(`SELECT COUNT(*) AS call_count,
                      COUNT(CASE WHEN LOWER(t.call_type) = 'inbound'  THEN 1 END) AS inbound_calls,
                      COUNT(CASE WHEN LOWER(t.call_type) = 'outbound' THEN 1 END) AS outbound_calls,
                      COUNT(CASE WHEN LOWER(t.call_type) = 'missed'   THEN 1 END) AS missed_calls,
                      AVG(CAST(t.talk_time AS DOUBLE))    AS avg_talk,
                      AVG(CAST(t.holding_time AS DOUBLE)) AS avg_hold,
                      AVG(CAST(t.csat_score AS DOUBLE))   AS avg_csat,
                      COUNT(CASE WHEN t.csat_score IS NOT NULL THEN 1 END) AS csat_count
               FROM ${TD} t
               JOIN ${USER} cu ON LOWER(cu.email) = LOWER(t.user_email) AND cu.is_current = true
               WHERE ${callsDateFilter(p.period, p.startDate, p.endDate)}
               ${cuOw}`).catch(() => []),
        query(`SELECT COUNT(*) AS chat_count,
                      AVG(CASE WHEN m.accepttime IS NOT NULL AND m.endtime IS NOT NULL
                               THEN DATEDIFF(SECOND, m.accepttime, m.endtime) END) AS avg_handle,
                      AVG(CASE WHEN m.accepttime IS NOT NULL
                               THEN DATEDIFF(SECOND, m.createddate, m.accepttime) END) AS avg_wait
               FROM ${SRC_MESSAGING} m
               JOIN ${USER} cu ON cu.id = m.ownerid AND cu.is_current = true
               WHERE m.is_current = 'true'
                 AND m.channelname != 'Marketing Site Messaging'
                 AND ${sessionDateFilter(p.period, p.startDate, p.endDate)}
               ${cuOw}`).catch(() => []),
        emailTasksQuery,
      ]);

    res.json({
      statusTotals:       { records: statusRows },
      closedToday:        Number(closedTodayRows[0]?.cnt ?? 0),
      avgResponseHrs:     Number(avgRespRows[0]?.avg_hrs ?? 0),
      emailsToday:        Number(emailsTodayRows[0]?.cnt ?? 0),
      dailyClosed14d:     { records: dailyRows },
      hourlyNew:          { records: hourlyRows },
      totalClosedPeriod:  Number(totalClosedRows[0]?.cnt ?? 0),
      avgProductiveSecs:  Number(prodRow?.[0]?.avg_productive_secs ?? 0) || null,
      productivityHourly: (prodHourlyRows ?? []).map(r => ({ hour: Number(r.hour_of_day), status: r.status, avgSecs: Number(r.avg_secs ?? 0) })),
      mrrTotal:           Number(mrrRow?.[0]?.mrr_total ?? 0) || 0,
      mrrUpgradeCount:    Number(mrrRow?.[0]?.upgrade_count ?? 0),
      mrrByRep:           (mrrByRepRows ?? []).map(r => ({ repName: r.rep_name, mrrTotal: Number(r.mrr_total ?? 0), upgradeCount: Number(r.upgrade_count ?? 0) })),
      totalCalls:         Number(callsRow?.[0]?.call_count ?? 0),
      totalChats:         Number(chatsRow?.[0]?.chat_count ?? 0),
      tdStats: {
        callCount:    Number(callsRow?.[0]?.call_count    ?? 0),
        inbound:      Number(callsRow?.[0]?.inbound_calls  ?? 0),
        outbound:     Number(callsRow?.[0]?.outbound_calls ?? 0),
        missed:       Number(callsRow?.[0]?.missed_calls   ?? 0),
        avgTalkSecs:  callsRow?.[0]?.avg_talk != null ? Number(callsRow[0].avg_talk) : null,
        avgHoldSecs:  callsRow?.[0]?.avg_hold != null ? Number(callsRow[0].avg_hold) : null,
        avgCsat:      callsRow?.[0]?.avg_csat != null ? Number(callsRow[0].avg_csat) : null,
        csatCount:    Number(callsRow?.[0]?.csat_count     ?? 0),
      },
      chatStats: {
        chatCount:     Number(chatsRow?.[0]?.chat_count  ?? 0),
        avgHandleSecs: chatsRow?.[0]?.avg_handle != null ? Number(chatsRow[0].avg_handle) : null,
        avgWaitSecs:   chatsRow?.[0]?.avg_wait   != null ? Number(chatsRow[0].avg_wait)   : null,
      },
      emailStats: {
        sentCount:  Number(emailTasksRow?.[0]?.total       ?? 0),
        activeDays: Number(emailTasksRow?.[0]?.active_days  ?? 0),
      },
    });
  } catch (err) {
    console.error('❌ [overview-data]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/overview-rep-table ───────────────────────────────────────────────
app.get('/api/overview-rep-table', cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const p = req.query;
  const cuOw = cuOwnerWhere(p);
  const sfOw = cuOw.replace(/cu\.id/g, 'sf.id');

  const callsFilter = callsDateFilter(p.period, p.startDate, p.endDate);
  const sessFilter  = sessionDateFilter(p.period, p.startDate, p.endDate);
  const statFilter  = statusDateFilter(p.period, p.startDate, p.endDate);
  const mrrFilter   = mrrDateFilter(p.period, p.startDate, p.endDate);
  const instaFilter = callsFilter.replace(/DATE\(t\.start_time\)/g, 'DATE(asr.CREATED)');

  try {
    const [callsRows, chatsRows, casesRows, prodRows, mrrRows, instaRows] = await Promise.all([
      query(`SELECT cu.id AS owner_id, cu.name AS rep_name,
                    COUNT(*) AS total_calls,
                    COUNT(CASE WHEN LOWER(t.call_type) = 'inbound'  THEN 1 END) AS inbound_calls,
                    COUNT(CASE WHEN LOWER(t.call_type) = 'outbound' THEN 1 END) AS outbound_calls,
                    COUNT(CASE WHEN LOWER(t.call_type) = 'missed'   THEN 1 END) AS missed_calls,
                    AVG(CAST(t.csat_score AS DOUBLE)) AS avg_csat,
                    COUNT(CASE WHEN t.csat_score IS NOT NULL THEN 1 END) AS csat_count
             FROM ${TD} t
             JOIN ${USER} cu ON LOWER(cu.email) = LOWER(t.user_email) AND cu.is_current = true
             WHERE ${callsFilter} ${cuOw}
             GROUP BY cu.id, cu.name`).catch(() => []),

      query(`SELECT cu.id AS owner_id, cu.name AS rep_name, COUNT(*) AS total_chats
             FROM ${SRC_MESSAGING} m
             JOIN ${USER} cu ON cu.id = m.ownerid AND cu.is_current = true
             WHERE m.is_current = 'true'
               AND m.channelname != 'Marketing Site Messaging'
               AND ${sessFilter} ${cuOw}
             GROUP BY cu.id, cu.name`).catch(() => []),

      query(`SELECT c.ownerid AS owner_id, cu.name AS rep_name,
                    COUNT(*) AS open_cases,
                    COUNT(CASE WHEN DATE(c.createddate) <= DATE_ADD(CURRENT_DATE(), -90) THEN 1 END) AS hot_cases
             FROM ${CASE} c
             JOIN ${USER} cu ON cu.id = c.ownerid AND cu.is_current = true
             WHERE c.is_current = true AND c.isclosed = 'false' ${cuOw}
             GROUP BY c.ownerid, cu.name`).catch(() => []),

      query(`SELECT cu.id AS owner_id, cu.name AS rep_name,
                    sub.status, AVG(sub.daily_secs) AS avg_secs
             FROM (
               SELECT DATE(dsu.status_start_at) AS day, LOWER(dsu.user_name) AS user_name, dsu.status,
                      SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS daily_secs
               FROM ${TD_STATUS} dsu
               WHERE ${statFilter}
                 AND LOWER(dsu.status) IN ('available', 'on a call', 'chat')
               GROUP BY DATE(dsu.status_start_at), LOWER(dsu.user_name), dsu.status
             ) sub
             JOIN ${USER} cu ON LOWER(cu.name) = sub.user_name AND cu.is_current = true
             WHERE 1=1 ${cuOw}
             GROUP BY cu.id, cu.name, sub.status`).catch(() => []),

      query(`SELECT cu.id AS owner_id, cu.name AS rep_name,
                    SUM(upg.net_price_change) AS mrr_total,
                    COUNT(*) AS upgrade_count
             FROM ${UPGRADES} upg
             JOIN ${USER} cu ON (TRIM(LOWER(cu.name)) = TRIM(LOWER(upg.agent_name)) OR LOWER(upg.agent_name) LIKE TRIM(LOWER(cu.name)) || '%') AND cu.is_current = true
             WHERE ${mrrFilter} ${cuOw}
             GROUP BY cu.id, cu.name`).catch(() => []),

      query(`SELECT sf.id AS owner_id, sf.name AS rep_name,
                    ins.CATEGORY, AVG(CAST(ins.CATEGORY_SCORE_PCNT AS DOUBLE)) AS avg_pct,
                    COUNT(DISTINCT ins.ASR_LOG_ID) AS scored_convos
             FROM (
               SELECT * FROM ${LAI_SCORE}
               WHERE RUBRIC_TITLE = 'Unstoppable Call Experience (IS)'
               QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1
             ) ins
             JOIN ${LAI_ASR}  asr ON asr.ID  = ins.ASR_LOG_ID
             JOIN ${LAI_USER} u   ON u.ID    = asr.USER_ID
             JOIN ${USER}     sf  ON LOWER(sf.email) = LOWER(u.EMAIL)
             WHERE sf.is_current = true
               AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
               AND ${instaFilter} ${sfOw}
             GROUP BY sf.id, sf.name, ins.CATEGORY`).catch(() => []),
    ]);

    const repMap = {};

    function ensure(id, name) {
      if (!repMap[id]) repMap[id] = { repName: name };
    }

    for (const r of callsRows) {
      ensure(r.owner_id, r.rep_name);
      Object.assign(repMap[r.owner_id], {
        totalCalls:    Number(r.total_calls    ?? 0),
        inboundCalls:  Number(r.inbound_calls  ?? 0),
        outboundCalls: Number(r.outbound_calls ?? 0),
        missedCalls:   Number(r.missed_calls   ?? 0),
        avgCsat:       r.avg_csat != null ? Number(r.avg_csat) : null,
        csatCount:     Number(r.csat_count ?? 0),
      });
    }
    for (const r of chatsRows) {
      ensure(r.owner_id, r.rep_name);
      repMap[r.owner_id].totalChats = Number(r.total_chats ?? 0);
    }
    for (const r of casesRows) {
      ensure(r.owner_id, r.rep_name);
      repMap[r.owner_id].openCases = Number(r.open_cases ?? 0);
      repMap[r.owner_id].hotCases  = Number(r.hot_cases  ?? 0);
    }
    for (const r of mrrRows) {
      ensure(r.owner_id, r.rep_name);
      repMap[r.owner_id].mrrTotal     = Number(r.mrr_total    ?? 0);
      repMap[r.owner_id].upgradeCount = Number(r.upgrade_count ?? 0);
    }

    const prodByRep = {};
    for (const r of prodRows) {
      if (!prodByRep[r.owner_id]) prodByRep[r.owner_id] = { name: r.rep_name, rows: [] };
      prodByRep[r.owner_id].rows.push({ status: r.status, avg_secs: r.avg_secs });
    }
    for (const [id, v] of Object.entries(prodByRep)) {
      ensure(id, v.name);
      const prod = computeProductivity(v.rows, 'all');
      // Default productivitySecs stays the 'all' total (backward compatible);
      // also expose the per-channel components so the Rep Summary can compute
      // productive time per the rep's own channel type, matching Rep Details.
      repMap[id].productivitySecs = prod.totalSecs;
      repMap[id].availSecs  = prod.availSecs;
      repMap[id].onCallSecs = prod.onCallSecs;
      repMap[id].chatSecs   = prod.chatSecs;
    }

    const instaByRep = {};
    for (const r of instaRows) {
      if (!instaByRep[r.owner_id]) instaByRep[r.owner_id] = { name: r.rep_name, cats: [], convos: 0 };
      instaByRep[r.owner_id].cats.push({ category: r.CATEGORY, score: Number(r.avg_pct ?? 0) });
      instaByRep[r.owner_id].convos = Math.max(instaByRep[r.owner_id].convos, Number(r.scored_convos ?? 0));
    }
    for (const [id, v] of Object.entries(instaByRep)) {
      ensure(id, v.name);
      repMap[id].instascore   = weightedInstascore(v.cats);
      repMap[id].scoredConvos = v.convos;
    }

    const reps = Object.values(repMap)
      .filter(r => r.repName)
      .sort((a, b) => (a.repName ?? '').localeCompare(b.repName ?? ''));

    res.json({ reps });
  } catch (err) {
    console.error('❌ [overview-rep-table]', err.message);
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
    case 'last_30':
      return `DATE(closeddate) >= DATE_SUB(CURRENT_DATE(), 60)
              AND DATE(closeddate) < DATE_SUB(CURRENT_DATE(), 30)`;
    default:
      return null;
  }
}

function priorCallsClause(period) {
  switch (period) {
    case 'today':
      return `DATE(t.start_time) = DATE_ADD(CURRENT_DATE(), -1)`;
    case 'week':
      return `DATE(t.start_time) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)
              AND DATE(t.start_time) < DATE_TRUNC('WEEK', CURRENT_DATE())`;
    case 'last_week':
      return `DATE(t.start_time) >= DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -14)
              AND DATE(t.start_time) < DATE_ADD(DATE_TRUNC('WEEK', CURRENT_DATE()), -7)`;
    case 'month':
      return `DATE(t.start_time) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))
              AND DATE(t.start_time) < DATE_TRUNC('MONTH', CURRENT_DATE())`;
    case 'last_month':
      return `DATE(t.start_time) >= DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -2))
              AND DATE(t.start_time) < DATE_TRUNC('MONTH', ADD_MONTHS(CURRENT_DATE(), -1))`;
    case 'last_30':
      return `DATE(t.start_time) >= DATE_SUB(CURRENT_DATE(), 60)
              AND DATE(t.start_time) < DATE_SUB(CURRENT_DATE(), 30)`;
    default:
      return null;
  }
}

// ── GET /api/rep-detail ────────────────────────────────────────────────────────
app.get("/api/rep-detail", cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate, channelType = 'calls' } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });
  const taskStatus = normalizeTaskStatus(req.query.taskStatus);

  const owId  = `AND ownerid = '${ownerId}'`;
  const cl    = closedSince({ period, startDate, endDate });
  const isCustom = startDate && endDate && ISO_RE.test(startDate) && ISO_RE.test(endDate);
  const priorClause = isCustom ? null : priorClosedClause(period);
  const hasPrior = priorClause !== null;

  const mrrFilter      = mrrDateFilter(period, startDate, endDate);
  // Prior period: week/day-level uses marked_at; month-level uses marked_month
  const mrrPriorFilter = hasPrior && priorClause
    ? (['week', 'last_week', 'today', 'yesterday', 'last_30'].includes(period)
        ? priorClause.replace(/DATE\(closeddate\)/g, 'DATE(upg.marked_at)')
        : priorClause.replace(/DATE\(closeddate\)/g, 'DATE(upg.marked_month)'))
    : null;

  const callsFilter   = callsDateFilter(period, startDate, endDate);
  const ticketsFilter = sessionDateFilter(period, startDate, endDate);

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
      // 6. Talkdesk call stats for current period
      query(`SELECT COUNT(*) AS call_count,
                    COUNT(CASE WHEN t.csat_score IS NOT NULL THEN 1 END) AS csat_count,
                    AVG(CAST(t.talk_time AS DOUBLE)) AS avg_talk,
                    AVG(CAST(t.holding_time AS DOUBLE)) AS avg_hold,
                    AVG(CAST(t.csat_score AS DOUBLE)) AS avg_csat
             FROM ${TD} t
             JOIN ${USER} cu ON LOWER(cu.email) = LOWER(t.user_email) AND cu.is_current = true
             WHERE cu.id = '${ownerId}'
               AND ${callsFilter}`),
      // 7. Talkdesk individual calls for current period
      query(`SELECT t.start_time, t.call_type, t.talk_time, t.holding_time, t.csat_score, t.recording_link
             FROM ${TD} t
             JOIN ${USER} cu ON LOWER(cu.email) = LOWER(t.user_email) AND cu.is_current = true
             WHERE cu.id = '${ownerId}'
               AND ${callsFilter}
             ORDER BY t.start_time DESC`),
      // 8. MRR upgrades for current period. Each upgrade is matched (best-effort)
      //    to the call that drove it: same company + same rep + same day, picking
      //    the latest call that started at/before the upgrade was marked.
      query(`SELECT * FROM (
               SELECT upg.marked_upgrade_id, upg.marked_month, upg.upgrade_at, upg.most_recent_upgrade,
                      upg.company_id, upg.location_id, upg.start_tier, upg.end_tier, upg.net_price_change,
                      COALESCE(loc.name, comp.name) AS location_name,
                      td.recording_link AS call_recording_link,
                      ROW_NUMBER() OVER (
                        PARTITION BY upg.marked_upgrade_id
                        ORDER BY td.start_time DESC
                      ) AS call_rn
               FROM ${UPGRADES} upg
               JOIN ${USER} cu ON (TRIM(LOWER(cu.name)) = TRIM(LOWER(upg.agent_name)) OR LOWER(upg.agent_name) LIKE TRIM(LOWER(cu.name)) || '%') AND cu.is_current = true
               LEFT JOIN ${LOCATIONS} loc ON CAST(loc.location_id AS STRING) = CAST(upg.location_id AS STRING)
               LEFT JOIN ${COMPANIES} comp ON CAST(comp.company_id AS STRING) = CAST(upg.company_id AS STRING)
               LEFT JOIN ${TD} td
                 ON CAST(td.company_id AS STRING) = CAST(upg.company_id AS STRING)
                AND LOWER(td.user_email) = LOWER(cu.email)
                AND DATE(td.start_time) = DATE(upg.marked_at)
                AND td.start_time <= upg.marked_at
                AND td.recording_link IS NOT NULL AND td.recording_link != 'None'
               WHERE cu.id = '${ownerId}'
                 AND ${mrrFilter}
             ) ranked
             WHERE call_rn = 1
             ORDER BY marked_month DESC, upgrade_at DESC`),
      // 9. SF Chat sessions with timing data for current period
      query(`SELECT m.id AS session_id,
                    m.createddate AS chat_start_time,
                    m.accepttime AS agent_accept_time,
                    m.endtime AS chat_end_time,
                    DATEDIFF(SECOND, m.createddate, m.endtime) AS duration_seconds,
                    DATEDIFF(SECOND, m.createddate, m.accepttime) AS wait_seconds,
                    m.email__c AS customer_email,
                    t.ticket_id, t.company_id, t.ticket_issue_type, t.company_age_bucket, t.paying
             FROM ${SRC_MESSAGING} m
             LEFT JOIN ${CS_TICKETS} t
               ON t.ticket_id = m.id AND t.ticket_type = 'Chat' AND t.ticket_system = 'Salesforce'
             WHERE m.ownerid = '${ownerId}'
               AND m.is_current = 'true'
               AND m.channelname != 'Marketing Site Messaging'
               AND ${ticketsFilter}
             ORDER BY m.createddate DESC`),
      // NOTE: emails (#10-11) AND the all-completed-tasks dataset for the Activity "Tasks &
      //       Emails" table are now fetched via `emailsPromise` / `tasksPromise` below, which
      //       merge the enriched + legacy task tables (de-duped by Id) so historical months the
      //       enriched table is missing are still counted, and report which source was used.
    ];

    // 7. Prior period closed count — only when a comparison exists
    if (hasPrior) {
      queries.push(
        query(`SELECT COUNT(*) AS cnt FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
               AND ${priorClause} ${owId}`)
      );
    }

    // 8. Prior period MRR total — only when a comparison exists
    if (mrrPriorFilter) {
      queries.push(
        query(`SELECT SUM(upg.net_price_change) AS mrr_prior
               FROM ${UPGRADES} upg
               JOIN ${USER} cu ON (TRIM(LOWER(cu.name)) = TRIM(LOWER(upg.agent_name)) OR LOWER(upg.agent_name) LIKE TRIM(LOWER(cu.name)) || '%') AND cu.is_current = true
               WHERE cu.id = '${ownerId}'
                 AND ${mrrPriorFilter}`)
      );
    }

    // Productivity: agent status time breakdown from dim_user_status
    const statusFilter = statusDateFilter(period, startDate, endDate);
    const prodPromise = query(
      `SELECT status, AVG(daily_secs) AS avg_secs
       FROM (
         SELECT DATE(dsu.status_start_at) AS day, dsu.status,
                SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS daily_secs
         FROM ${TD_STATUS} dsu
         WHERE LOWER(dsu.user_name) = (
           SELECT LOWER(cu.name) FROM ${USER} cu WHERE cu.id = '${ownerId}' AND cu.is_current = true LIMIT 1
         ) AND ${statusFilter}
           AND ${NOT_CLOCKOUT}
         GROUP BY DATE(dsu.status_start_at), dsu.status
       ) sub
       GROUP BY status`
    ).catch(() => []);

    // All-completed-tasks dataset for the Activity "Tasks & Emails" table.
    // Try the enriched table first (used on localhost and in prod once the
    // service principal is granted access). If that query FAILS — e.g. the
    // deployed app's service principal lacks SELECT on prod_enriched — fall
    // back to the legacy stage_raw.ext_crm.src_task (readable by `account
    // users`) so the section still shows something, and surface which source
    // was used + the error rather than silently returning an empty list.
    const tasksPromise  = fetchCompletedTasks({ ownerId, period, startDate, endDate, emailOnly: false, status: taskStatus });
    const emailsPromise = fetchCompletedTasks({ ownerId, period, startDate, endDate, emailOnly: true,  status: taskStatus });

    // Prior period — all groups (only when a natural comparison period exists)
    const priorPeriodPromise = hasPrior ? (() => {
      const priorCallsFilter = priorCallsClause(period);
      const priorSessFilter  = priorSessionClause(period);
      const priorStatFilter  = priorStatusClause(period);
      const priorInstaFilter  = priorInstaClause(period);
      const priorEmailFilterE = priorTaskCompletedClause(period, 't.task_completed_at');
      const priorEmailFilterL = priorTaskCompletedClause(period, 't.CompletedDateTime');
      return Promise.all([
        // [0] Prior Talkdesk stats
        query(`SELECT COUNT(*) AS call_count,
                      COUNT(CASE WHEN t.csat_score IS NOT NULL THEN 1 END) AS csat_count,
                      AVG(CAST(t.talk_time AS DOUBLE)) AS avg_talk,
                      AVG(CAST(t.holding_time AS DOUBLE)) AS avg_hold,
                      AVG(CAST(t.csat_score AS DOUBLE)) AS avg_csat
               FROM ${TD} t
               JOIN ${USER} cu ON LOWER(cu.email) = LOWER(t.user_email) AND cu.is_current = true
               WHERE cu.id = '${ownerId}' AND ${priorCallsFilter}`).catch(() => []),
        // [1] Prior Talkdesk productivity
        query(`SELECT status, AVG(daily_secs) AS avg_secs
               FROM (
                 SELECT DATE(dsu.status_start_at) AS day, dsu.status,
                        SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS daily_secs
                 FROM ${TD_STATUS} dsu
                 WHERE LOWER(dsu.user_name) = (
                   SELECT LOWER(cu.name) FROM ${USER} cu WHERE cu.id = '${ownerId}' AND cu.is_current = true LIMIT 1
                 ) AND ${priorStatFilter}
                   AND ${NOT_CLOCKOUT}
                 GROUP BY DATE(dsu.status_start_at), dsu.status
               ) sub
               GROUP BY status`).catch(() => []),
        // [2] Prior Chat stats
        query(`SELECT COUNT(*) AS chat_count,
                      AVG(CASE WHEN m.accepttime IS NOT NULL AND m.endtime IS NOT NULL
                               THEN DATEDIFF(SECOND, m.accepttime, m.endtime) END) AS avg_handle,
                      AVG(CASE WHEN m.accepttime IS NOT NULL
                               THEN DATEDIFF(SECOND, m.createddate, m.accepttime) END) AS avg_wait
               FROM ${SRC_MESSAGING} m
               WHERE m.ownerid = '${ownerId}'
                 AND m.is_current = 'true'
                 AND m.channelname != 'Marketing Site Messaging'
                 AND ${priorSessFilter}`).catch(() => []),
        // [3] Prior Chat productivity
        query(`SELECT AVG(daily_secs) AS avg_secs
               FROM (
                 SELECT DATE(m.createddate) AS day,
                        SUM(DATEDIFF(SECOND, m.accepttime, m.endtime)) AS daily_secs
                 FROM ${SRC_MESSAGING} m
                 WHERE m.ownerid = '${ownerId}'
                   AND m.is_current = 'true'
                   AND m.channelname != 'Marketing Site Messaging'
                   AND m.accepttime IS NOT NULL AND m.endtime IS NOT NULL
                   AND ${priorSessFilter}
                 GROUP BY DATE(m.createddate)
               ) sub`).catch(() => []),
        // [4] Prior avg response time (closed cases)
        query(`SELECT AVG(CAST(case_response_time_hours__c AS DOUBLE)) AS avg_hrs
               FROM ${CASE}
               WHERE is_current = true AND isclosed = 'true'
                 AND ${priorClause} AND case_response_time_hours__c IS NOT NULL ${owId}`).catch(() => []),
        // [5] Prior Instascore categories
        query(`SELECT ins.CATEGORY, AVG(CAST(ins.CATEGORY_SCORE_PCNT AS DOUBLE)) AS avg_pct
               FROM (
                 SELECT * FROM ${LAI_SCORE}
                 WHERE RUBRIC_TITLE = 'Unstoppable Call Experience (IS)'
                 QUALIFY ROW_NUMBER() OVER (PARTITION BY ASR_LOG_ID, CATEGORY, QUESTION ORDER BY UPDATED DESC) = 1
               ) ins
               JOIN ${LAI_ASR}  asr ON asr.ID  = ins.ASR_LOG_ID
               JOIN ${LAI_USER} u   ON u.ID    = asr.USER_ID
               JOIN ${USER}     sf  ON LOWER(sf.email) = LOWER(u.EMAIL)
               WHERE sf.id = '${ownerId}'
                 AND sf.is_current = true
                 AND (asr.DELETED IS NULL OR asr.DELETED = 'false')
                 AND ${priorInstaFilter}
               GROUP BY ins.CATEGORY`).catch(() => []),
        // [6] Prior email count — merged + de-duped across enriched/legacy, like the current period
        fetchCompletedTasks({
          ownerId, emailOnly: true, countOnly: true,
          dateFilterE: priorEmailFilterE, dateFilterL: priorEmailFilterL,
        }).then(r => r.count).catch(() => []),
      ]);
    })() : Promise.resolve(null);

    // Chat productivity: avg daily time spent actively handling chats (accepttime → endtime)
    const chatProdPromise = query(
      `SELECT AVG(daily_secs) AS avg_secs
       FROM (
         SELECT DATE(m.createddate) AS day,
                SUM(DATEDIFF(SECOND, m.accepttime, m.endtime)) AS daily_secs
         FROM ${SRC_MESSAGING} m
         WHERE m.ownerid = '${ownerId}'
           AND m.is_current = 'true'
           AND m.channelname != 'Marketing Site Messaging'
           AND m.accepttime IS NOT NULL
           AND m.endtime IS NOT NULL
           AND ${ticketsFilter}
         GROUP BY DATE(m.createddate)
       ) sub`
    ).catch(() => []);

    const [[cases, closedRow, avgRespRow, csatRows, avgRespAllRow, tdStatsRow, tdCallRows, mrrRows, sfChatRows, priorRow, mrrPriorRow], statusRows, chatProdRows, priorPeriodData, tasksResult, emailsResult] =
      await Promise.all([Promise.all(queries), prodPromise, chatProdPromise, priorPeriodPromise, tasksPromise, emailsPromise]);

    const taskCountRow  = tasksResult.count;
    const taskRows      = tasksResult.rows;
    const emailCountRow = emailsResult.count;
    const emailRows     = emailsResult.rows;


    const mrrUpgrades = (mrrRows ?? []).map(r => ({
      upgradeId:         r.marked_upgrade_id,
      markedMonth:       r.marked_month,
      upgradeAt:         r.upgrade_at,
      mostRecentUpgrade: r.most_recent_upgrade,
      companyId:         r.company_id,
      locationId:        r.location_id,
      locationName:      r.location_name ?? null,
      startTier:         r.start_tier,
      endTier:           r.end_tier,
      netPriceChange:    Number(r.net_price_change ?? 0),
      callRecordingLink: r.call_recording_link ?? null,
    }));
    const mrrTotal      = mrrUpgrades.reduce((s, u) => s + u.netPriceChange, 0);
    const mrrPriorTotal = mrrPriorFilter && mrrPriorRow ? (Number(mrrPriorRow[0]?.mrr_prior ?? 0) || null) : null;

    res.json({
      cases:              { records: cases },
      closedPeriod:       Number(closedRow[0]?.cnt ?? 0),
      closedPriorPeriod:  hasPrior ? Number(priorRow[0]?.cnt ?? 0) : 0,
      hasPrior,
      avgResponseHrs:     Number(avgRespRow[0]?.avg_hrs ?? 0),
      avgResponseHrsAll:  avgRespAllRow[0]?.avg_hrs_all != null ? Number(avgRespAllRow[0].avg_hrs_all) : null,
      csatData:           { records: csatRows },
      mrrTotal,
      mrrPriorTotal,
      mrrUpgrades,
      tdStats: {
        callCount:   Number(tdStatsRow[0]?.call_count ?? 0),
        csatCount:   Number(tdStatsRow[0]?.csat_count ?? 0),
        avgTalkSecs: tdStatsRow[0]?.avg_talk != null ? Number(tdStatsRow[0].avg_talk) : null,
        avgHoldSecs: tdStatsRow[0]?.avg_hold != null ? Number(tdStatsRow[0].avg_hold) : null,
        avgCsat:     tdStatsRow[0]?.avg_csat != null ? Number(tdStatsRow[0].avg_csat) : null,
      },
      tdCalls: (tdCallRows ?? []).map(r => ({
        startTime:     r.start_time,
        callType:      r.call_type ?? null,
        talkSecs:      r.talk_time    != null ? Number(r.talk_time)    : null,
        holdSecs:      r.holding_time != null ? Number(r.holding_time) : null,
        csatScore:     r.csat_score   != null ? Number(r.csat_score)   : null,
        recordingLink: r.recording_link ?? null,
      })),
      productivity: computeProductivity(statusRows, channelType),
      chatProductivitySecs: chatProdRows?.[0]?.avg_secs != null ? Number(chatProdRows[0].avg_secs) : null,
      priorPeriod: hasPrior && priorPeriodData ? (() => {
        const [priorTd, priorStat, priorChat, priorChatProd, priorAvgResp, priorInsta, priorEmail] = priorPeriodData;
        const priorProd = computeProductivity(priorStat ?? [], channelType);
        return {
          closedCases:        hasPrior ? Number(priorRow?.[0]?.cnt ?? 0) : null,
          mrrTotal:           mrrPriorTotal,
          tdCallCount:        Number(priorTd?.[0]?.call_count   ?? 0),
          tdCsatCount:        Number(priorTd?.[0]?.csat_count   ?? 0),
          tdAvgTalkSecs:      priorTd?.[0]?.avg_talk  != null ? Number(priorTd[0].avg_talk)  : null,
          tdAvgHoldSecs:      priorTd?.[0]?.avg_hold  != null ? Number(priorTd[0].avg_hold)  : null,
          tdAvgCsat:          priorTd?.[0]?.avg_csat  != null ? Number(priorTd[0].avg_csat)  : null,
          tdProductivitySecs: priorProd.totalSecs,
          productivityPct:    priorProd.productivityPct,
          expectedSecs:       priorProd.expectedSecs,
          availSecs:          priorProd.availSecs,
          onCallSecs:         priorProd.onCallSecs,
          chatSecsTd:         priorProd.chatSecs,
          chatCount:          Number(priorChat?.[0]?.chat_count ?? 0),
          chatAvgHandleSecs:  priorChat?.[0]?.avg_handle != null ? Number(priorChat[0].avg_handle) : null,
          chatAvgWaitSecs:    priorChat?.[0]?.avg_wait   != null ? Number(priorChat[0].avg_wait)   : null,
          chatProductivitySecs: priorChatProd?.[0]?.avg_secs  != null ? Number(priorChatProd[0].avg_secs)  : null,
          avgResponseHrs:       priorAvgResp?.[0]?.avg_hrs   != null ? Number(priorAvgResp[0].avg_hrs)    : null,
          instascore: weightedInstascore(
            (priorInsta ?? []).map(r => ({ category: r.CATEGORY, score: Number(r.avg_pct ?? 0) }))
          ),
          emailSentCount:       Number(priorEmail?.[0]?.cnt ?? 0),
        };
      })() : null,
      sfChats: (() => {
        const seen = new Set();
        return (sfChatRows ?? []).filter(r => {
          if (seen.has(r.session_id)) return false;
          seen.add(r.session_id);
          return true;
        });
      })().map(r => ({
        sessionId:        r.session_id,
        startTime:        r.chat_start_time,
        acceptTime:       r.agent_accept_time,
        endTime:          r.chat_end_time,
        durationSecs:     r.duration_seconds != null ? Number(r.duration_seconds) : null,
        waitSecs:         r.wait_seconds     != null ? Number(r.wait_seconds)     : null,
        customerEmail:    r.customer_email ?? null,
        ticketId:         r.ticket_id ?? null,
        companyId:        r.company_id ?? null,
        issueType:        r.ticket_issue_type ?? null,
        companyAgeBucket: r.company_age_bucket ?? null,
        paying:           r.paying != null ? Number(r.paying) : null,
      })),
      emailStats: {
        sentCount: Number(emailCountRow?.[0]?.cnt ?? 0),
      },
      emailsSource: emailsResult.source,  // 'merged' | 'enriched' | 'legacy' | 'none'
      emailsError:  emailsResult.error,
      emails: (emailRows ?? []).map(r => ({
        id:           r.Id,
        subject:      r.Subject ?? null,
        completedAt:  r.CompletedDateTime,
        status:       r.Status,
        caseId:       r.case_id ?? null,
        caseNumber:   r.case_number ?? null,
        caseSubject:  r.case_subject ?? null,
      })),
      taskStats: {
        totalCount: Number(taskCountRow?.[0]?.cnt ?? 0),
      },
      tasksSource: tasksResult.source,   // 'merged' | 'enriched' | 'legacy' | 'none'
      tasksError:  tasksResult.error,    // null unless every source failed
      tasks: (taskRows ?? []).map(r => ({
        id:             r.Id,
        subtype:        r.TaskSubtype ?? null,
        subject:        r.Subject ?? null,
        body:           r.Description ?? null,
        recipientName:  r.recipient_name ?? null,
        recipientEmail: r.recipient_email ?? null,
        completedAt:    r.CompletedDateTime,
        status:         r.Status,
      })),
    });
  } catch (err) {
    console.error('❌ [rep-detail]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/rep-email-tasks ──────────────────────────────────────────────────
// Every email-subtype completed task for the rep over the selected timeframe (NO row cap),
// with recipient columns — backs the "Download Emails CSV" export. Excludes the message body.
app.get('/api/rep-email-tasks', cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });
  try {
    const result = await fetchCompletedTasks({
      ownerId, period, startDate, endDate,
      emailOnly: true, shape: 'recipient', cap: null,   // cap:null → whole timeframe
      status: normalizeTaskStatus(req.query.taskStatus),
    });
    res.json({
      source: result.source,
      emails: (result.rows ?? []).map(r => ({
        completedAt:    r.CompletedDateTime,
        subtype:        r.TaskSubtype ?? null,
        subject:        r.Subject ?? null,
        recipientName:  r.recipient_name ?? null,
        recipientEmail: r.recipient_email ?? null,
      })),
    });
  } catch (err) {
    console.error('❌ [rep-email-tasks]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/rep-productivity-hourly ──────────────────────────────────────────
app.get('/api/rep-productivity-hourly', cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });

  const sf = statusDateFilter(period, startDate, endDate);
  try {
    const rows = await query(
      `SELECT hour_of_day, status, AVG(daily_secs) AS avg_secs
       FROM (
         SELECT DATE(dsu.status_start_at)  AS day,
                HOUR(dsu.status_start_at)  AS hour_of_day,
                dsu.status,
                SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS daily_secs
         FROM ${TD_STATUS} dsu
         WHERE LOWER(dsu.user_name) = (
           SELECT LOWER(cu.name) FROM ${USER} cu WHERE cu.id = '${ownerId}' AND cu.is_current = true LIMIT 1
         ) AND ${sf}
           AND LOWER(dsu.status) != 'offline'
         GROUP BY DATE(dsu.status_start_at), HOUR(dsu.status_start_at), dsu.status
       ) sub
       GROUP BY hour_of_day, status
       ORDER BY hour_of_day, status`
    );
    res.json({
      hourly: rows.map(r => ({
        hour:    Number(r.hour_of_day),
        status:  r.status,
        avgSecs: Number(r.avg_secs ?? 0),
      })),
    });
  } catch (err) {
    console.error('❌ [rep-productivity-hourly]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/rep-productivity-weekly ──────────────────────────────────────────
app.get('/api/rep-productivity-weekly', cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });

  const sf = statusDateFilter(period, startDate, endDate);
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(DATE_TRUNC('WEEK', dsu.status_start_at), 'yyyy-MM-dd') AS week_start,
              dsu.status,
              SUM(UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at)) AS total_secs
       FROM ${TD_STATUS} dsu
       WHERE LOWER(dsu.user_name) = (
         SELECT LOWER(cu.name) FROM ${USER} cu WHERE cu.id = '${ownerId}' AND cu.is_current = true LIMIT 1
       ) AND ${sf}
         AND LOWER(dsu.status) != 'offline'
       GROUP BY DATE_TRUNC('WEEK', dsu.status_start_at), dsu.status
       ORDER BY week_start, status`
    );
    res.json({
      weekly: rows.map(r => ({
        weekStart: r.week_start,
        status:    r.status,
        totalSecs: Number(r.total_secs ?? 0),
      })),
    });
  } catch (err) {
    console.error('❌ [rep-productivity-weekly]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/rep-status-instances ─────────────────────────────────────────────
// Every individual Talkdesk status segment for a rep over the period, with times
// resolved to US Central so the UI can group them per day exactly like Talkdesk.
app.get('/api/rep-status-instances', cacheRoute(CACHE_TTL_MS), async (req, res) => {
  const { ownerId, period = 'week', startDate, endDate } = req.query;
  if (!ownerId || !SFID_RE.test(ownerId))
    return res.status(400).json({ error: 'valid ownerId required' });

  const sf = statusLocalDateFilter(period, startDate, endDate);
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(from_utc_timestamp(dsu.status_start_at, 'America/Chicago'), 'yyyy-MM-dd') AS day,
              dsu.status,
              DATE_FORMAT(from_utc_timestamp(dsu.status_start_at, 'America/Chicago'), 'h:mm a')    AS start_local,
              DATE_FORMAT(from_utc_timestamp(dsu.status_end_at,   'America/Chicago'), 'h:mm a')    AS end_local,
              (UNIX_TIMESTAMP(dsu.status_end_at) - UNIX_TIMESTAMP(dsu.status_start_at))             AS duration_secs
       FROM ${TD_STATUS} dsu
       WHERE LOWER(dsu.user_name) = (
         SELECT LOWER(cu.name) FROM ${USER} cu WHERE cu.id = '${ownerId}' AND cu.is_current = true LIMIT 1
       ) AND ${sf}
         AND LOWER(dsu.status) != 'offline'
       ORDER BY dsu.status_start_at
       LIMIT 5000`
    );
    res.json({
      instances: rows.map(r => ({
        day:          r.day,
        status:       r.status,
        startLocal:   r.start_local,
        endLocal:     r.end_local,
        durationSecs: Number(r.duration_secs ?? 0),
        clockedOut:   String(r.status ?? '').trim().toLowerCase() === 'offline'
                      && Number(r.duration_secs ?? 0) > CLOCKOUT_THRESHOLD_SECS,
      })),
    });
  } catch (err) {
    console.error('❌ [rep-status-instances]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/cases-data ────────────────────────────────────────────────────────
app.get("/api/cases-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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
app.get("/api/volume-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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
app.get("/api/sla-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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
app.get("/api/resolution-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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
app.get("/api/manager-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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
app.get("/api/channels-data", cacheRoute(CACHE_TTL_MS), async (req, res) => {
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

app.get('/api/diagnostics/messaging-schema', async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM ${SRC_MESSAGING} LIMIT 1`);
    res.json({ columns: rows.length ? Object.keys(rows[0]) : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/diagnostics/mrr-name', async (req, res) => {
  const { name = 'shakil' } = req.query;
  const like = `%${name.toLowerCase()}%`;
  try {
    const [userRows, upgradeRows] = await Promise.all([
      query(`SELECT id, name, email FROM ${USER} WHERE LOWER(name) LIKE '${like}' AND is_current = true`),
      query(`SELECT DISTINCT agent_name, COUNT(*) AS upgrade_count, SUM(net_price_change) AS mrr_total
             FROM ${UPGRADES}
             WHERE LOWER(agent_name) LIKE '${like}'
             GROUP BY agent_name ORDER BY agent_name`),
    ]);
    res.json({ users: userRows, upgrades: upgradeRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── Homie Contest CMS ──────────────────────────────────────────────────────────
const CONTEST_FILE      = path.resolve(__dirname, 'contest.json');
const DBFS_CONTEST_PATH = '/FileStore/rep_dashboard/contest_state.json';

const HOUSE_COLORS     = { Grind: 'red', Reign: 'blue', Legacy: 'purple' };
const VALID_HOUSES     = new Set(['Grind', 'Reign', 'Legacy']);
const VALID_BONUS_TYPES = new Set(['bounty_win', 'fortress', 'daily_raid', 'discretionary', 'weekly_battle']);
const DATE_RE          = /^\d{4}-\d{2}-\d{2}$/;

const WEEK_RANGES = {
  '1': { start: '2026-05-04', end: '2026-05-09', section: 'OYI',        prize: 'Boba run' },
  '2': { start: '2026-05-11', end: '2026-05-16', section: 'OYI',        prize: 'WFH Monday May 19' },
  '3': { start: '2026-05-18', end: '2026-05-23', section: 'BCO',        prize: 'Movie tickets' },
  '4': { start: '2026-05-26', end: '2026-05-29', section: 'In Service', prize: '$25 GC per rep' },
};

async function readContest() {
  try {
    const token = await getDbToken();
    const host  = process.env.DATABRICKS_HOST;
    const resp  = await fetch(
      `https://${host}/api/2.0/dbfs/read?path=${encodeURIComponent(DBFS_CONTEST_PATH)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.ok) {
      const { data } = await resp.json();
      return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    }
  } catch (e) {
    console.warn('[contest] DBFS read failed, falling back to local file:', e.message);
  }
  try {
    return JSON.parse(fs.readFileSync(CONTEST_FILE, 'utf8'));
  } catch { return { reps: {}, houses: {}, weeklyBattles: {}, goals: {} }; }
}

async function writeContest(data) {
  const token   = await getDbToken();
  const host    = process.env.DATABRICKS_HOST;
  const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const resp = await fetch(`https://${host}/api/2.0/dbfs/put`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path: DBFS_CONTEST_PATH, contents: encoded, overwrite: true }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[contest] DBFS write failed: ${resp.status} ${text}`);
  }
}

async function initContestFile() {
  try {
    const token = await getDbToken();
    const host  = process.env.DATABRICKS_HOST;
    const check = await fetch(
      `https://${host}/api/2.0/dbfs/read?path=${encodeURIComponent(DBFS_CONTEST_PATH)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!check.ok) {
      console.log('[contest] DBFS file not found — seeding from local contest.json');
      const seed = JSON.parse(fs.readFileSync(CONTEST_FILE, 'utf8'));
      await writeContest(seed);
    }
    console.log('[contest] DBFS file ready:', DBFS_CONTEST_PATH);
  } catch (e) {
    console.warn('[contest] DBFS init failed — falling back to local file:', e.message);
  }
}

// Mutex: serializes all contest read-modify-write operations
let _contestLock = Promise.resolve();
function withLock(fn) {
  const p = _contestLock.then(fn);
  _contestLock = p.then(() => {}, () => {});
  return p;
}

function requirePin(req, res, next) {
  const pin = req.headers['x-contest-pin'];
  if (!pin || pin !== '9090') {
    return res.status(401).json({ error: 'invalid or missing PIN' });
  }
  next();
}

// ── Point calculation ──────────────────────────────────────────────────────────
const ZERO_PTS = { attendance: 0, productivity: 0, instascore: 0, upgrades: 0, addons: 0, total: 0 };

function calcDayPoints(day) {
  if (!day?.attended) return { ...ZERO_PTS };
  const attendance   = day.onTime ? 1 : 0;
  const productivity = (day.productivityPct ?? 0) >= 75 ? 5 : 0;
  let instascore = 0;
  if ((day.instascoreConvos ?? 0) >= 5) {
    const pct = day.instascorePct ?? 0;
    if (pct >= 80)      instascore = 3;
    else if (pct >= 70) instascore = 2;
  }
  const upgrades =
    (day.upgrades?.anyToEssentials  ?? 0) * 1 +
    (day.upgrades?.essentialsToPlus ?? 0) * 2 +
    (day.upgrades?.essentialsToAio  ?? 0) * 4 +
    (day.upgrades?.plusToAio        ?? 0) * 2 +
    (day.upgrades?.basicToPlus      ?? 0) * 3 +
    (day.upgrades?.basicToAio       ?? 0) * 5;
  const addons =
    (day.addons?.hourlyPay    ?? 0) * 1 +
    (day.addons?.payrollPass  ?? 0) * 2;
  return { attendance, productivity, instascore, upgrades, addons,
           total: attendance + productivity + instascore + upgrades + addons };
}

// Returns { productivityBonus, attendanceBonus } for a house on a specific date.
// Requires ALL house members to have a day entry before awarding any bonus —
// missing data means Lilly hasn't entered it yet, so we can't confirm the house qualified.
function calcHouseDayBonus(houseName, date, allReps) {
  const members = Object.entries(allReps).filter(([, r]) => r.house === houseName);
  const total   = members.length;
  if (!total) return { productivityBonus: 0, attendanceBonus: 0 };
  const days = members.map(([, r]) => r.days?.[date]);
  if (days.some(d => d === undefined)) return { productivityBonus: 0, attendanceBonus: 0 };
  const attended = days.filter(d => d?.attended);
  const allProd  = attended.length > 0 && attended.every(d => (d.productivityPct ?? 0) >= 75);
  const attRate  = attended.length / total;
  return {
    productivityBonus: allProd ? 1 : 0,
    attendanceBonus:   attRate >= 0.9 ? 1 : 0,
  };
}

function computeStandings(data) {
  // Pre-compute house daily bonuses for every date that appears in any rep's days
  const allDates = new Set(
    Object.values(data.reps).flatMap(r => Object.keys(r.days ?? {}))
  );
  const houseDayBonus = {};
  for (const house of ['Grind', 'Reign', 'Legacy']) {
    houseDayBonus[house] = {};
    for (const date of allDates) {
      houseDayBonus[house][date] = calcHouseDayBonus(house, date, data.reps);
    }
  }

  const repRows = Object.entries(data.reps).map(([name, r]) => {
    const bd = { attendance: 0, productivity: 0, instascore: 0, upgrades: 0, addons: 0, houseBonus: 0, manual: 0 };
    for (const [date, day] of Object.entries(r.days ?? {})) {
      const pts = calcDayPoints(day);
      bd.attendance   += pts.attendance;
      bd.productivity += pts.productivity;
      bd.instascore   += pts.instascore;
      bd.upgrades     += pts.upgrades;
      bd.addons       += pts.addons;
      if (day.attended) {
        const hb = houseDayBonus[r.house]?.[date] ?? {};
        bd.houseBonus += (hb.productivityBonus ?? 0) + (hb.attendanceBonus ?? 0);
      }
    }
    bd.manual = (r.bonuses ?? []).reduce((s, b) => s + (b.amount ?? 0), 0);
    const total = bd.attendance + bd.productivity + bd.instascore + bd.upgrades + bd.addons + bd.houseBonus + bd.manual;
    return { name, house: r.house, breakdown: bd, total, bonuses: r.bonuses ?? [] };
  });

  const houseRows = Object.entries(data.houses).map(([name, h]) => {
    const repTotal   = repRows.filter(r => r.house === name).reduce((s, r) => s + r.total, 0);
    const bonusTotal = (h.bonuses ?? []).reduce((s, b) => s + (b.amount ?? 0), 0);
    return { name, color: HOUSE_COLORS[name] ?? 'gray', repTotal, bonusTotal, grandTotal: repTotal + bonusTotal, bonuses: h.bonuses ?? [] };
  });

  return { reps: repRows, houses: houseRows };
}

// ── Weekly battle helpers ──────────────────────────────────────────────────────
function getWeeklyStats(data, week) {
  const range = WEEK_RANGES[week];
  if (!range) return null;
  const mrrGoals = data.goals?.mrr ?? {};
  const houses   = ['Grind', 'Reign', 'Legacy'];

  const houseStats = {};
  for (const house of houses) {
    const members = Object.entries(data.reps).filter(([, r]) => r.house === house);
    const memberStats = members.map(([name, r]) => {
      const weekDays  = Object.entries(r.days ?? {})
        .filter(([d]) => d >= range.start && d <= range.end)
        .map(([, day]) => day);
      const attended   = weekDays.filter(d => d?.attended);
      const mrrGoal    = mrrGoals[name] ?? mrrGoals.default ?? 1500;
      const totalMrr   = attended.reduce((s, d) => s + (d.mrrDollars ?? 0), 0);
      const mrrPct     = mrrGoal > 0 ? (totalMrr / mrrGoal) * 100 : 0;
      const avgProd    = attended.length ? attended.reduce((s, d) => s + (d.productivityPct ?? 0), 0) / attended.length : 0;
      const instaDays  = attended.filter(d => (d.instascoreConvos ?? 0) >= 5);
      const avgInsta   = instaDays.length ? instaDays.reduce((s, d) => s + (d.instascorePct ?? 0), 0) / instaDays.length : 0;
      const attRate    = weekDays.length ? attended.length / weekDays.length : 0;
      return { name, mrrPct, avgProd, avgInsta, attRate };
    });
    const n = memberStats.length || 1;
    houseStats[house] = {
      members: memberStats,
      avgMrrPct:  memberStats.reduce((s, m) => s + m.mrrPct,  0) / n,
      avgProd:    memberStats.reduce((s, m) => s + m.avgProd,  0) / n,
      avgInsta:   memberStats.reduce((s, m) => s + m.avgInsta, 0) / n,
      avgAtt:     memberStats.reduce((s, m) => s + m.attRate,  0) / n,
    };
  }

  const rank = (key) => [...houses].sort((a, b) => houseStats[b][key] - houseStats[a][key]);
  const attQualifiers = houses.filter(h => houseStats[h].avgAtt >= 0.95);
  const attRanked = attQualifiers.length ? attQualifiers.sort((a, b) => houseStats[b].avgAtt - houseStats[a].avgAtt) : rank('avgAtt');

  // Weekly KP, fortress %, and attendance % per house
  const weeklyKp = {}, fortressPcts = {}, attendancePcts = {};
  for (const house of houses) {
    const members = Object.entries(data.reps).filter(([, r]) => r.house === house);
    let kp = 0;
    const fortVals = [], totalDays = { n: 0 }, attendedDays = { n: 0 };
    for (const [name, r] of members) {
      for (const [date, day] of Object.entries(r.days ?? {})) {
        if (date < range.start || date > range.end) continue;
        const pts = calcDayPoints(day);
        kp += pts.total;
        if (day.attended) {
          const hb = calcHouseDayBonus(house, date, data.reps);
          kp += (hb.productivityBonus ?? 0) + (hb.attendanceBonus ?? 0);
        }
        totalDays.n++;
        if (day.attended) attendedDays.n++;
        if (day.fortressPct != null) fortVals.push(day.fortressPct);
      }
      for (const bonus of r.bonuses ?? []) {
        if (bonus.date >= range.start && bonus.date <= range.end) kp += bonus.amount ?? 0;
      }
    }
    weeklyKp[house] = kp;
    fortressPcts[house] = fortVals.length ? Math.round(fortVals.reduce((s, v) => s + v, 0) / fortVals.length) : null;
    attendancePcts[house] = totalDays.n ? Math.round((attendedDays.n / totalDays.n) * 100) : null;
  }

  return {
    week, ...range, houseStats,
    weeklyKp, fortress: fortressPcts, attendance: attendancePcts,
    winners: {
      goldRush:     rank('avgMrrPct')[0],
      hustleSprint: rank('avgProd')[0],
      sharpshooter: rank('avgInsta')[0],
      attendance:   attRanked[0],
    },
    awarded: data.weeklyBattles?.[week]?.awarded ?? false,
    fortressWinner: data.weeklyBattles?.[week]?.fortress ?? null,
  };
}

// ── Daily Raid auto-detection ──────────────────────────────────────────────────
function detectDailyRaid(reps) {
  const dates = [...new Set(Object.values(reps).flatMap(r => Object.keys(r.days ?? {})))].sort();
  const latest = dates[dates.length - 1];
  if (!latest) return null;
  const entries = Object.entries(reps)
    .map(([name, r]) => ({ name, house: r.house, day: r.days[latest] }))
    .filter(e => e.day?.attended);
  if (!entries.length) return null;
  const best = (arr, fn) => arr.reduce((a, b) => fn(b) > fn(a) ? b : a, arr[0]);
  const sharpCandidates = entries.filter(e => (e.day.instascoreConvos ?? 0) >= 5);
  return {
    date: latest,
    mrr:    { name: best(entries, e => e.day.mrrDollars ?? 0).name,      house: best(entries, e => e.day.mrrDollars ?? 0).house,      value: `$${best(entries, e => e.day.mrrDollars ?? 0).day.mrrDollars}` },
    hustle: { name: best(entries, e => e.day.productivityPct ?? 0).name,  house: best(entries, e => e.day.productivityPct ?? 0).house,  value: `${best(entries, e => e.day.productivityPct ?? 0).day.productivityPct}%` },
    sharp:  sharpCandidates.length ? { name: best(sharpCandidates, e => e.day.instascorePct ?? 0).name, house: best(sharpCandidates, e => e.day.instascorePct ?? 0).house, value: `${best(sharpCandidates, e => e.day.instascorePct ?? 0).day.instascorePct}%` } : null,
  };
}

// ── Contest routes ─────────────────────────────────────────────────────────────

app.post('/api/contest/verify-pin', requirePin, (_req, res) => res.json({ ok: true }));

// Import contest data from CSV
app.post('/api/contest/import', requirePin, async (req, res) => {
  const { csv } = req.body ?? {};
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

  const data = await readContest();
  let imported = 0, skipped = 0;
  const errors = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    if (cols.length < 18) { skipped++; continue; }
    const [name, , date, attended, onTime, prodPct, instaPct, convos, mrr, fortressPct,
           anyToEss, essToPlus, essToAio, plusToAio, basicToPlus, basicToAio,
           hourlyPay, payrollPass] = cols;
    if (!data.reps[name?.trim()]) { errors.push(`Rep not found: ${name}`); skipped++; continue; }
    if (!DATE_RE.test(date?.trim())) { errors.push(`Invalid date: ${date}`); skipped++; continue; }
    const repName = name.trim();
    data.reps[repName].days = data.reps[repName].days ?? {};
    data.reps[repName].days[date.trim()] = {
      attended: attended?.trim() === 'Yes',
      onTime:   onTime?.trim()   === 'Yes',
      productivityPct:  Number(prodPct)  || 0,
      instascorePct:    Number(instaPct) || 0,
      instascoreConvos: Number(convos)   || 0,
      mrrDollars:       Number(mrr)      || 0,
      fortressPct: fortressPct?.trim() === '' ? null : (Number(fortressPct) || null),
      upgrades: {
        anyToEssentials:  Number(anyToEss)    || 0,
        essentialsToPlus: Number(essToPlus)   || 0,
        essentialsToAio:  Number(essToAio)    || 0,
        plusToAio:        Number(plusToAio)   || 0,
        basicToPlus:      Number(basicToPlus) || 0,
        basicToAio:       Number(basicToAio)  || 0,
      },
      addons: {
        hourlyPay:   Number(hourlyPay)   || 0,
        payrollPass: Number(payrollPass) || 0,
      },
    };
    imported++;
  }

  if (imported > 0) await writeContest(data);
  res.json({ ok: true, imported, skipped, errors });
});

// Reset contest data to the bundled contest.json (clean slate)
app.post('/api/contest/reset', requirePin, async (req, res) => {
  try {
    const seed = JSON.parse(fs.readFileSync(CONTEST_FILE, 'utf8'));
    await writeContest(seed);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [contest/reset]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export contest data as CSV for a date range
app.get('/api/contest/export', requirePin, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end))
    return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });
  const data = await readContest();
  const rows = [];
  for (const [name, rep] of Object.entries(data.reps)) {
    for (const [date, day] of Object.entries(rep.days ?? {})) {
      if (date < start || date > end) continue;
      const pts = calcDayPoints(day);
      rows.push([
        name, rep.house, date,
        day.attended ? 'Yes' : 'No',
        day.onTime   ? 'Yes' : 'No',
        day.productivityPct  ?? 0,
        day.instascorePct    ?? 0,
        day.instascoreConvos ?? 0,
        day.mrrDollars       ?? 0,
        day.fortressPct      ?? '',
        day.upgrades?.anyToEssentials  ?? 0,
        day.upgrades?.essentialsToPlus ?? 0,
        day.upgrades?.essentialsToAio  ?? 0,
        day.upgrades?.plusToAio        ?? 0,
        day.upgrades?.basicToPlus      ?? 0,
        day.upgrades?.basicToAio       ?? 0,
        day.addons?.hourlyPay   ?? 0,
        day.addons?.payrollPass ?? 0,
        pts.total,
      ]);
    }
  }
  rows.sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]));
  const header = 'Rep,House,Date,Attended,OnTime,Prod%,Insta%,Convos,MRR$,Fortress%,AnyToEssentials,EssToPlus,EssToAIO,PlusToAIO,BasicToPlus,BasicToAIO,HourlyPay,PayrollPass,DayKP';
  const csv = [header, ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="homie-hustlers-${start}-to-${end}.csv"`);
  res.send(csv);
});

app.get('/api/contest', async (_req, res) => {
  try {
    const data = await readContest();
    const standings = computeStandings(data);
    standings.dailyRaid = detectDailyRaid(data.reps);
    res.json(standings);
  }
  catch (err) { console.error('❌ [contest]', err.message); res.status(500).json({ error: err.message }); }
});

// Save a rep's daily raw entry
app.put('/api/contest/reps/:name/days/:date', requirePin, async (req, res) => {
  const { name, date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const pts = await withLock(async () => {
      const data = await readContest();
      if (!data.reps[name]) { const e = new Error('rep not found'); e.status = 404; throw e; }
      data.reps[name].days = data.reps[name].days ?? {};
      data.reps[name].days[date] = req.body ?? {};
      await writeContest(data);
      return calcDayPoints(req.body ?? {});
    });
    res.json({ ok: true, points: pts });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Get a rep's daily entry (for pre-filling the CMS form)
app.get('/api/contest/reps/:name/days/:date', requirePin, async (req, res) => {
  const { name, date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const data = await readContest();
  if (!data.reps[name]) return res.status(404).json({ error: 'rep not found' });
  res.json(data.reps[name].days?.[date] ?? null);
});

// Get weekly house averages + auto-detected battle winners (public — no PIN needed)
app.get('/api/contest/weekly/:week', async (req, res) => {
  const { week } = req.params;
  if (!WEEK_RANGES[week]) return res.status(400).json({ error: 'week must be 1–4' });
  res.json(getWeeklyStats(await readContest(), week));
});

// Award weekly battles: adds +5 pt rep bonus for each battle winner's house members
app.post('/api/contest/weekly/:week/award', requirePin, async (req, res) => {
  const { week } = req.params;
  if (!WEEK_RANGES[week]) return res.status(400).json({ error: 'week must be 1–4' });
  try {
    const awarded = await withLock(async () => {
      const data  = await readContest();
      const stats = getWeeklyStats(data, week);
      if (data.weeklyBattles[week]?.awarded) { const e = new Error('week already awarded'); e.status = 400; throw e; }
      const battleNames = { goldRush: 'Gold Rush', hustleSprint: 'Hustle Sprint', sharpshooter: 'Sharpshooter', attendance: 'Attendance' };
      const awarded = [];
      for (const [battle, label] of Object.entries(battleNames)) {
        const winnerHouse = stats.winners[battle];
        if (!winnerHouse) continue;
        for (const [repName, r] of Object.entries(data.reps)) {
          if (r.house !== winnerHouse) continue;
          const bonus = { id: String(Date.now() + Math.random()), type: 'weekly_battle', amount: 5,
                          note: `Week ${week} ${label} — House ${winnerHouse} wins`, date: new Date().toISOString().slice(0, 10) };
          r.bonuses = r.bonuses ?? [];
          r.bonuses.push(bonus);
          awarded.push({ rep: repName, battle, bonus });
        }
      }
      data.weeklyBattles[week] = { ...(data.weeklyBattles[week] ?? {}), ...stats.winners, awarded: true };
      await writeContest(data);
      return awarded;
    });
    res.json({ ok: true, awarded });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Revoke weekly battle award: removes all weekly_battle bonuses for this week from all reps
app.delete('/api/contest/weekly/:week/award', requirePin, async (req, res) => {
  const { week } = req.params;
  if (!WEEK_RANGES[week]) return res.status(400).json({ error: 'week must be 1–4' });
  try {
    const removed = await withLock(async () => {
      const data = await readContest();
      const prefix = `Week ${week} `;
      let removed = 0;
      for (const r of Object.values(data.reps)) {
        const before = (r.bonuses ?? []).length;
        r.bonuses = (r.bonuses ?? []).filter(b => !(b.type === 'weekly_battle' && (b.note ?? '').startsWith(prefix)));
        removed += before - r.bonuses.length;
      }
      data.weeklyBattles[week] = { goldRush: null, hustleSprint: null, sharpshooter: null, attendance: null, fortress: data.weeklyBattles[week]?.fortress ?? null, awarded: false };
      await writeContest(data);
      return removed;
    });
    res.json({ ok: true, removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Record fortress winner (prize tracking only — no KP)
app.put('/api/contest/weekly/:week/fortress', requirePin, async (req, res) => {
  const { week } = req.params;
  if (!WEEK_RANGES[week]) return res.status(400).json({ error: 'week must be 1–4' });
  const { winner } = req.body ?? {};
  if (winner && !VALID_HOUSES.has(winner)) return res.status(400).json({ error: 'invalid house' });
  try {
    await withLock(async () => {
      const data = await readContest();
      data.weeklyBattles[week] = { ...(data.weeklyBattles[week] ?? {}), fortress: winner ?? null };
      await writeContest(data);
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a bonus to a rep
app.post('/api/contest/reps/:name/bonuses', requirePin, async (req, res) => {
  const { name } = req.params;
  const { type, amount, note, date } = req.body ?? {};
  if (!VALID_BONUS_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...VALID_BONUS_TYPES].join(', ')}` });
  if (typeof amount !== 'number' || !isFinite(amount)) return res.status(400).json({ error: 'amount must be a finite number' });
  try {
    const bonus = await withLock(async () => {
      const data = await readContest();
      if (!data.reps[name]) { const e = new Error('rep not found'); e.status = 404; throw e; }
      const bonus = { id: String(Date.now()), type, amount, note: note ?? '', date: date ?? new Date().toISOString().slice(0, 10) };
      data.reps[name].bonuses.push(bonus);
      await writeContest(data);
      return bonus;
    });
    res.json({ ok: true, bonus });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Remove a bonus from a rep
app.delete('/api/contest/reps/:name/bonuses/:id', requirePin, async (req, res) => {
  const { name, id } = req.params;
  try {
    await withLock(async () => {
      const data = await readContest();
      if (!data.reps[name]) { const e = new Error('rep not found'); e.status = 404; throw e; }
      const before = data.reps[name].bonuses.length;
      data.reps[name].bonuses = data.reps[name].bonuses.filter(b => b.id !== id);
      if (data.reps[name].bonuses.length === before) { const e = new Error('bonus not found'); e.status = 404; throw e; }
      await writeContest(data);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Add a bonus to a house
app.post('/api/contest/houses/:name/bonuses', requirePin, async (req, res) => {
  const { name } = req.params;
  if (!VALID_HOUSES.has(name)) return res.status(404).json({ error: 'house not found' });
  const { type, amount, note, date } = req.body ?? {};
  if (!VALID_BONUS_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...VALID_BONUS_TYPES].join(', ')}` });
  if (typeof amount !== 'number' || !isFinite(amount)) return res.status(400).json({ error: 'amount must be a finite number' });
  try {
    const bonus = await withLock(async () => {
      const data = await readContest();
      const bonus = { id: String(Date.now()), type, amount, note: note ?? '', date: date ?? new Date().toISOString().slice(0, 10) };
      data.houses[name].bonuses.push(bonus);
      await writeContest(data);
      return bonus;
    });
    res.json({ ok: true, bonus });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Remove a bonus from a house
app.delete('/api/contest/houses/:name/bonuses/:id', requirePin, async (req, res) => {
  const { name, id } = req.params;
  if (!VALID_HOUSES.has(name)) return res.status(404).json({ error: 'house not found' });
  try {
    await withLock(async () => {
      const data = await readContest();
      const before = data.houses[name].bonuses.length;
      data.houses[name].bonuses = data.houses[name].bonuses.filter(b => b.id !== id);
      if (data.houses[name].bonuses.length === before) { const e = new Error('bonus not found'); e.status = 404; throw e; }
      await writeContest(data);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// ── Catch-all: serve index.html for client-side routing (production only) ──────
if (!isDev) {
  app.get("*", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../dist/index.html"));
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────
initContestFile();
const server = app.listen(PORT, () => {
  console.log(`🚀 Rep Dashboard server running on http://localhost:${PORT}`);
});
// Reclaim stuck sockets so a hung request can't tie up a connection indefinitely. Kept ABOVE the
// Databricks query timeout (default 90s) so the query gives up first and the client gets a clean
// 500, rather than the socket dying out from under an in-progress (e.g. cold-start) query.
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS) || 120_000;
server.headersTimeout = server.requestTimeout + 5_000;
