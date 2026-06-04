/**
 * KPI card styled to match the Rep Details cards: rounded-xl, color-tinted border + top accent bar,
 * color-tinted label, large white value.
 *
 * Goal mode (pass `goal`): shows a progress bar + ✓/✗ on-track indicator + status line.
 *   higher: 'good' = higher value is better (Closed, Emails, Productive)
 *           'bad'  = lower value is better  (Response time, On Hold, Breaches)
 * No-goal mode (omit `goal`): shows the `sub` line under the value (plain stat card).
 *
 * `color` is the theme hex used for the border tint, top bar, and label.
 */
export function AvsgCard({ label, val, goal, unit = '', higher = 'good', displayVal, displayGoal, color = '#5b8af5', sub }) {
  let body;

  if (goal == null) {
    // No-goal mode → plain stat card with a sublabel.
    body = (
      <>
        <div className="text-2xl font-bold font-mono text-text leading-none mb-1">{displayVal ?? val ?? '—'}{unit}</div>
        {sub != null && <div className="text-[10px] text-muted mt-1">{sub}</div>}
      </>
    );
  } else if (val == null) {
    // Goal mode, no data yet.
    body = (
      <>
        <div className="text-2xl font-bold font-mono text-muted leading-none mb-2">—</div>
        <div className="w-full h-1.5 bg-border rounded-full overflow-hidden" />
        <div className="text-[10px] font-mono mt-1 text-muted">No data · goal {displayGoal ?? `${goal}${unit}`}</div>
      </>
    );
  } else {
    const rawPct = goal > 0 ? Math.round((val / goal) * 100) : 0;
    const pct    = Math.min(100, rawPct);
    const isGood = higher === 'good' ? rawPct >= 90 : rawPct <= 100;
    const status = isGood
      ? 'success'
      : rawPct <= (higher === 'good' ? 70 : 120) ? 'warn' : 'danger';

    const txtColor = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' }[status];
    const barColor = { success: 'bg-success',   warn: 'bg-warn',   danger: 'bg-danger'   }[status];

    const display = displayVal ?? (typeof val === 'number' && !Number.isInteger(val) ? val.toFixed(1) : val);
    const goalTxt = displayGoal ?? `${goal}${unit}`;
    const statusText = higher === 'bad'
      ? rawPct <= 100 ? `${rawPct}% of limit (${goalTxt})` : `${rawPct - 100}% over limit (${goalTxt})`
      : rawPct >= 100 ? `${rawPct - 100}% over goal (${goalTxt})` : `${rawPct}% of goal (${goalTxt})`;

    body = (
      <>
        <div className="text-2xl font-bold font-mono text-text leading-none mb-2">{display}{unit}</div>
        <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`text-[10px] font-mono mt-1 ${txtColor}`}>{isGood ? '✓' : '✗'} {statusText}</div>
      </>
    );
  }

  return (
    <div className="bg-surface border rounded-xl overflow-hidden" style={{ borderColor: `${color}4D` }}>
      <div className="h-[3px]" style={{ backgroundColor: color }} />
      <div className="px-4 py-3">
        <div className="text-[10px] font-mono uppercase tracking-[1px] font-semibold mb-1" style={{ color }}>{label}</div>
        {body}
      </div>
    </div>
  );
}
