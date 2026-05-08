export const STATUS_COLORS = {
  'available':          '#5b8af5',
  'on a call':          '#38d9a9',
  'chat':               '#a78bfa',
  'after call work':    '#f5a623',
  'outbound':           '#60c8f5',
  'email':              '#c084fc',
  'email queue ':       '#e879f9',
  'email/demo':         '#e879f9',
  'break':              '#6b7280',
  'lunch ':             '#9ca3af',
  'meeting/training ':  '#4b5563',
  'meeting/training':   '#4b5563',
  'away':               '#374151',
  'transfer':           '#64748b',
  'qa':                 '#f472b6',
  'tier 2 escalation':  '#fb923c',
  'troubleshooting':    '#22d3ee',
};

export const HOURLY_CHART_OPTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: true, labels: { color: '#6b7280', font: { size: 10 }, boxWidth: 10, boxHeight: 10 } },
    tooltip: {
      backgroundColor: '#1e2333', titleColor: '#e8eaf0', bodyColor: '#6b7280',
      borderColor: '#2a2f42', borderWidth: 1,
      callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}m` },
    },
  },
  scales: {
    x: { stacked: true, grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 } } },
    y: { stacked: true, grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 }, callback: v => `${v}m` } },
  },
};

export function buildHourlyChartData(hourly) {
  if (!hourly?.length) return null;
  const hours    = [...new Set(hourly.map(r => r.hour))].sort((a, b) => a - b);
  const statuses = [...new Set(hourly.map(r => r.status))];
  const lookup   = {};
  for (const r of hourly) {
    if (!lookup[r.hour]) lookup[r.hour] = {};
    lookup[r.hour][r.status] = r.avgSecs;
  }
  const fmtHour = h => h === 0 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
  return {
    labels:   hours.map(fmtHour),
    datasets: statuses.map(s => ({
      label:           s.trim().replace(/\b\w/g, c => c.toUpperCase()),
      data:            hours.map(h => Math.round((lookup[h]?.[s] ?? 0) / 60)),
      backgroundColor: STATUS_COLORS[s] ?? '#2a2f42',
      borderWidth:     0,
    })),
  };
}

export function fmtDuration(s) {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
