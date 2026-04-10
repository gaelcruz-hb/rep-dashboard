/**
 * Parse the /api/resolution-data response into shapes used by Resolution.jsx.
 *
 * Input shape:
 *   closedCases:  { records: [{ OwnerId, Owner.Name, CreatedDate, ClosedDate, IsEscalated, Reopens__c }] }
 *   createdByRep: { records: [{ OwnerId, Owner.Name, cnt }] }
 *   dailyCreated: { records: [{ day, cnt }] }
 *   dailyClosed:  { records: [{ day, cnt }] }
 *
 * Output:
 *   { reps, dailyLabels, dailyCreated, dailyClosed }
 */

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function parseResolutionData(raw, filterNames = null) {
  if (!raw) return null;

  const { closedCases, createdByRep, dailyCreated, dailyClosed } = raw;
  const now = Date.now();

  // ── Per-rep stats from closed cases ─────────────────────────────────────────
  const repMap = {};

  for (const c of (closedCases?.records ?? [])
      .filter(c => !filterNames || filterNames.has(c.Owner?.Name))) {
    const id = c.OwnerId;
    if (!repMap[id]) {
      repMap[id] = {
        name: c.Owner?.Name ?? 'Unknown',
        ttrHrs: [],
        closedWeek: 0,
        escalated: 0,
        reopenCount: 0,
        total: 0,
      };
    }

    // TTR: compute from dates (Time_to_Initial_Close_Hours__c is null in this org)
    if (c.ClosedDate && c.CreatedDate) {
      const ttr = (new Date(c.ClosedDate) - new Date(c.CreatedDate)) / 3600000;
      if (ttr > 0) repMap[id].ttrHrs.push(ttr);
    }

    repMap[id].total++;
    repMap[id].closedWeek++;
    if (c.IsEscalated) repMap[id].escalated++;
    if (c.Reopens__c > 0) repMap[id].reopenCount++;
  }

  // Created this week per rep
  const createdMap = {};
  for (const r of (createdByRep?.records ?? [])
      .filter(r => !filterNames || filterNames.has(r.Owner?.Name))) {
    createdMap[r.OwnerId] = r.cnt;
  }

  // Merge any reps who have created cases but no closed cases
  for (const r of (createdByRep?.records ?? [])
      .filter(r => !filterNames || filterNames.has(r.Owner?.Name))) {
    if (!repMap[r.OwnerId]) {
      repMap[r.OwnerId] = {
        name: r.Owner?.Name ?? 'Unknown',
        ttrHrs: [], closedWeek: 0, escalated: 0, reopenCount: 0, total: 0,
      };
    }
  }

  const reps = Object.entries(repMap).map(([id, rep]) => ({
    name:          rep.name,
    avgTTRHrs:     rep.ttrHrs.length > 0
      ? parseFloat((rep.ttrHrs.reduce((s, v) => s + v, 0) / rep.ttrHrs.length).toFixed(1))
      : 0,
    medianTTRHrs:  parseFloat(median(rep.ttrHrs).toFixed(1)),
    closedWeek:    rep.closedWeek,
    newCasesWeek:  createdMap[id] ?? 0,
    escalated:     rep.escalated,
    reopenedPct:   rep.total > 0
      ? parseFloat(((rep.reopenCount / rep.total) * 100).toFixed(1))
      : 0,
  }));

  // ── Daily trend: full 14-day array ──────────────────────────────────────────
  // When filterNames is active, recompute from closedCases records (has Owner.Name + dates).
  // Pre-aggregated dailyCreated/dailyClosed records have no owner info and cannot be filtered.
  const createdByDay = {};
  const closedByDay  = {};

  if (filterNames) {
    for (const c of (closedCases?.records ?? [])
        .filter(c => filterNames.has(c.Owner?.Name))) {
      if (c.CreatedDate) {
        const key = c.CreatedDate.slice(0, 10);
        createdByDay[key] = (createdByDay[key] ?? 0) + 1;
      }
      if (c.ClosedDate) {
        const key = c.ClosedDate.slice(0, 10);
        closedByDay[key] = (closedByDay[key] ?? 0) + 1;
      }
    }
  } else {
    for (const r of dailyCreated?.records ?? []) createdByDay[r.day] = r.cnt;
    for (const r of dailyClosed?.records ?? [])  closedByDay[r.day]  = r.cnt;
  }

  const labels        = [];
  const dailyCreatedArr = [];
  const dailyClosedArr  = [];

  for (let i = 13; i >= 0; i--) {
    const d   = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    dailyCreatedArr.push(createdByDay[key] ?? 0);
    dailyClosedArr.push(closedByDay[key] ?? 0);
  }

  return {
    reps: reps.sort((a, b) => a.name.localeCompare(b.name)),
    dailyLabels:   labels,
    dailyCreated:  dailyCreatedArr,
    dailyClosed:   dailyClosedArr,
  };
}
