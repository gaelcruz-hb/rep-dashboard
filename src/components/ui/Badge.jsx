const VARIANTS = {
  open:    'bg-accent/15 text-accent',
  pending: 'bg-warn/15 text-warn',
  hold:    'bg-danger/15 text-danger',
  new:     'bg-success/15 text-success',
  T1:      'bg-accent/15 text-accent',
  'T2-APS':'bg-warn/15 text-warn',
  'T2-ATS':'bg-warn/15 text-warn',
  ECE:     'bg-purple-500/20 text-purple-300',
};

export function Badge({ label, variant }) {
  const cls = VARIANTS[variant] ?? VARIANTS[label?.toLowerCase()] ?? 'bg-border text-muted';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium font-mono ${cls}`}>
      {label}
    </span>
  );
}

export function StatusPill({ color, label, count }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface2 border border-border text-[11px]">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-muted">{label}</span>
      <span className="font-bold font-mono text-sm text-text">{count}</span>
    </div>
  );
}

export function WoW({ value, suffix = '' }) {
  if (value == null) return null;
  const isUp = value > 0;
  const cls  = value === 0 ? 'text-muted' : isUp ? 'text-success' : 'text-danger';
  const arrow = value === 0 ? '—' : isUp ? '▲' : '▼';
  return (
    <span className={`text-[10px] font-mono ${cls}`}>
      {arrow} {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}
