import { useDashboard } from '../../context/DashboardContext';

export function Header() {
  const { goalsOpen, setGoalsOpen, lastUpdated } = useDashboard();

  return (
    <div className="bg-surface border-b border-border px-6 py-3 flex items-center justify-between sticky top-0 z-[100]">
      <div className="flex items-center gap-3.5">
        <div className="font-mono text-[10px] text-accent uppercase tracking-[2px]">
          HB Support
        </div>
        <div className="text-sm font-semibold text-text">
          Rep Activity Dashboard
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[10px] text-muted">
          Updated {lastUpdated}
        </span>
        <button
          className="bg-transparent border border-border text-text px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
          onClick={() => setGoalsOpen(v => !v)}
        >
          ⚙ Goals
        </button>
        <button
          className="bg-accent text-white px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer hover:opacity-85 transition-opacity"
          onClick={() => window.location.reload()}
        >
          ↻ Refresh
        </button>
      </div>
    </div>
  );
}
