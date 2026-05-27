import { useState, useEffect } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useManagerData } from '../data/useManagerData';
import { parseManagerData } from '../data/parseManagerData';
import { useRepDetail } from '../data/useRepDetail';
import { useProductivityHourly } from '../data/useProductivityHourly';
import { useProductivityWeekly } from '../data/useProductivityWeekly';
import { apiFetch } from '../data/apiFetch.js';
import { Card, CardBody } from '../components/ui/Card';
import { getRepChannelType } from '../data/getRepChannelType';
import { STATUS_COLORS, HOURLY_CHART_OPTS, WEEKLY_CHART_OPTS, buildHourlyChartData, buildWeeklyChartData, fmtDuration } from '../data/productivityUtils';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

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

// ── Seconds → "Xm Ys" ────────────────────────────────────────────────────────
function fmtSecs(s) {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

// ── Talkdesk stat card ────────────────────────────────────────────────────────
function TdStatCard({ label, value, sub, corner, loading }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] p-4 pt-5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
      {corner && (
        <div className="absolute top-2 right-2.5 text-[10px] font-mono text-muted">
          {corner}
        </div>
      )}
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none mb-1">{loading ? '…' : value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

// ── MRR Added card (no goal — shows delta vs prior period) ───────────────────
function MrrCard({ total, prior, priorLabel, upgradeCount, loading }) {
  const delta = prior != null ? total - prior : null;
  const deltaColor = delta == null ? 'text-muted' : delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-muted';
  const deltaStr   = delta == null ? null
    : delta > 0 ? `+$${delta.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : delta < 0 ? `-$${Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : '—';
  return (
    <div className="bg-surface border border-border rounded-[10px] p-4 pt-5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">MRR Added</div>
      <div className="text-2xl font-bold font-mono leading-none mb-1">
        {loading ? '…' : `$${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
      </div>
      {deltaStr ? (
        <div className={`text-[10px] font-mono mt-1 ${deltaColor}`}>{deltaStr} vs {priorLabel}</div>
      ) : (
        <div className="text-[10px] text-muted mt-1">{loading ? '' : `${upgradeCount} upgrade${upgradeCount !== 1 ? 's' : ''}`}</div>
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

// ── Toast notification ────────────────────────────────────────────────────────
function Toast({ message, type }) {
  const bg = type === 'success' ? 'bg-success/15 border-success/30 text-success' : 'bg-danger/15 border-danger/30 text-danger';
  const icon = type === 'success' ? '✓' : '✗';
  return (
    <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg border text-xs font-medium shadow-lg ${bg}`}>
      <span className="font-mono">{icon}</span>
      {message}
    </div>
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
  const { selectedRep, repFilter, goals, periodFilter, customRangeMode, customStartDate, customEndDate, repList: sfRepList } = useDashboard();
  const [caseFilter, setCaseFilter]   = useState('all');
  const [sortCol, setSortCol]         = useState('ageDays');
  const [sortDir, setSortDir]         = useState('desc');
  const [archivedIds, setArchivedIds] = useState(new Set());
  const [casesView, setCasesView]     = useState('active');
  const [dropdownId, setDropdownId]       = useState(null);
  const [modalCase, setModalCase]         = useState(null);
  const [toast, setToast]                 = useState(null);
  const [manuallyRestoredIds, setManuallyRestoredIds] = useState(new Set());
  const [instaData, setInstaData]       = useState(null);
  const [instaLoading, setInstaLoading] = useState(false);
  const [heatSortDir, setHeatSortDir]         = useState('asc');
  const [heatExpanded, setHeatExpanded]       = useState(false);
  const [sectionSortDir, setSectionSortDir]     = useState('asc');
  const [sectionExpanded, setSectionExpanded]   = useState(false);
  const [questionSortDir, setQuestionSortDir]   = useState('asc');
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [rubricSortDir, setRubricSortDir]       = useState('asc');
  const [rubricExpanded, setRubricExpanded]     = useState(false);
  const [convoExpanded, setConvoExpanded]       = useState(false);
  const [mrrExpanded, setMrrExpanded]           = useState(false);
  const [tdCallsExpanded, setTdCallsExpanded]   = useState(false);
  const [sfChatsExpanded, setSfChatsExpanded]   = useState(false);
  const [emailsExpanded, setEmailsExpanded]     = useState(false);
  const [prodExpanded, setProdExpanded]         = useState(false);
  const [convoSortCol, setConvoSortCol]         = useState('conversation_date');
  const [convoSortDir, setConvoSortDir]         = useState('desc');
  const [subTab, setSubTab]                     = useState('overview');

  const SUB_TABS = [
    { id: 'overview',     label: 'Overview' },
    { id: 'productivity', label: 'Productivity' },
    { id: 'quality',      label: 'Quality' },
    { id: 'activity',     label: 'Activity' },
    { id: 'cases',        label: 'Cases' },
  ];

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

  // Look up rep — exact match first, then case-insensitive fallback
  const activeRepLower = activeRep?.toLowerCase() ?? '';
  const rep = repList.find(r => r.name === activeRep)
    ?? repList.find(r => r.name.toLowerCase() === activeRepLower)
    ?? repList[0];

  // The SF rep entry (has the canonical ID even when parseManagerData hasn't loaded yet)
  const sfRep = sfRepList.find(r => r.name === activeRep)
    ?? sfRepList.find(r => r.name.toLowerCase() === activeRepLower);
  const repNotInSF = activeRep && sfRepList.length > 0 && !sfRep;


  const repId = repNotInSF ? null : (sfRep?.id ?? rep?.id);
  const channelType = getRepChannelType(sfRep?.name ?? rep?.name ?? activeRep ?? '');
  const { data: hourlyData, loading: hourlyLoading } = useProductivityHourly(
    repId, periodFilter,
    customRangeMode ? customStartDate : undefined,
    customRangeMode ? customEndDate   : undefined,
  );
  const { data: weeklyData, loading: weeklyLoading } = useProductivityWeekly(
    repId, periodFilter,
    customRangeMode ? customStartDate : undefined,
    customRangeMode ? customEndDate   : undefined,
  );
  const { data: detail, loading: detailLoading, error: detailError } = useRepDetail(
    repId, periodFilter,
    customRangeMode ? customStartDate : undefined,
    customRangeMode ? customEndDate   : undefined,
    channelType,
  );

  useEffect(() => {
    if (!repId) return;
    setArchivedIds(new Set());
    setManuallyRestoredIds(new Set());
    setDropdownId(null);
    setModalCase(null);
    apiFetch(`/api/archived-cases/${repId}`)
      .then(r => r.json())
      .then(data => setArchivedIds(new Set(data.ids ?? [])))
      .catch(() => {});
  }, [repId]);

  useEffect(() => {
    if (!repId) return;
    setInstaData(null);
    setInstaLoading(true);
    const params = new URLSearchParams({ ownerId: repId, period: periodFilter });
    if (customRangeMode && customStartDate && customEndDate) {
      params.set('startDate', customStartDate);
      params.set('endDate', customEndDate);
    }
    apiFetch(`/api/instascore?${params}`)
      .then(r => r.json())
      .then(data => setInstaData(data))
      .catch(() => setInstaData(null))
      .finally(() => setInstaLoading(false));
  }, [rep?.id, periodFilter, customRangeMode, customStartDate, customEndDate]);

  function showToast(message, type) {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function archiveCase(sfId) {
    setModalCase(null);
    setArchivedIds(prev => new Set([...prev, sfId]));
    try {
      await apiFetch('/api/archive-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: sfId, repId: rep.id }),
      });
      showToast('Case archived successfully', 'success');
    } catch {
      setArchivedIds(prev => { const s = new Set(prev); s.delete(sfId); return s; });
      showToast('Failed to archive case — please try again', 'error');
    }
  }

  async function unarchiveCase(sfId) {
    setModalCase(null);
    setArchivedIds(prev => { const s = new Set(prev); s.delete(sfId); return s; });
    setManuallyRestoredIds(prev => new Set([...prev, sfId]));
    try {
      await apiFetch(`/api/archive-case/${sfId}`, { method: 'DELETE' });
      showToast('Case restored to active list', 'success');
    } catch {
      setArchivedIds(prev => new Set([...prev, sfId]));
      showToast('Failed to restore case — please try again', 'error');
    }
  }

  if (mgrLoading && sfRepList.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono animate-pulse">
        Loading rep list…
      </div>
    );
  }

  if (repNotInSF) {
    return (
      <div className="p-4">
        <div className="text-warn text-sm font-medium mb-1">"{activeRep}" not found in Salesforce</div>
        <div className="text-muted text-xs">This name doesn't match any active Salesforce user. Check the spelling in <code className="font-mono">orgData.js</code> or confirm the account is active.</div>
      </div>
    );
  }

  if (!rep && !sfRep) {
    return <div className="text-muted text-xs p-4">No rep data available.</div>;
  }

  // ── Parse detail data ────────────────────────────────────────────────────────
  const now = Date.now();

  const closedPeriod      = detail?.closedPeriod      ?? 0;
  const closedPriorPeriod = detail?.closedPriorPeriod  ?? 0;
  const hasPrior          = detail?.hasPrior           ?? true;
  const mrrTotal          = detail?.mrrTotal           ?? 0;
  const mrrPriorTotal     = detail?.mrrPriorTotal      ?? null;
  const mrrUpgrades       = detail?.mrrUpgrades        ?? [];
  const tdStats           = detail?.tdStats            ?? null;
  const tdCalls           = detail?.tdCalls            ?? [];
  const sfChats              = detail?.sfChats              ?? [];
  const chatProductivitySecs = detail?.chatProductivitySecs ?? null;
  const priorPeriod          = detail?.priorPeriod          ?? null;
  const productivity      = detail?.productivity       ?? null;
  const emailStats        = detail?.emailStats          ?? { sentCount: 0 };
  const emails            = detail?.emails              ?? [];
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

  // Merge manual archives + auto-archive (cases ≥ 365 days old), minus user-restored
  const effectiveArchivedIds = new Set([
    ...archivedIds,
    ...parsedCases
      .filter(c => c.ageDays >= 365 && !manuallyRestoredIds.has(c.sfId))
      .map(c => c.sfId),
  ]);

  const activeCases   = filteredCases.filter(c => !effectiveArchivedIds.has(c.sfId));
  const archivedCases = parsedCases.filter(c => effectiveArchivedIds.has(c.sfId));

  // Adjust open/hold counts to exclude archived cases
  const adjOpenCases = Math.max(0, (rep?.openCases ?? 0) - archivedCases.length);
  const adjHoldCases = Math.max(0, (rep?.holdCases ?? 0) - archivedCases.filter(c => c.status === 'On Hold').length);

  const PERIOD_LABEL = {
    yesterday: 'Yesterday',
    week: 'This Week', last_week: 'Last Week',
    month: 'This Month', last_month: 'Last Month',
    last_30: 'Last 30 Days',
  };
  const PRIOR_LABEL = { week: 'Last Week', last_week: 'Week Before', month: 'Last Month', last_month: '2 Months Ago', last_30: 'Prev 30 Days' };
  const periodLabel = customRangeMode && customStartDate && customEndDate
    ? `${customStartDate} – ${customEndDate}`
    : (PERIOD_LABEL[periodFilter] ?? 'This Week');
  const priorLabel = customRangeMode ? null : (PRIOR_LABEL[periodFilter] ?? 'Prior Period');

  const wow    = hasPrior ? closedPeriod - closedPriorPeriod : null;
  const wowCls = wow == null ? 'text-muted' : wow > 0 ? 'text-success' : wow < 0 ? 'text-danger' : 'text-muted';
  const wowStr = wow == null ? '—' : wow > 0 ? `+${wow}` : `${wow}`;

  const isEarlyPeriod   = periodFilter === 'week';
  const earlyPeriodNote = 'No closed cases yet — expected early in the period';

  const metrics = [
    { label: 'Active Cases',           value: adjOpenCases,              goal: goals.maxOpen,       lower: true  },
    { label: 'On Hold',               value: adjHoldCases,              goal: goals.maxOnHold,     lower: true  },
    { label: `Closed ${periodLabel}`, value: closedPeriod,              goal: goals.closedDay * 5, lower: false,
      note: isEarlyPeriod && closedPeriod === 0 ? earlyPeriodNote : null },
    { label: 'Instascore',             value: instaLoading ? '…' : (instaData?.overall != null ? instaData.overall : '—'), goal: goals.instascore, unit: '%', goalUnit: '%',
      note: instaData?.conversationCount > 0 ? `${instaData.conversationCount} conversation${instaData.conversationCount !== 1 ? 's' : ''} scored` : (instaLoading ? null : 'No scored conversations') },
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
      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}

      {/* Confirmation modal */}
      {modalCase && (
        <ConfirmModal
          caseNum={modalCase.caseNum}
          isArchived={modalCase.isArchived}
          onConfirm={() => modalCase.isArchived ? unarchiveCase(modalCase.sfId) : archiveCase(modalCase.sfId)}
          onCancel={() => setModalCase(null)}
        />
      )}

      {/* Sub-tab strip */}
      <div className="mb-4 border-b border-border flex items-center gap-0 overflow-x-auto">
        {SUB_TABS.map(tab => {
          const isActive = subTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`
                px-4 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-all cursor-pointer bg-transparent
                ${isActive ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-text'}
              `}
            >
              {tab.label}
            </button>
          );
        })}
        {(detailLoading || instaLoading) && (
          <svg className="animate-spin w-4 h-4 text-accent shrink-0 ml-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        )}
        {repNotInSF && (
          <span className="text-[10px] text-warn font-mono ml-3">
            "{activeRep}" not found in Salesforce — check name spelling
          </span>
        )}
      </div>

      {subTab === 'overview' && (<>
      {/* KPI cards — grouped by source */}
      <div className="mb-4 flex gap-3 items-stretch">

        {/* Salesforce */}
        <div className="flex-1 min-w-0 bg-surface border border-[#5b8af5]/30 rounded-xl overflow-hidden">
          <div className="h-[3px] bg-[#5b8af5]" />
          <div className="px-4 py-3">
            <div className="text-[10px] text-[#5b8af5] font-mono uppercase tracking-[1px] font-semibold mb-1">Salesforce</div>
            {/* MRR hero */}
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-2xl font-bold font-mono text-text leading-none">
                {detailLoading ? '…' : `$${mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              </span>
              {!detailLoading && mrrPriorTotal != null && (() => {
                const delta = mrrTotal - mrrPriorTotal;
                const pct = mrrPriorTotal !== 0 ? Math.abs(delta / mrrPriorTotal * 100).toFixed(1) : null;
                const up = delta >= 0;
                return (
                  <span className={`text-sm font-mono font-semibold ${up ? 'text-success' : 'text-danger'}`}>
                    {up ? '▲' : '▼'}{pct != null ? ` ${pct}%` : ''}
                  </span>
                );
              })()}
            </div>
            <div className="divide-y divide-border/40">
              {[
                { label: 'Active Cases',             val: adjOpenCases,                    goal: goals.maxOpen,       lower: true  },
                { label: 'On Hold',                 val: adjHoldCases,                    goal: goals.maxOnHold,     lower: true  },
                { label: `Closed (${periodLabel})`, val: closedPeriod,                    goal: goals.closedDay * 5, lower: false },
                { label: 'Avg Response',            val: `${avgResponseHrs.toFixed(1)}h`, goal: goals.responseHrs,   lower: true  },
              ].map(({ label, val, goal, lower }) => {
                const num = parseFloat(val);
                const isGood = lower ? num <= goal : num >= goal;
                const pct = goal > 0
                  ? lower
                    ? Math.max(0, Math.min(100, (1 - num / goal) * 100))
                    : Math.min(100, (num / goal) * 100)
                  : 0;
                return (
                  <div key={label} className="flex items-center justify-between py-2 gap-3">
                    <span className="text-[11px] text-muted shrink-0">{label}</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden shrink-0">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${isGood ? 'bg-success' : 'bg-danger'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold font-mono text-text shrink-0">{detailLoading ? '…' : val}</span>
                      <span className={`text-[10px] font-mono shrink-0 ${isGood ? 'text-success' : 'text-danger'}`}>{isGood ? '✓' : '✗'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Talkdesk */}
        <div className="flex-1 min-w-0 bg-surface border border-[#f5a623]/30 rounded-xl overflow-hidden">
          <div className="h-[3px] bg-[#f5a623]" />
          <div className="px-4 py-3">
            <div className="text-[10px] text-[#f5a623] font-mono uppercase tracking-[1px] font-semibold mb-1">Talkdesk</div>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-2xl font-bold font-mono text-text leading-none">
                {detailLoading ? '…' : (tdStats?.callCount ?? 0)}
              </span>
              <span className="text-[11px] text-muted font-mono">calls</span>
            </div>
            <div className="divide-y divide-border/40">
              {[
                { label: 'Avg Talk Time',       val: fmtSecs(tdStats?.avgTalkSecs) },
                { label: 'Avg Hold Time',       val: fmtSecs(tdStats?.avgHoldSecs) },
                { label: 'Avg Productive Time', val: fmtDuration(productivity?.totalSecs) },
              ].map(({ label, val }) => (
                <div key={label} className="flex items-center justify-between py-2">
                  <span className="text-[11px] text-muted">{label}</span>
                  <span className="text-sm font-bold font-mono text-text">{detailLoading ? '…' : val}</span>
                </div>
              ))}
              {(() => {
                const expSecs = productivity?.expectedSecs ?? (8 * 3600);
                const callProdSecs = (productivity?.availSecs ?? 0) + (productivity?.onCallSecs ?? 0);
                const callPct = expSecs > 0 ? (callProdSecs / expSecs) * 100 : 0;
                const cls = callPct >= 75 ? 'text-success' : callPct >= 50 ? 'text-warn' : 'text-danger';
                return (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[11px] text-muted">Call Productivity</span>
                    <span className={`text-sm font-bold font-mono ${callProdSecs > 0 ? cls : 'text-muted'}`}>
                      {detailLoading ? '…' : (callProdSecs > 0 ? `${callPct.toFixed(1)}%` : '—')}
                    </span>
                  </div>
                );
              })()}
              <div className="flex items-center justify-between py-2">
                <span className="text-[11px] text-muted">Avg CSAT</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted font-mono">
                    {detailLoading ? '' : tdStats?.callCount > 0 ? `${tdStats.csatCount ?? 0}/${tdStats.callCount}` : ''}
                  </span>
                  <span className="text-sm font-bold font-mono text-text">
                    {detailLoading ? '…' : tdStats?.avgCsat != null ? tdStats.avgCsat.toFixed(1) : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 min-w-0 bg-surface border border-[#38d9a9]/30 rounded-xl overflow-hidden">
          <div className="h-[3px] bg-[#38d9a9]" />
          <div className="px-4 py-3">
            <div className="text-[10px] text-[#38d9a9] font-mono uppercase tracking-[1px] font-semibold mb-1">Chat</div>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-2xl font-bold font-mono text-text leading-none">
                {detailLoading ? '…' : sfChats.length}
              </span>
              <span className="text-[11px] text-muted font-mono">chats</span>
            </div>
            {(() => {
              const timedHandle = sfChats.filter(c => c.durationSecs != null && c.durationSecs > 0);
              const timedWait   = sfChats.filter(c => c.waitSecs     != null && c.waitSecs   > 0);
              return (
                <div className="divide-y divide-border/40">
                  {[
                    { label: 'Avg Handle Time',     val: timedHandle.length ? fmtSecs(timedHandle.reduce((s, c) => s + c.durationSecs, 0) / timedHandle.length) : '—' },
                    { label: 'Avg Wait Time',        val: timedWait.length   ? fmtSecs(timedWait.reduce((s, c) => s + c.waitSecs, 0)     / timedWait.length)   : '—' },
                    { label: 'Avg Chat Productive',  val: fmtDuration(chatProductivitySecs) },
                  ].map(({ label, val }) => (
                    <div key={label} className="flex items-center justify-between py-2">
                      <span className="text-[11px] text-muted">{label}</span>
                      <span className="text-sm font-bold font-mono text-text">{detailLoading ? '…' : val}</span>
                    </div>
                  ))}
                  {(() => {
                    const expSecs = productivity?.expectedSecs ?? (8 * 3600);
                    const chatSecs = chatProductivitySecs ?? 0;
                    const chatPct = expSecs > 0 ? (chatSecs / expSecs) * 100 : 0;
                    const cls = chatPct >= 75 ? 'text-success' : chatPct >= 50 ? 'text-warn' : 'text-danger';
                    return (
                      <div className="flex items-center justify-between py-2">
                        <span className="text-[11px] text-muted">Chat Productivity</span>
                        <span className={`text-sm font-bold font-mono ${chatSecs > 0 ? cls : 'text-muted'}`}>
                          {detailLoading ? '…' : (chatSecs > 0 ? `${chatPct.toFixed(1)}%` : '—')}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Emails */}
        <div className="flex-1 min-w-0 bg-surface border border-[#e05c5c]/30 rounded-xl overflow-hidden">
          <div className="h-[3px] bg-[#e05c5c]" />
          <div className="px-4 py-3">
            <div className="text-[10px] text-[#e05c5c] font-mono uppercase tracking-[1px] font-semibold mb-1">Emails</div>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-2xl font-bold font-mono text-text leading-none">
                {detailLoading ? '…' : emailStats.sentCount}
              </span>
              <span className="text-[11px] text-muted font-mono">sent</span>
            </div>
            {(() => {
              const withCase = emails.filter(e => e.caseId).length;
              const orphan   = emails.length - withCase;
              const priorCnt = priorPeriod?.emailSentCount ?? null;
              const delta    = priorCnt != null ? emailStats.sentCount - priorCnt : null;
              const deltaColor = delta == null ? 'text-muted' : delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-muted';
              const deltaStr   = delta == null ? null : `${delta > 0 ? '+' : ''}${delta} vs ${priorLabel}`;
              return (
                <div className="divide-y divide-border/40">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[11px] text-muted">With Case</span>
                    <span className="text-sm font-bold font-mono text-text">{detailLoading ? '…' : withCase}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[11px] text-muted">No Case Link</span>
                    <span className="text-sm font-bold font-mono text-text">{detailLoading ? '…' : orphan}</span>
                  </div>
                  {deltaStr && (
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[11px] text-muted">WoW</span>
                      <span className={`text-xs font-bold font-mono ${deltaColor}`}>{detailLoading ? '…' : deltaStr}</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* LevelAI + Productivity column */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* LevelAI */}
          <div className="bg-surface border border-[#a855f7]/30 rounded-xl overflow-hidden">
            <div className="h-[3px] bg-[#a855f7]" />
            <div className="px-4 py-3">
              <div className="text-[10px] text-[#a855f7] font-mono uppercase tracking-[1px] font-semibold mb-1">LevelAI</div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-2xl font-bold font-mono text-text leading-none">
                  {instaLoading ? '…' : instaData?.overall != null ? `${instaData.overall}%` : '—'}
                </span>
                {instaData?.overall != null && (
                  <span className={`text-sm font-mono font-semibold ${instaData.overall >= goals.instascore ? 'text-success' : 'text-danger'}`}>
                    {instaData.overall >= goals.instascore ? '✓' : '✗'}
                  </span>
                )}
              </div>
              {instaData?.overall != null && (
                <div className="mb-3">
                  <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${instaData.overall >= goals.instascore ? 'bg-success' : 'bg-danger'}`}
                      style={{ width: `${Math.min(100, (instaData.overall / goals.instascore) * 100)}%` }}
                    />
                  </div>
                  <div className="text-[9px] text-muted font-mono mt-1">Goal: {goals.instascore}%</div>
                </div>
              )}
              <div className="divide-y divide-border/40">
                {instaData?.conversationCount > 0 && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[11px] text-muted">Conversations Scored</span>
                    <span className="text-sm font-bold font-mono text-text">{instaData.conversationCount}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Productivity */}
          {productivity && (() => {
            const pct       = productivity.productivityPct ?? 0;
            const priorPct  = priorPeriod?.productivityPct ?? null;
            const delta     = priorPct != null ? pct - priorPct : null;
            const variant   = pct >= 75 ? 'success' : pct >= 50 ? 'warn' : 'danger';
            const stripeBg  = variant === 'success' ? '#38d9a9' : variant === 'warn' ? '#f5a623' : '#e05c5c';
            const stripeBorder = variant === 'success' ? 'border-success/30' : variant === 'warn' ? 'border-warn/30' : 'border-danger/30';
            const barColor  = variant === 'success' ? 'bg-success' : variant === 'warn' ? 'bg-warn' : 'bg-danger';
            const textColor = variant === 'success' ? 'text-success' : variant === 'warn' ? 'text-warn' : 'text-danger';
            const deltaColor = delta == null ? 'text-muted' : delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-muted';
            const deltaStr   = delta == null ? null : `${delta > 0 ? '▲' : delta < 0 ? '▼' : ''} ${Math.abs(delta).toFixed(1)}%`;
            return (
              <div className={`bg-surface border ${stripeBorder} rounded-xl overflow-hidden`}>
                <div className="h-[3px]" style={{ backgroundColor: stripeBg }} />
                <div className="px-4 py-3">
                  <div className={`text-[10px] font-mono uppercase tracking-[1px] font-semibold mb-1 ${textColor}`}>Productivity</div>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-2xl font-bold font-mono text-text leading-none">
                      {detailLoading ? '…' : `${pct.toFixed(1)}%`}
                    </span>
                    {!detailLoading && deltaStr && (
                      <span className={`text-xs font-mono font-semibold ${deltaColor}`}>{deltaStr}</span>
                    )}
                  </div>
                  <div className="mb-2">
                    <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div className="text-[9px] text-muted font-mono mt-1">
                      {fmtDuration(productivity.totalSecs)} / {fmtDuration(productivity.expectedSecs)} per day
                    </div>
                  </div>
                  <div className={`text-[10px] font-mono ${textColor}`}>
                    {variant === 'success' ? '✓ On track (≥ 75%)' : variant === 'warn' ? '◐ Below target (50–75%)' : '✗ Off track (< 50%)'}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

      </div>

      {/* Period over Period — moved here from below */}
      {hasPrior && (
        <Card className="mb-4">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="text-xs font-semibold text-text">Period over Period</div>
            <div className="text-[10px] text-muted font-mono">{priorLabel} → {periodLabel}</div>
          </div>
          <CardBody>
            {(() => {
              function DeltaVal({ curr, prior, lower = false, fmt = 'num' }) {
                if (curr == null || prior == null) return <span className="text-muted font-mono text-[11px]">—</span>;
                const diff = curr - prior;
                if (diff === 0) return <span className="text-muted font-mono text-[11px]">—</span>;
                const isGood = lower ? diff < 0 : diff > 0;
                const cls = isGood ? 'text-success' : 'text-danger';
                const sign = diff > 0 ? '+' : '';
                let str;
                if (fmt === 'secs')    str = `${diff > 0 ? '+' : ''}${fmtSecs(Math.abs(diff))}`;
                else if (fmt === 'dur') str = `${diff > 0 ? '+' : '-'}${fmtDuration(Math.abs(diff))}`;
                else if (fmt === 'usd') str = `${diff > 0 ? '+' : '-'}$${Math.abs(diff).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                else if (fmt === 'pct') str = `${sign}${Math.abs(diff).toFixed(1)}%`;
                else str = `${sign}${diff}`;
                return <span className={`font-mono font-semibold text-[11px] ${cls}`}>{str}</span>;
              }

              function WowRow({ label, curr, prior, currNum, priorNum, lower, deltaFmt }) {
                const deltacurr  = currNum  != null ? currNum  : (typeof curr  === 'string' ? parseFloat(curr)  : curr);
                const deltaprior = priorNum != null ? priorNum : (typeof prior === 'string' ? parseFloat(prior) : prior);
                return (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[11px] text-muted shrink-0">{label}</span>
                    <div className="flex items-center gap-3 font-mono text-[11px]">
                      <span className="text-muted">{prior ?? '—'}</span>
                      <span className="text-white">→</span>
                      <span className="text-text font-semibold">{curr ?? '—'}</span>
                      <DeltaVal curr={deltacurr} prior={deltaprior} lower={lower} fmt={deltaFmt ?? 'num'} />
                    </div>
                  </div>
                );
              }

              const timedHandle = sfChats.filter(c => c.durationSecs != null && c.durationSecs > 0);
              const timedWait   = sfChats.filter(c => c.waitSecs      != null && c.waitSecs   > 0);
              const avgHandle   = timedHandle.length ? timedHandle.reduce((s, c) => s + c.durationSecs, 0) / timedHandle.length : null;
              const avgWait     = timedWait.length   ? timedWait.reduce((s, c)   => s + c.waitSecs,   0)  / timedWait.length   : null;

              return (
                <div className="flex gap-4">

                  {/* Salesforce */}
                  <div className="flex-1 min-w-0 rounded-xl p-3 bg-[#5b8af5]/5 border border-[#5b8af5]/20">
                    <div className="text-[10px] text-[#5b8af5] font-mono uppercase tracking-[1px] font-semibold mb-1">Salesforce</div>
                    <div className="divide-y divide-border/40">
                      <WowRow label="Closed Cases" curr={closedPeriod}                    prior={priorPeriod?.closedCases}  lower={false} />
                      <WowRow label="MRR Added"    curr={`$${mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} prior={priorPeriod?.mrrTotal != null ? `$${priorPeriod.mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null} currNum={mrrTotal} priorNum={priorPeriod?.mrrTotal ?? null} lower={false} deltaFmt="usd" />
                      <WowRow label="Avg Response" curr={`${avgResponseHrs.toFixed(1)}h`} prior={priorPeriod?.avgResponseHrs != null ? `${priorPeriod.avgResponseHrs.toFixed(1)}h` : null} lower={true} deltaFmt="pct" />
                      <WowRow label="Emails Sent"  curr={emailStats.sentCount}            prior={priorPeriod?.emailSentCount} lower={false} />
                    </div>
                  </div>

                  {/* Talkdesk */}
                  <div className="flex-1 min-w-0 rounded-xl p-3 bg-[#f5a623]/5 border border-[#f5a623]/20">
                    <div className="text-[10px] text-[#f5a623] font-mono uppercase tracking-[1px] font-semibold mb-1">Talkdesk</div>
                    <div className="divide-y divide-border/40">
                      <WowRow label="Total Calls"     curr={tdStats?.callCount ?? 0}                                                   prior={priorPeriod?.tdCallCount}                                                    lower={false} />
                      <WowRow label="Avg Talk Time"   curr={fmtSecs(tdStats?.avgTalkSecs)}                                             prior={fmtSecs(priorPeriod?.tdAvgTalkSecs)}                                         lower={false} deltaFmt="secs" />
                      <WowRow label="Avg Hold Time"   curr={fmtSecs(tdStats?.avgHoldSecs)}                                             prior={fmtSecs(priorPeriod?.tdAvgHoldSecs)}                                         lower={true}  deltaFmt="secs" />
                      <WowRow label="Avg CSAT"        curr={tdStats?.avgCsat != null ? tdStats.avgCsat.toFixed(1) : null}              prior={priorPeriod?.tdAvgCsat != null ? priorPeriod.tdAvgCsat.toFixed(1) : null}    lower={false} deltaFmt="pct" />
                      <WowRow label="Productive Time" curr={fmtDuration(productivity?.totalSecs)}                                      prior={fmtDuration(priorPeriod?.tdProductivitySecs)}                                lower={false} deltaFmt="dur" />
                      <WowRow
                        label="Productivity %"
                        curr={productivity?.productivityPct != null ? `${productivity.productivityPct.toFixed(1)}%` : null}
                        prior={priorPeriod?.productivityPct != null ? `${priorPeriod.productivityPct.toFixed(1)}%` : null}
                        currNum={productivity?.productivityPct ?? null}
                        priorNum={priorPeriod?.productivityPct ?? null}
                        lower={false}
                        deltaFmt="pct"
                      />
                    </div>
                  </div>

                  {/* Chat */}
                  <div className="flex-1 min-w-0 rounded-xl p-3 bg-[#38d9a9]/5 border border-[#38d9a9]/20">
                    <div className="text-[10px] text-[#38d9a9] font-mono uppercase tracking-[1px] font-semibold mb-1">Chat</div>
                    <div className="divide-y divide-border/40">
                      <WowRow label="Total Chats"     curr={sfChats.length}              prior={priorPeriod?.chatCount}                        lower={false} />
                      <WowRow label="Avg Handle"      curr={fmtSecs(avgHandle)}           prior={fmtSecs(priorPeriod?.chatAvgHandleSecs)}       lower={false} deltaFmt="secs" />
                      <WowRow label="Avg Wait"         curr={fmtSecs(avgWait)}             prior={fmtSecs(priorPeriod?.chatAvgWaitSecs)}         lower={true}  deltaFmt="secs" />
                      <WowRow label="Productive Time" curr={fmtDuration(chatProductivitySecs)} prior={fmtDuration(priorPeriod?.chatProductivitySecs)} lower={false} deltaFmt="dur" />
                    </div>
                  </div>

                  {/* LevelAI */}
                  <div className="flex-1 min-w-0 rounded-xl p-3 bg-[#a855f7]/5 border border-[#a855f7]/20">
                    <div className="text-[10px] text-[#a855f7] font-mono uppercase tracking-[1px] font-semibold mb-1">LevelAI</div>
                    <div className="divide-y divide-border/40">
                      <WowRow
                        label="Instascore"
                        curr={instaData?.overall != null ? `${instaData.overall}%` : null}
                        prior={priorPeriod?.instascore != null ? `${priorPeriod.instascore}%` : null}
                        lower={false}
                        deltaFmt="pct"
                      />
                    </div>
                  </div>

                </div>
              );
            })()}
          </CardBody>
        </Card>
      )}
      </>)}

      {subTab === 'productivity' && (<>
      {/* Productivity breakdown */}
      {productivity && (
        <Card className="mb-4">
          <button
            onClick={() => setProdExpanded(e => !e)}
            className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
          >
            <span className="text-xs font-semibold text-text">Productivity Breakdown</span>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted font-mono capitalize">{channelType} rep · {periodLabel}</span>
              <span className="text-muted text-xs">{prodExpanded ? '▲' : '▼'}</span>
            </div>
          </button>
          {prodExpanded && (
            <div className="px-4 py-3">
              {productivity.totalSecs === 0 ? (
                <div className="text-[11px] text-muted italic">No productivity data for this period</div>
              ) : (
                <table className="w-full text-xs font-mono">
                  <tbody>
                    {(channelType === 'calls' || channelType === 'mixed') && (
                      <>
                        <tr>
                          <td className="py-1.5 text-muted">Available</td>
                          <td className="py-1.5 text-right text-text">{fmtDuration(productivity.availSecs)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted">On a Call</td>
                          <td className="py-1.5 text-right text-text">{fmtDuration(productivity.onCallSecs)}</td>
                        </tr>
                      </>
                    )}
                    {(channelType === 'chats' || channelType === 'mixed') && (
                      <tr>
                        <td className="py-1.5 text-muted">Chat</td>
                        <td className="py-1.5 text-right text-text">{fmtDuration(productivity.chatSecs)}</td>
                      </tr>
                    )}
                    <tr className="border-t border-border">
                      <td className="pt-2 pb-1 font-semibold text-text">Avg / Day</td>
                      <td className="pt-2 pb-1 text-right font-semibold text-accent">{fmtDuration(productivity.totalSecs)}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-muted">vs Expected ({fmtDuration(productivity.expectedSecs)})</td>
                      <td className={`py-1 text-right font-semibold ${productivity.productivityPct >= 75 ? 'text-success' : productivity.productivityPct >= 50 ? 'text-warn' : 'text-danger'}`}>
                        {productivity.productivityPct.toFixed(1)}%
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Productivity by Hour chart */}
      {(() => {
        const chartData = buildHourlyChartData(hourlyData?.hourly);
        if (!chartData && !hourlyLoading) return null;
        return (
          <Card className="mb-4">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-xs font-semibold text-text">Productivity by Hour</span>
              <span className="text-[10px] text-muted font-mono capitalize">{channelType} rep · avg per day · {periodLabel}</span>
            </div>
            <div className="p-4">
              {hourlyLoading ? (
                <div className="h-48 flex items-center justify-center text-muted text-xs font-mono animate-pulse">Loading…</div>
              ) : chartData ? (
                <div style={{ height: 220 }}>
                  <Bar data={chartData} options={HOURLY_CHART_OPTS} />
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center text-muted text-xs font-mono">No status data for this period</div>
              )}
            </div>
          </Card>
        );
      })()}

      {/* Productivity by Week chart */}
      {(() => {
        const chartData = buildWeeklyChartData(weeklyData?.weekly);
        if (!chartData && !weeklyLoading) return null;
        return (
          <Card className="mb-4">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-xs font-semibold text-text">Productivity by Week</span>
              <span className="text-[10px] text-muted font-mono capitalize">{channelType} rep · total hours · {periodLabel}</span>
            </div>
            <div className="p-4">
              {weeklyLoading ? (
                <div className="h-48 flex items-center justify-center text-muted text-xs font-mono animate-pulse">Loading…</div>
              ) : chartData ? (
                <div style={{ height: 220 }}>
                  <Bar data={chartData} options={WEEKLY_CHART_OPTS} />
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center text-muted text-xs font-mono">No status data for this period</div>
              )}
            </div>
          </Card>
        );
      })()}
      </>)}

      {subTab === 'quality' && (<>
      {/* Instascore rubric heatmap */}
      {instaData?.byRubric?.length > 0 && (() => {
        function heatColor(pct) {
          const p = Math.max(0, Math.min(100, pct));
          if (p <= 50) {
            const t = p / 50;
            return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
          }
          const t = (p - 50) / 50;
          return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
        }
        const sorted = [...instaData.byRubric].sort((a, b) =>
          rubricSortDir === 'asc' ? a.avg_pct - b.avg_pct : b.avg_pct - a.avg_pct
        );
        return (
          <Card className="mb-4">
            <button
              onClick={() => setRubricExpanded(e => !e)}
              className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-text">Instascore — Rubric Breakdown</span>
                <span
                  onClick={e => { e.stopPropagation(); setRubricSortDir(d => d === 'asc' ? 'desc' : 'asc'); }}
                  className="text-muted hover:text-text transition-colors text-sm cursor-pointer"
                  title={rubricSortDir === 'asc' ? 'Sorted: worst → best. Click to reverse' : 'Sorted: best → worst. Click to reverse'}
                >↕</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted font-mono">
                  {instaData.conversationCount} conversation{instaData.conversationCount !== 1 ? 's' : ''} · {periodLabel}
                </span>
                <span className="text-muted text-xs">{rubricExpanded ? '▲' : '▼'}</span>
              </div>
            </button>
            {rubricExpanded && (
              <div className="overflow-hidden rounded-b-lg">
                {sorted.map((row, i) => {
                  const color = heatColor(row.avg_pct);
                  return (
                    <div key={row.rubric_id} className="flex items-stretch" style={{ borderTop: i > 0 ? '1px solid rgba(0,0,0,0.12)' : undefined }}>
                      <div className="w-64 shrink-0 flex items-center justify-end pr-3 py-2.5 text-[11px] text-muted font-mono text-right leading-tight border-r border-border/40">
                        {row.rubric_title}
                      </div>
                      <div
                        className="flex-1 flex items-center justify-between px-4 py-2.5"
                        style={{ backgroundColor: color }}
                      >
                        <span className="text-xs font-bold font-mono text-black/70">{row.avg_pct}%</span>
                        <span className="text-[10px] font-mono text-black/50">{row.conversation_count} convos</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })()}

      {/* Instascore conversations table */}
      {instaData?.conversations?.length > 0 && (() => {
        function scoreColor(pct) {
          const p = Math.max(0, Math.min(100, pct));
          if (p <= 50) {
            const t = p / 50;
            return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
          }
          const t = (p - 50) / 50;
          return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
        }

        const sorted = [...instaData.conversations].sort((a, b) => {
          const av = a[convoSortCol];
          const bv = b[convoSortCol];
          const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
          return convoSortDir === 'asc' ? cmp : -cmp;
        });

        function toggleConvoSort(col) {
          if (convoSortCol === col) setConvoSortDir(d => d === 'asc' ? 'desc' : 'asc');
          else { setConvoSortCol(col); setConvoSortDir('desc'); }
        }

        function ConvoSortArrow({ col }) {
          if (convoSortCol !== col) return <span className="ml-1 text-border">↕</span>;
          return <span className="ml-1 text-accent">{convoSortDir === 'asc' ? '↑' : '↓'}</span>;
        }

        return (
          <Card className="mb-4">
            <button
              onClick={() => setConvoExpanded(e => !e)}
              className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-text">
                Instascore — Conversations ({instaData.conversations.length})
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted font-mono">{periodLabel}</span>
                <span className="text-muted text-xs">{convoExpanded ? '▲' : '▼'}</span>
              </div>
            </button>
            {convoExpanded && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {[
                        { label: 'Date',       col: 'conversation_date' },
                        { label: 'Instascore', col: 'instascore'        },
                        { label: 'Questions',  col: 'question_count'    },
                        { label: 'QA Ref',     col: 'qa_metrics_id'     },
                      ].map(({ label, col }) => (
                        <th
                          key={col}
                          onClick={() => toggleConvoSort(col)}
                          className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap cursor-pointer hover:text-text select-none"
                        >
                          {label}<ConvoSortArrow col={col} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(row => (
                      <tr key={row.asr_log_id} className="hover:bg-surface2 transition-colors">
                        <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                          {row.conversation_date}
                        </td>
                        <td className="px-3 py-2 text-xs border-b border-border/50 whitespace-nowrap">
                          <span
                            className="inline-block px-2 py-0.5 rounded font-mono font-bold text-xs text-black/70"
                            style={{ backgroundColor: scoreColor(row.instascore) }}
                          >
                            {row.instascore}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted">
                          {row.question_count}
                        </td>
                        <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted/60 whitespace-nowrap text-[10px]">
                          {row.qa_metrics_id ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })()}

      {/* Instascore heatmap */}
      {instaData?.byCategory?.length > 0 && (() => {
        function heatColor(pct) {
          // red(224,92,92) → yellow(245,166,35) → green(56,217,169)
          const p = Math.max(0, Math.min(100, pct));
          if (p <= 50) {
            const t = p / 50;
            return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
          }
          const t = (p - 50) / 50;
          return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
        }
        const sorted = [...instaData.byCategory].sort((a, b) =>
          heatSortDir === 'asc' ? a.avg_pct - b.avg_pct : b.avg_pct - a.avg_pct
        );
        return (
          <Card className="mb-4">
            <button
              onClick={() => setHeatExpanded(e => !e)}
              className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-text">Instascore — Category Breakdown</span>
                <span
                  onClick={e => { e.stopPropagation(); setHeatSortDir(d => d === 'asc' ? 'desc' : 'asc'); }}
                  className="text-muted hover:text-text transition-colors text-sm cursor-pointer"
                  title={heatSortDir === 'asc' ? 'Sorted: worst → best. Click to reverse' : 'Sorted: best → worst. Click to reverse'}
                >↕</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted font-mono">
                  {instaData.conversationCount} conversation{instaData.conversationCount !== 1 ? 's' : ''} · {periodLabel}
                </span>
                <span className="text-muted text-xs">{heatExpanded ? '▲' : '▼'}</span>
              </div>
            </button>
            {heatExpanded && <div className="overflow-hidden rounded-b-lg">
              {sorted.map((row, i) => {
                const color = heatColor(row.avg_pct);
                return (
                  <div key={row.category_id} className="flex items-stretch" style={{ borderTop: i > 0 ? '1px solid rgba(0,0,0,0.12)' : undefined }}>
                    {/* Category label */}
                    <div className="w-52 shrink-0 flex items-center justify-end pr-3 py-2.5 text-[11px] text-muted font-mono text-right leading-tight border-r border-border/40">
                      {row.category}
                    </div>
                    {/* Heatmap cell */}
                    <div
                      className="flex-1 flex items-center justify-between px-4 py-2.5"
                      style={{ backgroundColor: color }}
                    >
                      <span className="text-xs font-bold font-mono text-black/70">{row.avg_pct}%</span>
                      <span className="text-[10px] font-mono text-black/50">{row.conversation_count} convos</span>
                    </div>
                  </div>
                );
              })}
            </div>}
          </Card>
        );
      })()}

      {/* Instascore section heatmap */}
      {instaData?.bySection?.length > 0 && (() => {
        function heatColor(pct) {
          const p = Math.max(0, Math.min(100, pct));
          if (p <= 50) {
            const t = p / 50;
            return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
          }
          const t = (p - 50) / 50;
          return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
        }
        const uniqueSections = Array.from(
          new Map(instaData.bySection.map(r => [r.section_id, r])).values()
        );
        const sorted = [...uniqueSections].sort((a, b) =>
          sectionSortDir === 'asc' ? a.avg_pct - b.avg_pct : b.avg_pct - a.avg_pct
        );
        return (
          <Card className="mb-4">
            <button
              onClick={() => setSectionExpanded(e => !e)}
              className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-text">Instascore — Section Breakdown</span>
                <span
                  onClick={e => { e.stopPropagation(); setSectionSortDir(d => d === 'asc' ? 'desc' : 'asc'); }}
                  className="text-muted hover:text-text transition-colors text-sm cursor-pointer"
                  title={sectionSortDir === 'asc' ? 'Sorted: worst → best. Click to reverse' : 'Sorted: best → worst. Click to reverse'}
                >↕</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted font-mono">
                  {instaData.conversationCount} conversation{instaData.conversationCount !== 1 ? 's' : ''} · {periodLabel}
                </span>
                <span className="text-muted text-xs">{sectionExpanded ? '▲' : '▼'}</span>
              </div>
            </button>
            {sectionExpanded && <div className="overflow-hidden rounded-b-lg">
              {sorted.map((row, i) => {
                const color = heatColor(row.avg_pct);
                return (
                  <div key={row.section_id} className="flex items-stretch" style={{ borderTop: i > 0 ? '1px solid rgba(0,0,0,0.12)' : undefined }}>
                    <div className="w-52 shrink-0 flex items-center justify-end pr-3 py-2.5 text-[11px] text-muted font-mono text-right leading-tight border-r border-border/40">
                      {row.section}
                    </div>
                    <div
                      className="flex-1 flex items-center justify-between px-4 py-2.5"
                      style={{ backgroundColor: color }}
                    >
                      <span className="text-xs font-bold font-mono text-black/70">{row.avg_pct}%</span>
                      <span className="text-[10px] font-mono text-black/50">{row.conversation_count} convos</span>
                    </div>
                  </div>
                );
              })}
            </div>}
          </Card>
        );
      })()}

      {/* Instascore question heatmap */}
      {instaData?.byQuestion?.length > 0 && (() => {
        function heatColor(pct) {
          const p = Math.max(0, Math.min(100, pct));
          if (p <= 50) {
            const t = p / 50;
            return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
          }
          const t = (p - 50) / 50;
          return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
        }

        const isSorted = questionSortDir !== null;
        const sorted = [...instaData.byQuestion].sort((a, b) =>
          questionSortDir === 'asc' ? a.avg_pct - b.avg_pct : b.avg_pct - a.avg_pct
        );

        // Group by rubric when not globally sorted — only show rubric headers if >1 rubric
        const rubrics = [...new Set(instaData.byQuestion.map(r => r.rubric_title))];
        const showRubricHeaders = rubrics.length > 1 && questionSortDir === 'asc';

        let rows;
        if (showRubricHeaders) {
          // Group by rubric in natural order
          rows = rubrics.flatMap(rt => {
            const qs = instaData.byQuestion
              .filter(r => r.rubric_title === rt)
              .sort((a, b) => a.avg_pct - b.avg_pct);
            return [{ _header: true, rubric_title: rt }, ...qs];
          });
        } else {
          rows = sorted;
        }

        return (
          <Card className="mb-4">
            <button
              onClick={() => setQuestionExpanded(e => !e)}
              className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-text">Instascore — Question Breakdown</span>
                <span
                  onClick={e => { e.stopPropagation(); setQuestionSortDir(d => d === 'asc' ? 'desc' : 'asc'); }}
                  className="text-muted hover:text-text transition-colors text-sm cursor-pointer"
                  title={questionSortDir === 'asc' ? 'Sorted: worst → best. Click to reverse' : 'Sorted: best → worst. Click to reverse'}
                >↕</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted font-mono">
                  {instaData.conversationCount} conversation{instaData.conversationCount !== 1 ? 's' : ''} · {periodLabel}
                </span>
                <span className="text-muted text-xs">{questionExpanded ? '▲' : '▼'}</span>
              </div>
            </button>
            {questionExpanded && (
              <div className="overflow-hidden rounded-b-lg">
                {rows.map((row, i) => {
                  if (row._header) {
                    return (
                      <div key={`h-${row.rubric_title}`} className="px-4 py-1.5 bg-surface2 border-b border-border/40">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{row.rubric_title}</span>
                      </div>
                    );
                  }
                  const color = heatColor(row.avg_pct);
                  return (
                    <div key={row.question_id} className="flex items-stretch" style={{ borderTop: i > 0 ? '1px solid rgba(0,0,0,0.12)' : undefined }}>
                      <div className="w-80 shrink-0 flex items-center justify-end pr-3 py-2.5 text-[11px] text-muted font-mono text-right leading-tight border-r border-border/40">
                        {row.question}
                      </div>
                      <div
                        className="flex-1 flex items-center justify-between px-4 py-2.5"
                        style={{ backgroundColor: color }}
                      >
                        <span className="text-xs font-bold font-mono text-black/70">{row.avg_pct}%</span>
                        <span className="text-[10px] font-mono text-black/50">{row.conversation_count} convos</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })()}
      </>)}

      {subTab === 'activity' && (<>
      {/* MRR Upgrades table */}
      <Card className="mb-4">
        <button
          onClick={() => setMrrExpanded(e => !e)}
          className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold text-text">MRR Upgrades</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted font-mono">{periodLabel} · {detailLoading ? '…' : mrrUpgrades.length} upgrade{mrrUpgrades.length !== 1 ? 's' : ''} · ${mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} total</span>
            <span className="text-muted text-xs">{mrrExpanded ? '▲' : '▼'}</span>
          </div>
        </button>
        {mrrExpanded && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['Date', 'Company', 'Location', 'Most Recent Upgrade', 'From → To', 'MRR $', ''].map(h => (
                    <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailLoading ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading upgrades…</td></tr>
                ) : mrrUpgrades.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-muted text-xs font-mono">No upgrades in this period</td></tr>
                ) : mrrUpgrades.map((u, i) => (
                  <tr key={i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {u.markedMonth ? String(u.markedMonth).slice(0, 10) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap">{u.companyId ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">{u.locationName ?? u.locationId ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {u.mostRecentUpgrade ? String(u.mostRecentUpgrade).slice(0, 10) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      <span className="text-muted">{u.startTier ?? '—'}</span>
                      <span className="mx-1.5 text-border">→</span>
                      <span className="text-accent font-medium">{u.endTier ?? '—'}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-success whitespace-nowrap">
                      {u.netPriceChange ? `+$${Number(u.netPriceChange).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      {u.upgradeId ? (
                        <a
                          href={`https://app.joinhomebase.com/admin/upsells/${u.upgradeId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline font-mono text-[11px]"
                        >
                          View
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Talkdesk Calls table */}
      <Card className="mb-4">
        <button
          onClick={() => setTdCallsExpanded(e => !e)}
          className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold text-text">Talkdesk Calls</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted font-mono">{periodLabel} · {detailLoading ? '…' : tdCalls.length} call{tdCalls.length !== 1 ? 's' : ''}</span>
            <span className="text-muted text-xs">{tdCallsExpanded ? '▲' : '▼'}</span>
          </div>
        </button>
        {tdCallsExpanded && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['Date', 'Type', 'Talk Time', 'Hold Time', 'CSAT', 'Recording'].map(h => (
                    <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailLoading ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading calls…</td></tr>
                ) : tdCalls.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted text-xs font-mono">No calls in this period</td></tr>
                ) : tdCalls.map((c, i) => {
                  const csatColor = c.csatScore == null ? 'text-muted'
                    : c.csatScore >= 4 ? 'text-success'
                    : c.csatScore >= 3 ? 'text-warn'
                    : 'text-danger';
                  return (
                    <tr key={i} className="hover:bg-surface2 transition-colors">
                      <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                        {c.startTime ? String(c.startTime).slice(0, 16).replace('T', ' ') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap capitalize">
                        {c.callType ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap">{fmtSecs(c.talkSecs)}</td>
                      <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap">{fmtSecs(c.holdSecs)}</td>
                      <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${csatColor}`}>
                        {c.csatScore != null ? c.csatScore.toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                        {c.recordingLink && c.recordingLink !== 'None'
                          ? <a href={c.recordingLink} target="_blank" rel="noreferrer" className="text-accent hover:underline font-mono text-[10px]">▶ Play</a>
                          : <span className="text-muted font-mono text-[10px]">—</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* SF Chats card */}
      <Card className="mb-4">
        <button
          onClick={() => setSfChatsExpanded(e => !e)}
          className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold text-text">SF Chats</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted font-mono">{periodLabel} · {detailLoading ? '…' : sfChats.length} chat{sfChats.length !== 1 ? 's' : ''}</span>
            <span className="text-muted text-xs">{sfChatsExpanded ? '▲' : '▼'}</span>
          </div>
        </button>
        {sfChatsExpanded && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['Start Time', 'Duration', 'Wait', 'Customer Email', 'Ticket ID', 'Issue Type', 'Company Age', 'Paying', ''].map(h => (
                    <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailLoading ? (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading chats…</td></tr>
                ) : sfChats.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-muted text-xs font-mono">No chats in this period</td></tr>
                ) : sfChats.map((c, i) => (
                  <tr key={c.sessionId ?? i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {c.startTime ? String(c.startTime).slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap">
                      {fmtSecs(c.durationSecs)}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {fmtSecs(c.waitSecs)}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {c.customerEmail ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {c.ticketId ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      {c.issueType ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {c.companyAgeBucket ?? '—'}
                    </td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${c.paying === 1 ? 'text-success' : 'text-muted'}`}>
                      {c.paying === 1 ? 'Yes' : c.paying === 0 ? 'No' : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      {c.sessionId && (
                        <a
                          href={`https://joinhomebase.lightning.force.com/lightning/r/MessagingSession/${c.sessionId}/view`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline font-mono text-[10px]"
                        >View ↗</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Emails */}
      <Card className="mb-4">
        <button
          onClick={() => setEmailsExpanded(e => !e)}
          className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-surface2 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold text-text">Emails</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted font-mono">{periodLabel} · {detailLoading ? '…' : emails.length} email{emails.length !== 1 ? 's' : ''}</span>
            <span className="text-muted text-xs">{emailsExpanded ? '▲' : '▼'}</span>
          </div>
        </button>
        {emailsExpanded && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['Sent', 'Subject', 'Case #', 'Case Subject'].map(h => (
                    <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailLoading ? (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading emails…</td></tr>
                ) : emails.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-muted text-xs font-mono">No emails in this period</td></tr>
                ) : emails.map((e, i) => (
                  <tr key={e.id ?? i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {e.completedAt ? String(e.completedAt).slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap" title={e.subject ?? ''}>
                      {e.subject ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      {e.caseId ? (
                        <a
                          href={`${SF_BASE}${e.caseId}/view`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] text-accent hover:underline"
                        >
                          {e.caseNumber ?? 'View ↗'}
                        </a>
                      ) : (
                        <span className="text-muted font-mono text-[11px]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 text-muted max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap" title={e.caseSubject ?? ''}>
                      {e.caseSubject ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      </>)}

      {subTab === 'cases' && (<>
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
      </>)}
    </div>
  );
}
