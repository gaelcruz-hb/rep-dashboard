import { useState } from 'react';
import { Card } from './Card';
import { statusColor, fmtDurationSec, fmtDayLabel } from '../../data/productivityUtils';

const labelize = s => String(s ?? '').trim().replace(/\b\w/g, c => c.toUpperCase());

function StatusPill({ status }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, backgroundColor: `${color}1f`, border: `1px solid ${color}59` }}
    >
      {labelize(status)}
    </span>
  );
}

function DaySection({ day, rows, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Per-status totals for the bar + legend, ordered by time spent.
  const totals = {};
  for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + r.durationSecs;
  const dayTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const byStatus = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  return (
    <Card className="mb-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center justify-between gap-4 flex-wrap hover:bg-surface2 transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <span className="text-muted text-[10px]">{expanded ? '▲' : '▼'}</span>
          <span className="text-xs font-semibold text-text">{fmtDayLabel(day)}</span>
        </span>
        <div className="flex items-center gap-3 flex-wrap">
          {byStatus.map(([status, secs]) => (
            <span key={status} className="flex items-center gap-1.5 text-[11px] font-mono text-muted">
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: statusColor(status) }} />
              {fmtDurationSec(secs)}
            </span>
          ))}
        </div>
      </button>

      {/* Proportional status bar */}
      <div className="px-4 pb-3">
        <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-surface2">
          {byStatus.map(([status, secs]) => (
            <div
              key={status}
              title={`${labelize(status)} · ${fmtDurationSec(secs)}`}
              style={{ width: dayTotal > 0 ? `${(secs / dayTotal) * 100}%` : '0%', backgroundColor: statusColor(status) }}
            />
          ))}
        </div>
      </div>

      {/* Instances table */}
      {expanded && (
        <div className="px-4 py-3 border-t border-border">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] font-mono uppercase tracking-[1px] text-muted text-left">
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 font-normal">Start (CDT)</th>
                <th className="pb-2 font-normal">End (CDT)</th>
                <th className="pb-2 font-normal text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="text-xs font-mono border-b border-border/50 last:border-0 hover:bg-surface2 transition-colors">
                  <td className="py-2"><StatusPill status={r.status} /></td>
                  <td className="py-2 text-text">{r.startLocal}</td>
                  <td className="py-2 text-text">{r.endLocal}</td>
                  <td className="py-2 text-right text-text">{fmtDurationSec(r.durationSecs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function StatusTimeline({ instances, loading }) {
  if (loading) {
    return (
      <Card className="mb-4">
        <div className="h-24 flex items-center justify-center text-muted text-xs font-mono animate-pulse">Loading…</div>
      </Card>
    );
  }
  if (!instances?.length) {
    return (
      <Card className="mb-4">
        <div className="h-24 flex items-center justify-center text-muted text-xs font-mono">No status data for this period</div>
      </Card>
    );
  }

  // Group by day, preserving the API's chronological order.
  const days = [];
  const byDay = {};
  for (const inst of instances) {
    if (!byDay[inst.day]) { byDay[inst.day] = []; days.push(inst.day); }
    byDay[inst.day].push(inst);
  }

  return <>{days.map((day, i) => <DaySection key={day} day={day} rows={byDay[day]} defaultExpanded={i === 0} />)}</>;
}
