/**
 * Parse /api/manager-data into the shape used by ManagerScorecard.jsx.
 *
 * Returns:
 *   managers[] — per-manager aggregate stats + reps[]
 *   reps[]     — flat list of all reps with per-rep metrics
 *
 * Fields not available in this SF org (WFM) are returned as 0:
 *   availPct, prodTimePct, fcrPct, escalationRate
 */
export function parseManagerData(raw) {
  if (!raw) return null;

  const { openByStatus, closedWeek, avgResponse, csatData, userInfo } = raw;

  // ── User lookup: id → { name, team } ────────────────────────────────────────
  const userMeta = {};
  for (const u of userInfo?.records ?? []) {
    userMeta[u.Id] = {
      name: u.Name,
      team: u.UserRole?.Name ?? u.Department ?? '—',
    };
  }

  // ── Open cases by rep+status → holdCases, openCases ─────────────────────────
  const repOpenMap = {};
  for (const r of openByStatus?.records ?? []) {
    const id = r.OwnerId;
    if (!repOpenMap[id]) repOpenMap[id] = { name: r.Name, openCases: 0, holdCases: 0 };
    repOpenMap[id].openCases += r.cnt ?? 0;
    if (r.Status === 'On Hold') repOpenMap[id].holdCases += r.cnt ?? 0;
  }

  // ── Closed this week per rep ──────────────────────────────────────────────────
  const closedWeekMap = {};
  for (const r of closedWeek?.records ?? []) closedWeekMap[r.OwnerId] = r.cnt ?? 0;

  // ── Avg response hours per rep ────────────────────────────────────────────────
  const avgRespMap = {};
  for (const r of avgResponse?.records ?? []) {
    avgRespMap[r.OwnerId] = r.avgRespHrs != null ? parseFloat(r.avgRespHrs.toFixed(2)) : 0;
  }

  // ── CSAT instascore per rep ───────────────────────────────────────────────────
  const csatBuckets = {};
  for (const r of csatData?.records ?? []) {
    const score = parseFloat(r.Satisfaction_Score__c);
    if (!isNaN(score)) {
      if (!csatBuckets[r.OwnerId]) csatBuckets[r.OwnerId] = [];
      csatBuckets[r.OwnerId].push(score);
    }
  }
  const instaMap = {};
  for (const [id, scores] of Object.entries(csatBuckets)) {
    instaMap[id] = parseFloat((scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2));
  }

  // ── Build flat reps array ─────────────────────────────────────────────────────
  // Seed from userInfo so reps with zero activity still appear in the list
  const allIds = new Set([
    ...Object.keys(userMeta),
    ...Object.keys(repOpenMap),
    ...Object.keys(closedWeekMap),
    ...Object.keys(avgRespMap),
  ]);

  const reps = [];
  for (const id of allIds) {
    const meta = userMeta[id] ?? {};
    reps.push({
      id,
      name:           repOpenMap[id]?.name ?? meta.name ?? '—',
      team:           meta.team ?? '—',
      openCases:      repOpenMap[id]?.openCases  ?? 0,
      holdCases:      repOpenMap[id]?.holdCases  ?? 0,
      closedWeek:     closedWeekMap[id]          ?? 0,
      avgResponseHrs: avgRespMap[id]             ?? 0,
      instascore:     instaMap[id]               ?? 0,
      // WFM metrics — not available in this SF org
      prodTimePct:    0,
      availPct:       0,
      fcrPct:         0,
      escalationRate: 0,
    });
  }

  reps.sort((a, b) => a.name.localeCompare(b.name));

  return { reps };
}
