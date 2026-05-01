/**
 * Parse a raw Salesforce SOQL response ({ records: [...] }) into the
 * per-rep shape expected by ResponseSLA.jsx.
 *
 * Fields used from each Case record:
 *   Id, CaseNumber, Subject, Status, OwnerId, Owner.Name,
 *   CreatedDate, SlaStartDate, Case_Response_Time_Hours__c
 *
 * SlaStartDate exists but SlaEndDate does not — slaPct uses LastModifiedDate
 * (last interaction) as the reference point for open cases with no respHrs.
 */

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function parseSlaData(raw, slaThresholdHrs = 24) {
  if (!raw?.records) return null;

  const now = Date.now();
  const repMap = {};

  for (const c of raw.records) {
    if (c.Owner?.Type === 'Queue') continue;

    const ownerId = c.OwnerId;
    if (!repMap[ownerId]) {
      repMap[ownerId] = {
        name: c.Owner?.Name ?? 'Unknown',
        cases: [],
        responseTimes: [],
      };
    }

    const ageDays          = Math.round((now - new Date(c.CreatedDate).getTime()) / 86400000);
    const lastActivityDays = c.LastModifiedDate
      ? Math.round((now - new Date(c.LastModifiedDate).getTime()) / 86400000)
      : null;
    // Hours since last interaction — used as the SLA clock for open cases with no recorded response time
    const lastActivityHrs  = c.LastModifiedDate
      ? (now - new Date(c.LastModifiedDate).getTime()) / 3600000
      : ageDays * 24;
    const respHrs          = c.Case_Response_Time_Hours__c ?? null;
    const isClosed         = c.IsClosed === true || c.Status === 'Closed';
    // Cases where the rep has reached out and is waiting on the client — not a breach
    const waitingOnClient  = !isClosed && (c.Status === 'Pending' || c.Status === 'On Hold');
    // Breach / risk: only flag cases with an actual recorded response time.
    // Null-response cases are excluded from KPIs and shown with a "No Response" tag instead.
    const isBreached = respHrs != null && !waitingOnClient && respHrs > slaThresholdHrs;
    const isAtRisk   = respHrs != null && !waitingOnClient && !isBreached && respHrs > slaThresholdHrs * 0.75;
    // slaPct: proportion of threshold consumed (capped at 100)
    const slaPct = respHrs != null
      ? Math.min(100, Math.round((respHrs / slaThresholdHrs) * 100))
      : Math.min(100, Math.round((lastActivityHrs / slaThresholdHrs) * 100));

    // Only add non-closed cases to risk table
    if (!isClosed) {
      repMap[ownerId].cases.push({
        sfId:          c.Id,
        caseNum:       c.CaseNumber,
        subject:       c.Subject ?? '',
        status:        c.Status ?? 'Open',
        created:       new Date(c.CreatedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        ageDays,
        lastActivityDays,
        slaPct,
        isBreached,
        isAtRisk,
        waitingOnClient,
        noResponse: respHrs == null && !isClosed && !waitingOnClient,
        respHrs,
      });
    }

    if (respHrs != null) repMap[ownerId].responseTimes.push(respHrs);
  }

  // ── Aggregate per rep ────────────────────────────────────────────────────────
  const reps = Object.values(repMap).map(rep => {
    const { cases, responseTimes, name } = rep;
    // cases[] only contains open cases; responseTimes includes all (open + closed) for accuracy
    const total = cases.length;
    // KPI metrics only count cases with a logged response time (null-response cases are excluded)
    const respondedCases = cases.filter(c => c.respHrs != null);
    const rCount = respondedCases.length;

    return {
      name,
      openCases:         total,
      slaBreachCount:    respondedCases.filter(c => c.isBreached).length,
      slaRiskCount:      respondedCases.filter(c => c.isAtRisk).length,
      slaMeetPct:        rCount > 0
        ? parseFloat((respondedCases.filter(c => !c.isBreached).length / rCount * 100).toFixed(1))
        : 0,
      avgResponseHrs:    responseTimes.length > 0
        ? parseFloat((responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length).toFixed(2))
        : 0,
      medianResponseHrs: parseFloat(median(responseTimes).toFixed(2)),
      cases: [...cases].sort((a, b) => a.slaPct - b.slaPct),
    };
  });

  return reps.sort((a, b) => a.name.localeCompare(b.name));
}
