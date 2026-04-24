import { useState, useRef, useEffect } from 'react';
import { useDashboard } from '../../context/DashboardContext';

function Label({ children }) {
  return (
    <div className="text-[10px] text-muted font-mono uppercase tracking-[1px]">
      {children}
    </div>
  );
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors cursor-pointer"
    >
      {children}
    </select>
  );
}

// Searchable rep picker
function RepPicker({ value, onChange, reps }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const containerRef          = useRef(null);
  const inputRef              = useRef(null);

  const selectedName = value === 'all' ? 'All Reps' : (reps.find(r => r.id === value)?.name ?? 'All Reps');

  const filtered = query.trim()
    ? reps.filter(r => r.name.toLowerCase().includes(query.toLowerCase()))
    : reps;

  // Close on outside click
  useEffect(() => {
    function handle(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  function select(id) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors cursor-pointer flex items-center gap-1.5 min-w-[140px]"
      >
        <span className="flex-1 text-left truncate">{selectedName}</span>
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-surface border border-border rounded-md shadow-lg w-52">
          <div className="p-1.5 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              placeholder="Search reps..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-surface2 border border-border text-text px-2 py-1 rounded text-xs outline-none focus:border-accent"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button
              onClick={() => select('all')}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface2 transition-colors ${value === 'all' ? 'text-accent' : 'text-text'}`}
            >
              All Reps
            </button>
            {filtered.map(r => (
              <button
                key={r.id}
                onClick={() => select(r.id)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface2 transition-colors truncate ${value === r.id ? 'text-accent' : 'text-text'}`}
              >
                {r.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted">No results</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Controls() {
  const {
    managerFilter, setManagerFilter,
    teamFilter, setTeamFilter,
    repFilter, setRepFilter,
    periodFilter, setPeriodFilter,
    customRangeMode, setCustomRangeMode,
    customStartDate, setCustomStartDate,
    customEndDate, setCustomEndDate,
    managers, teams, availableReps,
  } = useDashboard();

  return (
    <div className="bg-surface border-b border-border px-6 py-2.5 flex items-center gap-6 flex-wrap">
      <div className="flex items-center gap-1.5">
        <Label>Manager</Label>
        <Select value={managerFilter} onChange={setManagerFilter}>
          <option value="all">All</option>
          {managers.map(m => <option key={m} value={m}>{m}</option>)}
        </Select>
      </div>

      <div className="flex items-center gap-1.5">
        <Label>Team</Label>
        <Select value={teamFilter} onChange={setTeamFilter}>
          <option value="all">All</option>
          {teams.map(t => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>

      <div className="flex items-center gap-1.5">
        <Label>Rep</Label>
        <RepPicker value={repFilter} onChange={setRepFilter} reps={availableReps} />
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Label>{customRangeMode ? 'Date Range' : 'Period'}</Label>
          {!customRangeMode ? (
            <Select value={periodFilter} onChange={setPeriodFilter}>
              <option value="yesterday">Yesterday</option>
              <option value="week">This Week</option>
              <option value="last_week">Last Week</option>
              <option value="month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="last_30">Last 30 Days</option>
            </Select>
          ) : (
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={customStartDate}
                onChange={e => setCustomStartDate(e.target.value)}
                className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors cursor-pointer"
              />
              <span className="text-muted text-xs">–</span>
              <input
                type="date"
                value={customEndDate}
                min={customStartDate || undefined}
                onChange={e => setCustomEndDate(e.target.value)}
                className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors cursor-pointer"
              />
            </div>
          )}
        </div>
        <button
          onClick={() => setCustomRangeMode(!customRangeMode)}
          className={`text-[10px] font-mono uppercase tracking-[1px] px-2 py-1 rounded border transition-colors ${
            customRangeMode
              ? 'bg-accent text-bg border-accent'
              : 'bg-surface2 text-muted border-border hover:text-text'
          }`}
        >
          {customRangeMode ? 'Custom' : 'Preset'}
        </button>
      </div>
    </div>
  );
}
