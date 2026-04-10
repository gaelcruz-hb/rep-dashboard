/**
 * Parse /api/overview-data into the shape used by Overview.jsx.
 */
export function parseOverviewData(raw) {
  if (!raw) return null;

  const { statusTotals, closedToday, avgResponseHrs, dailyClosed14d, hourlyNew, emailsToday, totalClosedPeriod } = raw;

  // ── Status snapshot ───────────────────────────────────────────────────────────
  const statusMap = {};
  for (const r of statusTotals?.records ?? []) statusMap[r.Status] = r.cnt ?? 0;

  const totalNew     = statusMap['New'] ?? 0;
  const totalOpen    = statusMap['Open'] ?? 0;
  const totalPending = statusMap['Pending'] ?? statusMap['Waiting'] ?? 0;
  const totalHold    = statusMap['On Hold'] ?? 0;

  // Status chart (all open statuses)
  const statusLabels = (statusTotals?.records ?? []).map(r => r.Status);
  const statusCounts = (statusTotals?.records ?? []).map(r => r.cnt ?? 0);

  // ── Daily closed 14d ─────────────────────────────────────────────────────────
  const closedRecords = dailyClosed14d?.records ?? [];
  const dailyLabels = closedRecords.map(r => {
    const d = new Date(r.day);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const dailyClosedCounts = closedRecords.map(r => r.cnt ?? 0);

  // 7-day rolling avg overlay
  const avg7 = dailyClosedCounts.map((_, i, a) =>
    i < 6 ? null : Math.round(a.slice(i - 6, i + 1).reduce((s, v) => s + v, 0) / 7),
  );

  // WoW: split into two 7-day halves
  const thisWeek = closedRecords.slice(-7).map(r => r.cnt ?? 0);
  const lastWeek = closedRecords.slice(-14, -7).map(r => r.cnt ?? 0);
  const wowLabels = closedRecords.slice(-7).map(r => {
    const d = new Date(r.day);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  });

  // ── Hourly new today — UTC → CDT (UTC-5), 12h labels, only active hours ───────
  const TZ_OFFSET = -5; // CDT (Mar–Nov); flip to -6 for CST (Nov–Mar)

  const localMap = {};
  for (const r of hourlyNew?.records ?? []) {
    const local = ((r.hr + TZ_OFFSET) % 24 + 24) % 24;
    localMap[local] = (localMap[local] ?? 0) + (r.cnt ?? 0);
  }

  const hourlyEntries = Object.entries(localMap)
    .map(([h, cnt]) => ({ h: Number(h), cnt }))
    .sort((a, b) => a.h - b.h);

  const hourlyLabels = hourlyEntries.map(({ h }) => {
    const suffix = h < 12 ? 'am' : 'pm';
    return `${h % 12 || 12}${suffix}`;
  });
  const hourlyCounts = hourlyEntries.map(e => e.cnt);

  return {
    // KPI values
    totalClosed:       closedToday ?? 0,
    avgResponseHrs:    avgResponseHrs != null ? parseFloat(avgResponseHrs.toFixed(1)) : 0,
    emailsToday:       emailsToday ?? 0,
    totalOpen,
    totalNew,
    totalPending,
    totalHold,
    totalClosedPeriod: totalClosedPeriod ?? null,
    // Chart data
    dailyLabels,
    dailyClosedCounts,
    avg7,
    wowLabels,
    thisWeek,
    lastWeek,
    hourlyLabels,
    hourlyCounts,
    statusLabels,
    statusCounts,
  };
}
