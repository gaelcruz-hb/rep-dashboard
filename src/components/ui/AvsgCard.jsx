/**
 * AVSG-style KPI card — matches original HTML avsg-card exactly.
 * higher: 'good' = higher value is better (Closed, Emails, Avail, Prod)
 *         'bad'  = lower value is better  (Response time, On Hold, Breaches)
 */
export function AvsgCard({ label, val, goal, unit = '', higher = 'good', displayVal, displayGoal }) {
  if (val == null) {
    return (
      <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-border" />
        <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
        <div className="text-2xl font-bold font-mono leading-none mb-1 text-muted">—</div>
        <div className="text-[11px] text-muted mb-1.5">Goal: {displayGoal ?? `${goal}${unit}`}</div>
        <div className="h-1 bg-border rounded-full overflow-hidden" />
        <div className="text-[10px] font-mono mt-1 text-muted">No data</div>
      </div>
    );
  }
  const rawPct = goal > 0 ? Math.round((val / goal) * 100) : 0;
  const pct    = Math.min(100, rawPct);
  const isGood = higher === 'good' ? rawPct >= 90 : rawPct <= 100;
  const status = isGood
    ? 'success'
    : rawPct <= (higher === 'good' ? 70 : 120) ? 'warn' : 'danger';

  const topColor = { success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' }[status];
  const txtColor = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' }[status];
  const barColor = { success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' }[status];

  const display = displayVal ?? (typeof val === 'number' && !Number.isInteger(val)
    ? val.toFixed(1)
    : val);

  return (
    <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
      <div className={`absolute top-0 left-0 right-0 h-[3px] ${topColor}`} />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none mb-1">{display}{unit}</div>
      <div className="text-[11px] text-muted mb-1.5">Goal: {displayGoal ?? `${goal}${unit}`}</div>
      <div className="h-1 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`text-[10px] font-mono mt-1 ${txtColor}`}>
        {higher === 'bad'
          ? rawPct <= 100
            ? `${rawPct}% of limit`
            : `${rawPct - 100}% over limit`
          : rawPct >= 100
            ? `${rawPct - 100}% over goal`
            : `${rawPct}% of goal`}
      </div>
    </div>
  );
}
