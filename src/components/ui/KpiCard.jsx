/**
 * Top-line KPI / AVSG card
 * variant: 'accent' | 'warn' | 'danger' | 'success'
 */
export function KpiCard({ label, value, goal, pct, variant = 'accent' }) {
  const barColor = {
    accent:  'bg-accent',
    warn:    'bg-warn',
    danger:  'bg-danger',
    success: 'bg-success',
  }[variant];

  const topColor = {
    accent:  'bg-accent',
    warn:    'bg-warn',
    danger:  'bg-danger',
    success: 'bg-success',
  }[variant];

  const pctColor = {
    accent:  'text-accent',
    warn:    'text-warn',
    danger:  'text-danger',
    success: 'text-success',
  }[variant];

  const clampedPct = Math.min(pct ?? 0, 100);

  return (
    <div className="bg-surface border border-border rounded-[10px] p-4 pt-5 relative overflow-hidden">
      {/* Top accent bar */}
      <div className={`absolute top-0 left-0 right-0 h-[3px] ${topColor}`} />

      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">
        {label}
      </div>
      <div className="text-2xl font-bold font-mono leading-none mb-1">
        {value ?? '—'}
      </div>
      {goal != null && (
        <div className="text-[11px] text-muted mb-1.5">Goal: {goal}</div>
      )}
      {pct != null && (
        <>
          <div className="h-1 bg-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${barColor} transition-all duration-500`}
              style={{ width: `${clampedPct}%` }}
            />
          </div>
          <div className={`text-[10px] font-mono mt-1 ${pctColor}`}>
            {pct.toFixed(0)}%
          </div>
        </>
      )}
    </div>
  );
}
