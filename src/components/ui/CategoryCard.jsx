/**
 * Org-level category card for the Overview, themed to match the Rep Details overview cards:
 * rounded-xl, color-tinted border + top accent bar + label, a large hero value, then a divided
 * list of metric rows (StatRow / GoalRow) passed as children.
 */
export function CategoryCard({ color, label, hero, heroSub, children, className = '' }) {
  return (
    <div className={`bg-surface border rounded-xl overflow-hidden flex flex-col ${className}`} style={{ borderColor: `${color}4D` }}>
      <div className="h-[3px]" style={{ backgroundColor: color }} />
      <div className="px-4 py-3 flex flex-col flex-1">
        <div className="text-[10px] font-mono uppercase tracking-[1px] font-semibold mb-1" style={{ color }}>{label}</div>
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-2xl font-bold font-mono text-text leading-none">{hero}</span>
          {heroSub != null && <span className="text-[11px] text-muted">{heroSub}</span>}
        </div>
        <div className="divide-y divide-border/40">{children}</div>
      </div>
    </div>
  );
}

/** Plain label → value row. `valueClass` lets the caller tint the value (e.g. red for missed). */
export function StatRow({ label, value, valueClass = 'text-text' }) {
  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <span className="text-[11px] text-muted shrink-0">{label}</span>
      <span className={`text-sm font-bold font-mono shrink-0 ${valueClass}`}>{value}</span>
    </div>
  );
}

const STATUS = {
  success: { bar: 'bg-success', txt: 'text-success', glyph: '✓' },
  warn:    { bar: 'bg-warn',    txt: 'text-warn',    glyph: '◐' },
  danger:  { bar: 'bg-danger',  txt: 'text-danger',  glyph: '✗' },
};

/** Row with a mini progress bar + value + ✓/◐/✗ indicator, colored by `status`. */
export function GoalRow({ label, value, pct = 0, status = 'success' }) {
  const s = STATUS[status] ?? STATUS.success;
  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <span className="text-[11px] text-muted shrink-0">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden shrink-0">
          <div className={`h-full rounded-full ${s.bar} transition-all duration-500`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
        <span className="text-sm font-bold font-mono text-text shrink-0">{value}</span>
        <span className={`text-[10px] font-mono shrink-0 ${s.txt}`}>{s.glyph}</span>
      </div>
    </div>
  );
}
