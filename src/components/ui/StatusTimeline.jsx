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
  // Clock-out segments (offline > 8h) are excluded so they don't dominate the view.
  const totals = {};
  for (const r of rows) {
    if (r.clockedOut) continue;
    totals[r.status] = (totals[r.status] ?? 0) + r.durationSecs;
  }
  const dayTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const byStatus = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  // Total time logged into Talkdesk that day = any non-offline status (clock-out excluded).
  const loggedInSecs = rows
    .filter(r => !r.clockedOut && !isOffline(r.status))
    .reduce((a, r) => a + r.durationSecs, 0);

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
          <span className="text-[11px] font-mono text-text font-semibold">
            Logged in {fmtDurationSec(loggedInSecs)}
          </span>
          <span className="text-border">·</span>
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
                  <td className="py-2">
                    {r.clockedOut
                      ? <span className="text-muted italic text-[11px]">Clocked out</span>
                      : <StatusPill status={r.status} />}
                  </td>
                  <td className={`py-2 ${r.clockedOut ? 'text-muted' : 'text-text'}`}>{r.startLocal}</td>
                  <td className={`py-2 ${r.clockedOut ? 'text-muted' : 'text-text'}`}>{r.endLocal}</td>
                  <td className={`py-2 text-right ${r.clockedOut ? 'text-muted' : 'text-text'}`}>{fmtDurationSec(r.durationSecs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// A day with no on-the-clock activity (only offline / clock-out) → the rep wasn't in.
function NotInOfficeCard({ day }) {
  return (
    <Card className="mb-4">
      <div className="px-4 py-3 flex items-center justify-between gap-4">
        <span className="text-xs font-semibold text-muted">{fmtDayLabel(day)}</span>
        <span className="text-[11px] font-mono text-muted italic">Not in Office</span>
      </div>
    </Card>
  );
}

const isOffline = s => String(s ?? '').trim().toLowerCase() === 'offline';

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

  // Group by day, then order newest-first (rows within each day stay chronological).
  const byDay = {};
  for (const inst of instances) {
    if (!byDay[inst.day]) byDay[inst.day] = [];
    byDay[inst.day].push(inst);
  }
  const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

  // Expand the most recent day that actually has office activity.
  const firstActive = days.find(day => byDay[day].some(r => !isOffline(r.status)));

  return (
    <>
      {days.map(day => {
        const rows = byDay[day];
        const inOffice = rows.some(r => !isOffline(r.status));
        return inOffice
          ? <DaySection key={day} day={day} rows={rows} defaultExpanded={day === firstActive} />
          : <NotInOfficeCard key={day} day={day} />;
      })}
    </>
  );
}
