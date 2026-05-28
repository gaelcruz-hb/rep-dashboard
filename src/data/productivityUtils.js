const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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

// Stable fallback palette for statuses not in STATUS_COLORS — hash the name so a
// given status always lands on the same color across renders/charts.
const FALLBACK_PALETTE = [
  '#5b8af5', '#38d9a9', '#a78bfa', '#f5a623', '#60c8f5', '#c084fc',
  '#f472b6', '#fb923c', '#22d3ee', '#facc15', '#34d399', '#818cf8',
];

export function statusColor(status) {
  const key = String(status ?? '').trim().toLowerCase();
  if (STATUS_COLORS[key]) return STATUS_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

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
      backgroundColor: statusColor(s),
      borderWidth:     0,
    })),
  };
}

export const WEEKLY_CHART_OPTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: true, labels: { color: '#6b7280', font: { size: 10 }, boxWidth: 10, boxHeight: 10 } },
    tooltip: {
      backgroundColor: '#1e2333', titleColor: '#e8eaf0', bodyColor: '#6b7280',
      borderColor: '#2a2f42', borderWidth: 1,
      callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}h` },
    },
  },
  scales: {
    x: { stacked: true, grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 } } },
    y: { stacked: true, grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 }, callback: v => `${v}h` } },
  },
};

export function buildWeeklyChartData(weekly) {
  if (!weekly?.length) return null;
  const weeks    = [...new Set(weekly.map(r => r.weekStart))].sort();
  const statuses = [...new Set(weekly.map(r => r.status))];
  const lookup   = {};
  for (const r of weekly) {
    if (!lookup[r.weekStart]) lookup[r.weekStart] = {};
    lookup[r.weekStart][r.status] = r.totalSecs;
  }
  const fmtWeek = ws => {
    const [y, m, d] = ws.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d));
    const end   = new Date(Date.UTC(y, m - 1, d + 6));
    const sm = MONTHS[start.getUTCMonth()], sd = start.getUTCDate();
    const em = MONTHS[end.getUTCMonth()],   ed = end.getUTCDate();
    return sm === em ? `${sm} ${sd} – ${ed}` : `${sm} ${sd} – ${em} ${ed}`;
  };
  return {
    labels:   weeks.map(fmtWeek),
    datasets: statuses.map(s => ({
      label:           s.trim().replace(/\b\w/g, c => c.toUpperCase()),
      data:            weeks.map(w => Math.round((lookup[w]?.[s] ?? 0) / 3600)),
      backgroundColor: statusColor(s),
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

// Seconds-aware duration for the status-instances table: 1h 07m / 9m 06s / 49s
export function fmtDurationSec(s) {
  const total = Math.max(0, Math.round(s ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 'yyyy-MM-dd' (already in Central) → "Wed May 27, 2026". Parsed as UTC to avoid
// a viewer-timezone shift of the day label.
export function fmtDayLabel(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}
