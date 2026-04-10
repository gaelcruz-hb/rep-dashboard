/**
 * Parse /api/volume-data into the shape used by VolumeInflow.jsx.
 *
 * Input shape (from server):
 *   originToday   — { records: [{ Origin, cnt }] }          cases by channel today
 *   hourlyToday   — { records: [{ hr, cnt }] }              cases by hour today (0-23)
 *   daily14d      — { records: [{ day, cnt }] }             daily created last 14 days
 *   typeBreakdown — { records: [{ Type, cnt }] }            cases by type last 7 days
 *   emailDaily14d — { records: [{ day, cnt }] }             email cases by day last 14 days
 *   totalOpen     — number                                  total open cases
 */
export function parseVolumeData(raw) {
  if (!raw) return null;

  const { originToday, hourlyToday, daily14d, typeBreakdown, emailDaily14d, totalOpen } = raw;

  // ── KPI totals ───────────────────────────────────────────────────────────────
  const newCasesToday = (originToday?.records ?? []).reduce((s, r) => s + (r.cnt ?? 0), 0);

  // Sum last 7 days from daily14d
  const daily14dRecords = daily14d?.records ?? [];
  const newCasesWeek = daily14dRecords.slice(-7).reduce((s, r) => s + (r.cnt ?? 0), 0);

  const emailOrigin = (originToday?.records ?? []).find(r => r.Origin === 'Email');
  const emailsToday = emailOrigin?.cnt ?? 0;

  // ── Channel doughnut ─────────────────────────────────────────────────────────
  const channelRecords = originToday?.records ?? [];
  const channelLabels = channelRecords.map(r => r.Origin ?? 'Unknown');
  const channelCounts = channelRecords.map(r => r.cnt ?? 0);

  // ── Hourly bar (fill all 24 hours 0-23) ─────────────────────────────────────
  const hourlyMap = {};
  for (const r of hourlyToday?.records ?? []) hourlyMap[r.hr] = r.cnt ?? 0;
  const hourlyLabels = Array.from({ length: 24 }, (_, i) => `${i}h`);
  const hourlyCounts = Array.from({ length: 24 }, (_, i) => hourlyMap[i] ?? 0);

  // ── Daily 14-day trend ───────────────────────────────────────────────────────
  const dailyLabels = daily14dRecords.map(r => {
    const d = new Date(r.day);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const dailyCounts = daily14dRecords.map(r => r.cnt ?? 0);

  // ── Issue type h-bar ─────────────────────────────────────────────────────────
  const typeRecords = typeBreakdown?.records ?? [];
  const typeLabels = typeRecords.map(r => r.Type ?? 'Unknown');
  const typeCounts = typeRecords.map(r => r.cnt ?? 0);

  // ── Email WoW (split 14-day array into this week / last week) ────────────────
  const emailRecords = emailDaily14d?.records ?? [];
  // Fill gaps in date series
  const emailMap = {};
  for (const r of emailRecords) emailMap[r.day] = r.cnt ?? 0;

  // Build ordered 14-day date list matching daily14d
  const emailThisWeek  = daily14dRecords.slice(-7).map(r => emailMap[r.day] ?? 0);
  const emailLastWeek  = daily14dRecords.slice(-14, -7).map(r => emailMap[r.day] ?? 0);
  const wowLabels      = daily14dRecords.slice(-7).map(r => {
    const d = new Date(r.day);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  });

  return {
    // KPIs
    newCasesToday,
    newCasesWeek,
    emailsToday,
    totalOpen: totalOpen ?? 0,

    // Chart data
    channelLabels,
    channelCounts,
    hourlyLabels,
    hourlyCounts,
    dailyLabels,
    dailyCounts,
    typeLabels,
    typeCounts,
    wowLabels,
    emailThisWeek,
    emailLastWeek,
  };
}
