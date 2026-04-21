import { useState, useEffect } from 'react';
import { useDashboard } from '../context/DashboardContext';
import { useManagerData } from '../data/useManagerData';
import { parseManagerData } from '../data/parseManagerData';
import { useRepDetail } from '../data/useRepDetail';
import { apiFetch } from '../data/apiFetch.js';
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
function RepKpiCard({ label, value, unit = '', goal, goalUnit = '', lower = false, note = null }) {
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
      {note && (
        <div className="text-[10px] text-muted italic mt-1 leading-tight">{note}</div>
      )}
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
      <td colSpan={7} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">
        Loading cases…
      </td>
    </tr>
  );
}

// ── Confirmation modal ────────────────────────────────────────────────────────
function ConfirmModal({ caseNum, isArchived, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      {/* Dialog */}
      <div className="relative z-10 bg-surface border border-border rounded-xl shadow-2xl p-6 w-[340px]">
        <div className="text-sm font-semibold text-text mb-1">
          {isArchived ? 'Restore case?' : 'Archive case?'}
        </div>
        <div className="text-xs text-muted mb-5 leading-relaxed">
          {isArchived
            ? <>Case <span className="font-mono text-accent">{caseNum}</span> will be moved back to the active list.</>
            : <>Case <span className="font-mono text-accent">{caseNum}</span> will be hidden from the active list and stored in the Archived section.</>
          }
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-text hover:border-border/80 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-md bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30 font-medium transition-colors cursor-pointer"
          >
            {isArchived ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function RepDetail() {
  const { selectedRep, setSelectedRep, repFilter, goals, periodFilter, customRangeMode, customStartDate, customEndDate } = useDashboard();
  const [caseFilter, setCaseFilter]   = useState('all');
  const [sortCol, setSortCol]         = useState('ageDays');
  const [sortDir, setSortDir]         = useState('desc');
  const [archivedIds, setArchivedIds] = useState(new Set());
  const [casesView, setCasesView]     = useState('active');
  const [dropdownId, setDropdownId]   = useState(null); // sfId of row with open ⋮ menu
  const [modalCase, setModalCase]     = useState(null); // { sfId, caseNum, isArchived }

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  function SortArrow({ col }) {
    if (sortCol !== col) return <span className="ml-1 text-border">↕</span>;
    return <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const { data: mgrRaw, loading: mgrLoading } = useManagerData();
  const { reps: repList = [] } = parseManagerData(mgrRaw) ?? {};

  const activeRep = repFilter !== 'all' ? repFilter : selectedRep;
  const rep = repList.find(r => r.name === activeRep) ?? repList[0];

  const { data: detail, loading: detailLoading, error: detailError } = useRepDetail(
    rep?.id, periodFilter,
    customRangeMode ? customStartDate : undefined,
    customRangeMode ? customEndDate   : undefined,
  );

  useEffect(() => {
    if (!rep?.id) return;
    setArchivedIds(new Set());
    setDropdownId(null);
    setModalCase(null);
    apiFetch(`/api/archived-cases/${rep.id}`)
      .then(r => r.json())
      .then(data => setArchivedIds(new Set(data.ids ?? [])))
      .catch(() => {});
  }, [rep?.id]);

  async function archiveCase(sfId) {
    setModalCase(null);
    setArchivedIds(prev => new Set([...prev, sfId]));
    try {
      await apiFetch('/api/archive-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: sfId, repId: rep.id }),
      });
    } catch {
      setArchivedIds(prev => { const s = new Set(prev); s.delete(sfId); return s; });
    }
  }

  async function unarchiveCase(sfId) {
    setModalCase(null);
    setArchivedIds(prev => { const s = new Set(prev); s.delete(sfId); return s; });
    try {
      await apiFetch(`/api/archive-case/${sfId}`, { method: 'DELETE' });
    } catch {
      setArchivedIds(prev => new Set([...prev, sfId]));
    }
  }

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
  const avgResponseHrsAll = detail?.avgResponseHrsAll != null
    ? parseFloat(detail.avgResponseHrsAll.toFixed(1))
    : null;

  const csatScores = (detail?.csatData?.records ?? [])
    .map(r => parseFloat(r.Satisfaction_Score__c))
    .filter(v => !isNaN(v));
  const instascore = csatScores.length > 0
    ? parseFloat((csatScores.reduce((s, v) => s + v, 0) / csatScores.length).toFixed(1))
    : 0;

  const rawCases = detail?.cases?.records ?? [];
  const parsedCases = rawCases.map(c => {
    const created  = new Date(c.CreatedDate).getTime();
    const modified = new Date(c.LastModifiedDate).getTime();
    return {
      sfId:        c.Id,
      caseNum:     c.CaseNumber,
      subject:     c.Subject ?? '—',
      status:      c.Status,
      ageDays:     Math.round((now - created) / 86400000),
      lastActDays: Math.round((now - modified) / 86400000),
      responseHrs: c.Case_Response_Time_Hours__c != null
        ? parseFloat(c.Case_Response_Time_Hours__c.toFixed(1))
        : null,
      hot: Math.round((now - created) / 86400000) > 90,
    };
  });

  const sortedCases = [...parsedCases].sort((a, b) => {
    const av = a[sortCol] ?? null;
    const bv = b[sortCol] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const filteredCases = caseFilter === 'all'
    ? sortedCases
    : sortedCases.filter(c => c.status === caseFilter);

  const activeCases   = filteredCases.filter(c => !archivedIds.has(c.sfId));
  const archivedCases = parsedCases.filter(c => archivedIds.has(c.sfId));

  const PERIOD_LABEL = {
    today: 'Today', yesterday: 'Yesterday',
    week: 'This Week', last_week: 'Last Week',
    month: 'This Month', last_month: 'Last Month',
  };
  const PRIOR_LABEL = { today: 'Yesterday', week: 'Last Week', last_week: 'Week Before', month: 'Last Month', last_month: '2 Months Ago' };
  const periodLabel = customRangeMode && customStartDate && customEndDate
    ? `${customStartDate} – ${customEndDate}`
    : (PERIOD_LABEL[periodFilter] ?? 'This Week');
  const priorLabel = customRangeMode ? null : (PRIOR_LABEL[periodFilter] ?? 'Prior Period');

  const wow    = hasPrior ? closedPeriod - closedPriorPeriod : null;
  const wowCls = wow == null ? 'text-muted' : wow > 0 ? 'text-success' : wow < 0 ? 'text-danger' : 'text-muted';
  const wowStr = wow == null ? '—' : wow > 0 ? `+${wow}` : `${wow}`;

  const isEarlyPeriod   = periodFilter === 'today' || periodFilter === 'week';
  const earlyPeriodNote = 'No closed cases yet — expected early in the period';

  const metrics = [
    { label: 'Open Cases',            value: rep.openCases,             goal: goals.maxOpen,       lower: true  },
    { label: 'On Hold',               value: rep.holdCases,             goal: goals.maxOnHold,     lower: true  },
    { label: `Closed ${periodLabel}`, value: closedPeriod,              goal: goals.closedDay * 5, lower: false,
      note: isEarlyPeriod && closedPeriod === 0 ? earlyPeriodNote : null },
    { label: 'Avg Response',          value: avgResponseHrs.toFixed(1), goal: goals.responseHrs,   lower: true, unit: 'h', goalUnit: 'h',
      note: isEarlyPeriod && avgResponseHrs === 0
        ? earlyPeriodNote
        : avgResponseHrs === 0 && avgResponseHrsAll != null
          ? `No closed avg — ${avgResponseHrsAll}h incl. open cases`
          : avgResponseHrsAll != null
            ? `${avgResponseHrsAll}h incl. open cases`
            : null },
  ];

  const COL_HEADERS = [
    { label: 'Case #',        col: 'caseNum'     },
    { label: 'Subject',       col: 'subject'     },
    { label: 'Status',        col: 'status'      },
    { label: 'Age',           col: 'ageDays'     },
    { label: 'Last Activity', col: 'lastActDays' },
    { label: 'Response',      col: 'responseHrs' },
  ];

  function CaseRow({ c, isArchived }) {
    const sfUrl    = `${SF_BASE}${c.sfId}/view`;
    const ageColor = c.ageDays > 90 ? 'text-danger' : c.ageDays > 30 ? 'text-warn' : 'text-muted';
    const actColor = c.lastActDays > 14 ? 'text-danger' : c.lastActDays > 7 ? 'text-warn' : 'text-muted';
    const respColor = c.responseHrs != null && c.responseHrs > goals.responseHrs ? 'text-danger' : 'text-muted';
    const isOpen = dropdownId === c.sfId;

    return (
      <tr className="hover:bg-surface2 transition-colors">
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
          {c.responseHrs != null
            ? `${c.responseHrs}h`
            : (
              <span title="Client has not yet responded to this ticket" className="cursor-help text-muted">
                — <span className="text-[9px] italic">pending</span>
              </span>
            )
          }
        </td>
        {/* Three-dot menu */}
        <td className="px-2 py-2.5 text-xs border-b border-border/50 w-8 text-right">
          <div className="relative inline-block">
            <button
              onClick={() => setDropdownId(isOpen ? null : c.sfId)}
              className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-text hover:bg-surface2 transition-colors cursor-pointer text-base leading-none"
              title="More options"
            >
              ⋮
            </button>
            {isOpen && (
              <>
                {/* Click-away overlay */}
                <div className="fixed inset-0 z-10" onClick={() => setDropdownId(null)} />
                {/* Dropdown */}
                <div className="absolute right-0 top-7 z-20 bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[120px]">
                  <button
                    onClick={() => {
                      setDropdownId(null);
                      setModalCase({ sfId: c.sfId, caseNum: c.caseNum, isArchived });
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface2 transition-colors cursor-pointer"
                  >
                    {isArchived ? '↩ Restore' : '📦 Archive'}
                  </button>
                </div>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div>
      {/* Confirmation modal */}
      {modalCase && (
        <ConfirmModal
          caseNum={modalCase.caseNum}
          isArchived={modalCase.isArchived}
          onConfirm={() => modalCase.isArchived ? unarchiveCase(modalCase.sfId) : archiveCase(modalCase.sfId)}
          onCancel={() => setModalCase(null)}
        />
      )}

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

      {/* KPI cards */}
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
          <div className="flex items-center gap-0">
            <button
              onClick={() => { setCasesView('active'); setDropdownId(null); }}
              className={`px-3 py-1 text-xs font-medium rounded-md mr-1 transition-colors cursor-pointer ${
                casesView === 'active' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'
              }`}
            >
              Active ({detailLoading ? '…' : activeCases.length})
            </button>
            <button
              onClick={() => { setCasesView('archived'); setDropdownId(null); }}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                casesView === 'archived' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'
              }`}
            >
              Archived ({archivedCases.length})
            </button>
            <span className="ml-3 text-[10px] font-normal text-muted font-mono">
              · perf period: {periodLabel}
            </span>
          </div>
          {casesView === 'active' && (
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
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {COL_HEADERS.map(({ label, col }) => (
                  <th
                    key={col}
                    onClick={() => casesView === 'active' && toggleSort(col)}
                    className={`text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap ${casesView === 'active' ? 'cursor-pointer hover:text-text select-none' : 'cursor-default'}`}
                  >
                    {label}{casesView === 'active' && <SortArrow col={col} />}
                  </th>
                ))}
                <th className="px-2 py-2.5 border-b border-border w-8" />
              </tr>
            </thead>
            <tbody>
              {detailLoading ? (
                <LoadingRow />
              ) : detailError ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-danger text-xs font-mono">
                    Error loading cases: {detailError}
                  </td>
                </tr>
              ) : casesView === 'active' ? (
                activeCases.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted text-xs font-mono">
                      No active cases in this period
                    </td>
                  </tr>
                ) : activeCases.map(c => <CaseRow key={c.sfId} c={c} isArchived={false} />)
              ) : (
                archivedCases.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted text-xs font-mono">
                      No archived cases
                    </td>
                  </tr>
                ) : archivedCases.map(c => <CaseRow key={c.sfId} c={c} isArchived={true} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
