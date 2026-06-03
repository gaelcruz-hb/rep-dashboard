import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card } from './Card';
import { fmtDurationSec, fmtDayLabel, mergeIntervals, STATUS_COLORS } from '../../data/productivityUtils';

const SF_BASE = 'https://joinhomebase.lightning.force.com/lightning/r/MessagingSession';

const CHAT_COLOR   = STATUS_COLORS['chat'] ?? '#a78bfa';  // chat bars
const ACTIVE_COLOR = '#38d9a9';                            // merged active band (success/teal)
const TZ = 'America/Chicago';

// 'YYYY-MM-DD' day key in US Central, to match the Status Instances conventions.
const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
// "9:15 AM" in US Central.
const timeLabel = ms =>
  new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

// Greedily pack intervals into lanes: each interval goes to the first lane whose
// last segment has already ended. Returns a laneIndex per interval (input order).
function assignLanes(intervals) {
  const laneEnds = [];                  // current end time of each lane
  const order = intervals
    .map((iv, i) => ({ iv, i }))
    .sort((a, b) => a.iv.s - b.iv.s);
  const lane = new Array(intervals.length);
  for (const { iv, i } of order) {
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l++) {
      if (laneEnds[l] <= iv.s) { placed = l; break; }
    }
    if (placed === -1) { placed = laneEnds.length; laneEnds.push(iv.e); }
    else laneEnds[placed] = iv.e;
    lane[i] = placed;
  }
  return { lane, laneCount: laneEnds.length };
}

// Hour-boundary tick marks (as % offsets) between windowStart and windowEnd.
function hourTicks(windowStart, windowEnd) {
  const span = windowEnd - windowStart;
  if (span <= 0) return [];
  const ticks = [];
  const first = new Date(windowStart);
  first.setMinutes(0, 0, 0);
  let t = first.getTime();
  if (t < windowStart) t += 3600_000;
  for (; t <= windowEnd; t += 3600_000) {
    ticks.push({ pct: ((t - windowStart) / span) * 100, label: timeLabel(t) });
  }
  return ticks;
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-text text-right break-all">{value}</dd>
    </div>
  );
}

// A single chat block on a lane. Renders the colored bar plus a hover tooltip
// (via a body-level portal so it isn't clipped by the Card's overflow-hidden).
// The tooltip stays open while the cursor is over it, so its link is clickable.
function ChatBar({ iv, leftPct, widthPct }) {
  const c = iv.c;
  const [pos, setPos] = useState(null);   // { x, top, bottom } in viewport coords, or null
  const hideTimer = useRef(null);
  const url = c.sessionId ? `${SF_BASE}/${c.sessionId}/view` : null;

  const show = e => {
    clearTimeout(hideTimer.current);
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPos(null), 140);
  };
  const cancelHide = () => clearTimeout(hideTimer.current);

  // Flip below the bar when there isn't room above.
  const flipBelow = pos && pos.top < 160;
  // Anchor horizontally by screen position: bars on the left open to the right,
  // bars on the right open to the left, otherwise center over the bar.
  const TT_W = 240, MARGIN = 8;
  let xTranslate = '-50%';
  if (pos) {
    if (pos.x < TT_W / 2 + MARGIN) xTranslate = '0';                              // left side → open right
    else if (pos.x > window.innerWidth - TT_W / 2 - MARGIN) xTranslate = '-100%'; // right side → open left
  }

  return (
    <>
      <div
        className="absolute top-0 h-full rounded-sm cursor-pointer transition-[filter] hover:brightness-125"
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: CHAT_COLOR }}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
      />
      {pos && createPortal(
        <div
          className="fixed z-50"
          style={{
            left: pos.x,
            top: flipBelow ? pos.bottom + 6 : pos.top - 6,
            transform: `translateX(${xTranslate}) translateY(${flipBelow ? '0' : '-100%'})`,
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <div className="w-60 rounded-md border border-border bg-surface2 shadow-xl p-3 text-left">
            <div className="text-[11px] font-semibold text-text font-mono mb-2">
              {timeLabel(iv.s)}–{timeLabel(iv.e)}
            </div>
            <dl className="space-y-1 text-[11px] font-mono">
              <InfoRow label="Duration" value={fmtDurationSec((iv.e - iv.s) / 1000)} />
              {c.waitSecs != null && <InfoRow label="Wait" value={fmtDurationSec(c.waitSecs)} />}
              <InfoRow label="Issue" value={c.issueType ?? '—'} />
              {c.companyAgeBucket && <InfoRow label="Company" value={c.companyAgeBucket} />}
              {c.ticketId && <InfoRow label="Ticket" value={c.ticketId} />}
            </dl>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-2.5 inline-block text-accent hover:underline text-[11px] font-mono font-semibold"
              >
                View chat ↗
              </a>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function DayCard({ day, chats, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Intervals (accept→end) and per-chat metadata, sorted by start.
  const intervals = chats
    .map(c => ({ s: Date.parse(c.acceptTime), e: Date.parse(c.endTime), c }))
    .filter(iv => Number.isFinite(iv.s) && Number.isFinite(iv.e) && iv.e > iv.s)
    .sort((a, b) => a.s - b.s);

  const windowStart = Math.min(...intervals.map(iv => iv.s));
  const windowEnd   = Math.max(...intervals.map(iv => iv.e));
  const span        = windowEnd - windowStart || 1;

  const { lane, laneCount } = assignLanes(intervals);
  const merged    = mergeIntervals(intervals.map(iv => [iv.s, iv.e]));
  const activeSecs = merged.reduce((t, [s, e]) => t + (e - s), 0) / 1000;
  const naiveSecs  = intervals.reduce((t, iv) => t + (iv.e - iv.s) / 1000, 0);
  const ticks      = hourTicks(windowStart, windowEnd);

  const pct = ms => ((ms - windowStart) / span) * 100;

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
        <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-text font-semibold">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: ACTIVE_COLOR }} />
            active {fmtDurationSec(activeSecs)}
          </span>
          <span className="text-border">·</span>
          <span className="text-muted">sum {fmtDurationSec(naiveSecs)}</span>
          <span className="text-border">·</span>
          <span className="text-muted">{intervals.length} chat{intervals.length !== 1 ? 's' : ''}</span>
          <span className="text-border">·</span>
          <span className={laneCount > 1 ? 'text-warn' : 'text-muted'}>max {laneCount} at once</span>
        </div>
      </button>

      {/* Always-visible merged active band */}
      <div className="px-4 pb-3">
        <div className="relative w-full h-2.5 rounded-full overflow-hidden bg-surface2">
          {merged.map(([s, e], i) => (
            <div
              key={i}
              className="absolute top-0 h-full"
              title={`Active ${timeLabel(s)}–${timeLabel(e)} · ${fmtDurationSec((e - s) / 1000)}`}
              style={{ left: `${pct(s)}%`, width: `${Math.max(pct(e) - pct(s), 0.8)}%`, backgroundColor: ACTIVE_COLOR }}
            />
          ))}
        </div>
      </div>

      {/* Expanded: concurrency-lane Gantt + hour axis */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          <div className="relative">
            {/* hour gridlines */}
            <div className="absolute inset-0 pointer-events-none">
              {ticks.map((t, i) => (
                <div key={i} className="absolute top-0 bottom-0 border-l border-border/40" style={{ left: `${t.pct}%` }} />
              ))}
            </div>

            {/* lanes */}
            <div className="relative flex flex-col gap-1">
              {Array.from({ length: laneCount }).map((_, l) => (
                <div key={l} className="relative h-5">
                  {intervals.map((iv, i) => lane[i] === l && (
                    <ChatBar
                      key={i}
                      iv={iv}
                      leftPct={pct(iv.s)}
                      widthPct={Math.max(pct(iv.e) - pct(iv.s), 0.8)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* axis labels */}
          <div className="relative h-4 mt-1">
            {ticks.map((t, i) => (
              <span
                key={i}
                className="absolute text-[9px] font-mono text-muted -translate-x-1/2 whitespace-nowrap"
                style={{ left: `${t.pct}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export function ChatTimeline({ chats, loading }) {
  if (loading) {
    return (
      <Card className="mb-4">
        <div className="h-24 flex items-center justify-center text-muted text-xs font-mono animate-pulse">Loading…</div>
      </Card>
    );
  }

  // Keep only chats with a usable active window (accepted + ended).
  const usable = (chats ?? []).filter(c => {
    const s = Date.parse(c.acceptTime), e = Date.parse(c.endTime);
    return Number.isFinite(s) && Number.isFinite(e) && e > s;
  });

  if (!usable.length) {
    return (
      <Card className="mb-4">
        <div className="h-24 flex items-center justify-center text-muted text-xs font-mono">No chat activity for this period</div>
      </Card>
    );
  }

  // Group by Central day, newest day first.
  const byDay = {};
  for (const c of usable) {
    const k = dayKey(Date.parse(c.acceptTime));
    (byDay[k] ??= []).push(c);
  }
  const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

  return (
    <>
      {days.map((day, i) => (
        <DayCard key={day} day={day} chats={byDay[day]} defaultExpanded={i === 0} />
      ))}
    </>
  );
}
