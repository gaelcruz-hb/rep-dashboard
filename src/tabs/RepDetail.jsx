import { useState } from 'react';
import { useDashboard } from '../context/DashboardContext';
import { useManagerData } from '../data/useManagerData';
import { parseManagerData } from '../data/parseManagerData';
import { useRepDetail } from '../data/useRepDetail';
import { Card, CardBody } from '../components/ui/Card';
import { ORG } from '../data/orgData';

function findManagerForRep(repName) {
  for (const { manager, teams } of ORG) {
    for (const team of teams) {
      const members = team.members.map(m => (typeof m === 'string' ? m : m.name));
      if (members.includes(repName)) return manager;
    }
  }
  return '—';
}

const SF_BASE = 'https://joinhomebase.lightning.force.com/lightning/r/Case/';

// ── KPI card ──────────────────────────────────────────────────────────────────
function RepKpiCard({ label, value, unit = '', goal, goalUnit = '', lower = false }) {
  const numVal  = parseFloat(value);
  const numGoal = parseFloat(goal);
  const isGood  = lower ? numVal <= numGoal : numVal >= numGoal;
  const pct     = numGoal > 0 ? Math.min(100, Math.round((numVal / numGoal) * 100)) : 0;
  const barColor  = isGood ? 'bg-success' : 'bg-danger';
  const topColor  = isGood ? 'bg-success' : 'bg-danger';
  const textColor = isGood ? 'text-success' : 'text-danger';

  return (
    <div className="bg-surface border border-border rounded-[10px] p-4 pt-5 relative overflow-hidden">
      <div className={`absolute top-0 left-0 right-0 h-[3px] ${topColor}`} />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none mb-1">{value}{unit}</div>
      <div className="text-[11px] text-muted mb-1.5">Goal: {goal}{goalUnit}</div>
      <div className="h-1 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`text-[10px] font-mono mt-1 ${textColor}`}>
        {isGood ? '✓ On track' : '✗ Below goal'}
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cls = {
    'Open':    'bg-accent/15 text-accent',
    'Pending': 'bg-warn/15 text-warn',
    'On Hold': 'bg-danger/15 text-danger',
    'New':     'bg-success/15 text-success',
  }[status] ?? 'bg-border text-muted';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium font-mono ${cls}`}>
      {status}
    </span>
  );
}

function LoadingRow() {
  return (
    <tr>
      <td colSpan={6} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">
        Loading cases…
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function RepDetail() {
  const { selectedRep, setSelectedRep, repFilter, goals, periodFilter, customRangeMode, customStartDate, customEndDate } = useDashboard();
  const [caseFilter, setCaseFilter] = useState('all');
  const [sortCol, setSortCol]       = useState('ageDays');
  const [sortDir, setSortDir]       = useState('desc');

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  function SortArrow({ col }) {
    if (sortCol !== col) return <span className="ml-1 text-border">↕</span>;
    return <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  // Rep list from manager data (has id + name + metrics)
  const { data: mgrRaw, loading: mgrLoading } = useManagerData();
  const { reps: repList = [] } = parseManagerData(mgrRaw) ?? {};

  // Rep dropdown takes precedence over row-click selection
  const activeRep = repFilter !== 'all' ? repFilter : selectedRep;
  const rep = repList.find(r => r.name === activeRep) ?? repList[0];

  // Fetch per-rep cases + WoW metrics when rep or period changes
  const { data: detail, loading: detailLoading, error: detailError } = useRepDetail(
    rep?.id, periodFilter,
    customRangeMode ? customStartDate : undefined,
    customRangeMode ? customEndDate   : undefined,
  );

  if (mgrLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono animate-pulse">
        Loading rep list…
      </div>
    );
  }

  if (!rep) {
    return <div className="text-muted text-xs p-4">No rep data available.</div>;
  }

  // ── Parse detail data ────────────────────────────────────────────────────────
  const now = Date.now();

  const closedPeriod      = detail?.closedPeriod      ?? 0;
  const closedPriorPeriod = detail?.closedPriorPeriod  ?? 0;
  const hasPrior          = detail?.hasPrior           ?? true;
  const avgResponseHrs = detail?.avgResponseHrs != null
    ? parseFloat(detail.avgResponseHrs.toFixed(1))
    : 0;

  // Instascore from CSAT records
  const csatScores = (detail?.csatData?.records ?? [])
    .map(r => parseFloat(r.Satisfaction_Score__c))
    .filter(v => !isNaN(v));
  const instascore = csatScores.length > 0
    ? parseFloat((csatScores.reduce((s, v) => s + v, 0) / csatScores.length).toFixed(1))
    : 0;

  // Cases table
  const rawCases = detail?.cases?.records ?? [];
  const parsedCases = rawCases.map(c => {
    const created  = new Date(c.CreatedDate).getTime();
    const modified = new Date(c.LastModifiedDate).getTime();
    return {
      sfId:         c.Id,
      caseNum:      c.CaseNumber,
      subject:      c.Subject ?? '—',
      status:       c.Status,
      ageDays:      Math.round((now - created) / 86400000),
      lastActDays:  Math.round((now - modified) / 86400000),
      responseHrs:  c.Case_Response_Time_Hours__c != null
        ? parseFloat(c.Case_Response_Time_Hours__c.toFixed(1))
        : null,
      hot: Math.round((now - created) / 86400000) > 90,
    };
  });

  const sortedCases = [...parsedCases].sort((a, b) => {
    const av = a[sortCol] ?? null;
    const bv = b[sortCol] ?? null;
    // Nulls always sort to the bottom
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const filteredCases = caseFilter === 'all'
    ? sortedCases
    : sortedCases.filter(c => c.status === caseFilter);

  // Dynamic period labels
  const PERIOD_LABEL = {
    today: 'Today', yesterday: 'Yesterday',
    week: 'This Week', last_week: 'Last Week',
    month: 'This Month', last_month: 'Last Month',
  };
  const PRIOR_LABEL = { today: 'Yesterday', week: 'Last Week', last_week: 'Week Before', month: 'Last Month', last_month: '2 Months Ago' };
  const periodLabel = customRangeMode && customStartDate && customEndDate
    ? `${customStartDate} – ${customEndDate}`
    : (PERIOD_LABEL[periodFilter] ?? 'This Week');
  const priorLabel  = customRangeMode ? null : (PRIOR_LABEL[periodFilter] ?? 'Prior Period');

  // WoW
  const wow    = hasPrior ? closedPeriod - closedPriorPeriod : null;
  const wowCls = wow == null ? 'text-muted' : wow > 0 ? 'text-success' : wow < 0 ? 'text-danger' : 'text-muted';
  const wowStr = wow == null ? '—' : wow > 0 ? `+${wow}` : `${wow}`;

  // KPI metrics — WFM fields (availPct, prodTimePct, contactsHr, fcrPct) are not in SF
  const metrics = [
    { label: 'Open Cases',                value: rep.openCases,             goal: goals.maxOpen,       lower: true  },
    { label: 'On Hold',                   value: rep.holdCases,             goal: goals.maxOnHold,     lower: true  },
    { label: `Closed ${periodLabel}`,     value: closedPeriod,              goal: goals.closedDay * 5, lower: false },
    { label: 'Avg Response',              value: avgResponseHrs.toFixed(1), goal: goals.responseHrs,   lower: true,  unit: 'h', goalUnit: 'h' },
  ];

  return (
    <div>
      {/* Rep selector */}
      <div className="flex items-center gap-2 mb-4">
        <div className="text-[10px] text-muted font-mono uppercase tracking-[1px]">Select Rep</div>
        <select
          value={activeRep ?? rep.name}
          onChange={e => setSelectedRep(e.target.value)}
          className="bg-surface2 border border-border text-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-accent transition-colors cursor-pointer"
        >
          {repList.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
        </select>
      </div>

      {/* Rep name + team/manager header */}
      <div className="mb-4">
        <div className="text-[18px] font-bold text-text mb-1">{rep.name}</div>
        <div className="text-xs text-muted">{rep.team} · Manager: {findManagerForRep(rep.name)}</div>
      </div>

      {/* 6 KPI cards */}
      <div className="grid gap-3.5 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
        {metrics.map(m => <RepKpiCard key={m.label} {...m} />)}
      </div>

      {/* WoW card */}
      <Card className="mb-4">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-xs font-semibold text-text">WoW — Closed Cases</div>
        </div>
        <CardBody>
          <div className="flex gap-6">
            <div>
              <div className="text-[11px] text-muted mb-1">{periodLabel}</div>
              <div className="text-2xl font-bold font-mono text-text">{closedPeriod}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted mb-1">{hasPrior ? priorLabel : '—'}</div>
              <div className="text-2xl font-bold font-mono text-text">{hasPrior ? closedPriorPeriod : '—'}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted mb-1">Change</div>
              <div className={`text-2xl font-bold font-mono ${wowCls}`}>{wowStr}</div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Cases card */}
      <Card>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="text-xs font-semibold text-text">
            Active Cases ({detailLoading ? '…' : filteredCases.length})
            <span className="ml-2 text-[10px] font-normal text-muted font-mono">
              · perf period: {periodLabel}
            </span>
          </div>
          <select
            value={caseFilter}
            onChange={e => setCaseFilter(e.target.value)}
            className="bg-surface2 border border-border text-text px-2 py-1 rounded-md text-[11px] outline-none focus:border-accent transition-colors cursor-pointer"
          >
            <option value="all">All Statuses</option>
            <option value="New">New</option>
            <option value="Open">Open</option>
            <option value="Pending">Pending</option>
            <option value="On Hold">On Hold</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {[
                  { label: 'Case #',         col: 'caseNum'     },
                  { label: 'Subject',         col: 'subject'     },
                  { label: 'Status',          col: 'status'      },
                  { label: 'Age',             col: 'ageDays'     },
                  { label: 'Last Activity',   col: 'lastActDays' },
                  { label: 'Response',        col: 'responseHrs' },
                ].map(({ label, col }) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap cursor-pointer hover:text-text select-none"
                  >
                    {label}<SortArrow col={col} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detailLoading ? (
                <LoadingRow />
              ) : detailError ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-danger text-xs font-mono">
                    Error loading cases: {detailError}
                  </td>
                </tr>
              ) : filteredCases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted text-xs font-mono">
                    No cases match this filter
                  </td>
                </tr>
              ) : filteredCases.map((c, i) => {
                const sfUrl      = `${SF_BASE}${c.sfId}/view`;
                const ageColor   = c.ageDays > 90 ? 'text-danger' : c.ageDays > 30 ? 'text-warn' : 'text-muted';
                const actColor   = c.lastActDays > 14 ? 'text-danger' : c.lastActDays > 7 ? 'text-warn' : 'text-muted';
                const respColor  = c.responseHrs != null && c.responseHrs > goals.responseHrs ? 'text-danger' : 'text-muted';
                return (
                  <tr key={i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      {c.hot && <span className="mr-1 text-warn">🔥</span>}
                      <a href={sfUrl} target="_blank" rel="noreferrer"
                        className="font-mono text-[11px] text-accent hover:underline cursor-pointer">
                        {c.caseNum}
                      </a>
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap" title={c.subject}>
                      {c.subject}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${ageColor}`}>
                      {c.ageDays}d
                    </td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${actColor}`}>
                      {c.lastActDays}d ago
                    </td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${respColor}`}>
                      {c.responseHrs != null ? `${c.responseHrs}h` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
