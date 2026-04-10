export function Card({ children, className = '' }) {
  return (
    <div className={`bg-surface border border-border rounded-[10px] overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, children }) {
  return (
    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
      <div>
        <div className="text-xs font-semibold text-text">{title}</div>
        {subtitle && <div className="text-[10px] text-muted font-mono mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

export function CardBody({ children, className = '' }) {
  return (
    <div className={`p-4 ${className}`}>
      {children}
    </div>
  );
}

export function ChartPlaceholder({ height = 180, label = 'Chart' }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-border text-muted text-[10px] font-mono"
      style={{ height }}
    >
      {label}
    </div>
  );
}

export function SectionHeader({ title, children }) {
  return (
    <div className="flex items-center justify-between mb-3 mt-7">
      <div className="text-[11px] font-semibold text-muted uppercase tracking-[1.5px] font-mono">
        {title}
      </div>
      {children}
    </div>
  );
}
