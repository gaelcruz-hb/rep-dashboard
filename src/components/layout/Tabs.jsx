import { useDashboard } from '../../context/DashboardContext';

const TABS = [
  { id: 'overview',    label: 'Overview' },
  { id: 'response',    label: 'Response & SLA' },
  { id: 'resolution',  label: 'Resolution' },
  { id: 'volume',      label: 'Volume & Inflow' },
  { id: 'channels',    label: 'Channels' },
  { id: 'manager',     label: '⭐ Manager Scorecard' },
  { id: 'rep',         label: 'Rep Detail' },
  { id: 'diagnostics', label: '⚡ Diagnostics' },
];

export function Tabs() {
  const { activeTab, setActiveTab } = useDashboard();

  return (
    <div>
      <div className="bg-surface border-b border-border px-6 flex gap-0 overflow-x-auto">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-4 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-all cursor-pointer bg-transparent
                ${isActive
                  ? 'text-accent border-accent'
                  : 'text-muted border-transparent hover:text-text'
                }
              `}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
