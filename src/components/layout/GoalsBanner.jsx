import { useState, useEffect } from 'react';
import { useDashboard } from '../../context/DashboardContext';
import { DEFAULT_GOALS } from '../../data/mockData';

const GOAL_FIELDS = [
  { key: 'closedDay',    label: 'Closed / Day / Rep',       step: 1 },
  { key: 'responseHrs',  label: 'Avg Response Time (hrs)',   step: 0.5 },
  { key: 'emailsDay',    label: 'Emails / Day / Rep',        step: 1 },
  { key: 'maxOnHold',    label: 'Max On Hold / Rep',         step: 1 },
  { key: 'maxOpen',      label: 'Max Open Cases / Rep',      step: 1 },
  { key: 'transferRate', label: 'Transfer Rate Target (%)',  step: 1 },
  { key: 'availPct',     label: 'Availability % Target',     step: 1 },
  { key: 'prodPct',      label: 'Productive Time % Target',  step: 1 },
  { key: 'contactsHr',   label: 'Contacts / Hr Target',      step: 0.5 },
  { key: 'slaBreach',    label: 'SLA Breach Threshold (hrs)', step: 0.5 },
  { key: 'instascore',   label: 'Instascore Target',         step: 1 },
  { key: 'fcrPct',       label: 'FCR Target (%)',            step: 1 },
  { key: 'totalPending', label: 'Total Pending Max',         step: 1 },
  { key: 'avgHoldSec',   label: 'Avg On Hold Max (secs)',    step: 5 },
];

export function GoalsBanner() {
  const { goalsOpen, setGoalsOpen, goals, setGoals } = useDashboard();
  const [draft, setDraft] = useState({ ...goals });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    setDraft({ ...goals });
  }, [goals]);

  if (!goalsOpen) return null;

  async function handleSave() {
    // Flush any NaN values back to defaults before saving
    const clean = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, Number.isFinite(v) ? v : DEFAULT_GOALS[k]])
    );
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGoals({ ...clean });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setGoalsOpen(false);
      }, 800);
    } catch (err) {
      console.error('[Goals] Save failed:', err);
      setSaveError(true);
      setTimeout(() => setSaveError(false), 3000);
    }
  }

  return (
    <div className="bg-surface border-b border-border px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-accent">Configure Goals</div>
        <button
          className={`px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all duration-300 ${
            saved       ? 'bg-success text-[#0f1117]'
            : saveError ? 'bg-danger text-white'
            :              'bg-accent text-white hover:opacity-85'
          }`}
          onClick={handleSave}
        >
          {saved ? '✓ Saved' : saveError ? '✗ Error' : 'Save'}
        </button>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {GOAL_FIELDS.map(({ key, label, step }) => (
          <div key={key} className="flex flex-col gap-1">
            <div className="text-[10px] text-muted font-mono uppercase tracking-[1px]">
              {label}
            </div>
            <input
              type="number"
              step={step}
              value={draft[key]}
              onChange={e => { const v = e.target.valueAsNumber; setDraft(d => ({ ...d, [key]: Number.isFinite(v) ? v : d[key] })); }}
              className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
