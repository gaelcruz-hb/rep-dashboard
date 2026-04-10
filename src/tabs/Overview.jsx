import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { useMemo, useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useOverviewData } from '../data/useOverviewData';
import { parseOverviewData } from '../data/parseOverviewData';
import { useSlaData } from '../data/useSlaData';
// import { useTalkdeskMetrics } from '../data/useTalkdeskMetrics';
import { Card, CardHeader, CardBody, SectionHeader } from '../components/ui/Card';
import { AvsgCard } from '../components/ui/AvsgCard';
import { RepTable } from '../components/ui/RepTable';

ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler,
);

// ── Chart base options ────────────────────────────────────────────────────────
const TICK = { color: '#7b6d99', font: { family: 'DM Mono', size: 10 } };
const GRID = { color: 'rgba(46,37,69,0.8)' };
const TOOLTIP = {
  backgroundColor: '#1c1729',
  titleColor: '#ede9f8',
  bodyColor: '#7b6d99',
  borderColor: '#2e2545',
  borderWidth: 1,
};

function baseOpts(legendDisplay = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: legendDisplay
        ? { labels: { color: '#7b6d99', font: { family: 'DM Mono', size: 10 } } }
        : { display: false },
      tooltip: TOOLTIP,
    },
    scales: {
      x: { ticks: TICK, grid: GRID },
      y: { ticks: TICK, grid: GRID },
    },
  };
}

// ── Status pill ───────────────────────────────────────────────────────────────
function StatusPill({ dot, count, label, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-colors cursor-pointer
        ${active
          ? 'bg-accent/20 border-accent'
          : 'bg-surface2 border-border hover:border-accent/50'}`}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dot }} />
      <span className="font-bold font-mono text-sm text-text">{count.toLocaleString()}</span>
      <span className="text-muted">{label}</span>
    </button>
  );
}

function LoadingCard({ h = 200 }) {
  return <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />;
}

// ── Simple stat card ──────────────────────────────────────────────────────────
function StatCard({ label, value }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none">{value.toLocaleString()}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function Overview() {
  const { goals, managerFilter, teamFilter, repFilter, periodFilter, repList, filteredRepNames, availableReps, customRangeMode, customStartDate, customEndDate } = useDashboard();

  // Delegate to availableReps (already handles all filter combos correctly)
  const effectiveOwnerIds = useMemo(() => {
    if (repFilter !== 'all') return [];                           // single-rep: handled by ownerIdParam
    if (managerFilter === 'all' && teamFilter === 'all') return []; // org-wide: no owner clause needed
    const targetNames = new Set(availableReps.map(r => r.name));
    return repList.filter(r => targetNames.has(r.name)).map(r => r.id);
  }, [repFilter, managerFilter, teamFilter, availableReps, repList]);

  // Resolve rep name → SF OwnerId via repList
  const ownerIdParam = useMemo(() => {
    if (repFilter === 'all') return undefined;
    return repList.find(r => r.name === repFilter)?.id ?? repFilter;
  }, [repFilter, repList]);
  const managerParam = managerFilter !== 'all' ? managerFilter : undefined;

  const isFiltered = managerFilter !== 'all' || teamFilter !== 'all' || repFilter !== 'all';

  const [activeStatus, setActiveStatus]        = useState(null);
  const [caseNumberSearch, setCaseNumberSearch] = useState('');
  const [activeAgent, setActiveAgent]           = useState('');

  // Reset case filters when data scope changes
  useMemo(() => {
    setActiveStatus(null);
    setCaseNumberSearch('');
    setActiveAgent('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodFilter, repFilter, managerFilter, teamFilter, customStartDate, customEndDate]);

  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };
  const { data: rawData, loading, error } = useOverviewData({
    manager:  managerParam,
    ownerId:  ownerIdParam,
    ownerIds: effectiveOwnerIds.length ? effectiveOwnerIds : undefined,
    ...dateProps,
  });
  const { data: slaRaw } = useSlaData({
    ...dateProps,
    ownerIds: effectiveOwnerIds.length ? effectiveOwnerIds : undefined,
    ownerId:  ownerIdParam,
  });
  // const { data: tdMetrics } = useTalkdeskMetrics();
  const parsed = parseOverviewData(rawData);

  const breachesByDay = useMemo(() => {
    const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const thisWeek = [0, 0, 0, 0, 0, 0, 0];
    const lastWeek = [0, 0, 0, 0, 0, 0, 0];
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;
    const startThis = new Date(now);
    startThis.setHours(0, 0, 0, 0);
    startThis.setDate(startThis.getDate() - dayOfWeek);
    const startLast = new Date(startThis);
    startLast.setDate(startLast.getDate() - 7);
    for (const c of (slaRaw?.records ?? [])
        .filter(c => !filteredRepNames || filteredRepNames.has(c.Owner?.Name))) {
      if (c.Case_Response_Time_Hours__c == null) continue;
      if (c.Case_Response_Time_Hours__c <= goals.slaBreach) continue;
      const created = new Date(c.CreatedDate);
      const dow = (created.getDay() + 6) % 7;
      if (created >= startThis)      thisWeek[dow]++;
      else if (created >= startLast) lastWeek[dow]++;
    }
    return { labels: DOW_LABELS, thisWeek, lastWeek };
  }, [slaRaw, goals.slaBreach, filteredRepNames]);

  const caseRows = useMemo(() => {
    const records = slaRaw?.records ?? [];
    if (!filteredRepNames) return records;
    return records.filter(c => filteredRepNames.has(c.Owner?.Name));
  }, [slaRaw, filteredRepNames]);

  const agentOptions = useMemo(() => {
    const names = new Set(caseRows.map(c => c.Owner?.Name).filter(Boolean));
    return [...names].sort();
  }, [caseRows]);

  const filteredCaseRows = useMemo(() => {
    let rows = caseRows;
    if (activeStatus === 'Closed') {
      rows = rows.filter(c => c.IsClosed === true);
    } else if (activeStatus) {
      rows = rows.filter(c => c.Status === activeStatus);
    }
    if (caseNumberSearch.trim()) {
      const q = caseNumberSearch.trim().toLowerCase();
      rows = rows.filter(c => c.CaseNumber?.toLowerCase().includes(q));
    }
    if (activeAgent) {
      rows = rows.filter(c => c.Owner?.Name === activeAgent);
    }
    return rows;
  }, [caseRows, activeStatus, caseNumberSearch, activeAgent]);

  if (!loading && (error || !parsed)) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono">
        {error ? `Error loading data: ${error}` : 'No overview data available'}
      </div>
    );
  }

  if (loading || !parsed) {
    return (
      <div>
        <SectionHeader title="Activity vs Goals — Today" />
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 6 }).map((_, i) => <LoadingCard key={i} h={90} />)}
        </div>
        <SectionHeader title="Case Status Snapshot" />
        <div className="flex gap-2 flex-wrap mb-5">
          {Array.from({ length: 5 }).map((_, i) => <LoadingCard key={i} h={40} />)}
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={200} /><LoadingCard h={200} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <LoadingCard h={200} /><LoadingCard h={200} />
        </div>
      </div>
    );
  }

  const {
    avgResponseHrs, emailsToday,
    totalClosedPeriod,
    dailyLabels, dailyClosedCounts, avg7,
    wowLabels, thisWeek, lastWeek,
    hourlyLabels, hourlyCounts,
    statusLabels, statusCounts,
  } = parsed;

  // Derive pill counts from caseRows so they always match the table totals
  const totalNew     = caseRows.filter(c => c.Status === 'New').length;
  const totalOpen    = caseRows.filter(c => c.Status === 'Open').length;
  const totalPending = caseRows.filter(c => c.Status === 'Pending' || c.Status === 'Waiting').length;
  const totalHold    = caseRows.filter(c => c.Status === 'On Hold').length;
  const totalClosed  = caseRows.filter(c => c.IsClosed === true).length;

  // ── Chart datasets ───────────────────────────────────────────────────────────
  const closedDailyData = {
    labels: dailyLabels,
    datasets: [
      {
        type: 'bar',
        label: 'Closed',
        data: dailyClosedCounts,
        backgroundColor: 'rgba(126,61,212,0.5)',
        borderColor:     'rgba(126,61,212,1)',
        borderWidth: 1,
        borderRadius: 3,
      },
      ...(dailyClosedCounts.length >= 7 ? [{
        type: 'line',
        label: '7d avg',
        data: avg7,
        borderColor: '#f5a623',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      }] : []),
    ],
  };

  const statusColors = [
    'rgba(56,217,169,0.7)',
    'rgba(126,61,212,0.7)',
    'rgba(245,166,35,0.7)',
    'rgba(224,92,92,0.7)',
    'rgba(91,138,245,0.7)',
    'rgba(235,87,87,0.5)',
  ];
  const statusChartData = {
    labels: statusLabels,
    datasets: [{
      label: 'Cases',
      data: statusCounts,
      backgroundColor: statusLabels.map((_, i) => statusColors[i % statusColors.length]),
      borderRadius: 4,
    }],
  };

  const hourlyData = {
    labels: hourlyLabels,
    datasets: [{
      label: 'Cases',
      data: hourlyCounts,
      backgroundColor: 'rgba(56,217,169,0.5)',
      borderRadius: 3,
    }],
  };

  const PERIOD_LABELS = {
    today:      { period: 'Today',      closed: 'Closed Today',      emails: 'Emails Today' },
    yesterday:  { period: 'Yesterday',  closed: 'Closed Yesterday',  emails: 'Emails Yesterday' },
    week:       { period: 'This Week',  closed: 'Closed This Week',  emails: 'Emails This Week' },
    last_week:  { period: 'Last Week',  closed: 'Closed Last Week',  emails: 'Emails Last Week' },
    month:      { period: 'This Month', closed: 'Closed This Month', emails: 'Emails This Month' },
    last_month: { period: 'Last Month', closed: 'Closed Last Month', emails: 'Emails Last Month' },
  };
  const { period: periodLabel, closed: closedLabel, emails: emailsLabel } =
    customRangeMode && customStartDate && customEndDate
      ? { period: `${customStartDate} – ${customEndDate}`, closed: `Closed ${customStartDate} – ${customEndDate}`, emails: `Emails ${customStartDate} – ${customEndDate}` }
      : (PERIOD_LABELS[periodFilter] ?? PERIOD_LABELS.week);

  const WOW_META = {
    today:      { title: 'Day Comparison — Closed',    subtitle: 'Today vs yesterday',        current: 'Today',      prior: 'Yesterday'  },
    yesterday:  { title: 'Day Comparison — Closed',    subtitle: 'Yesterday vs prior day',    current: 'Yesterday',  prior: 'Prior Day'  },
    week:       { title: 'Week over Week — Closed',    subtitle: 'This week vs last week',    current: 'This Week',  prior: 'Last Week'  },
    last_week:  { title: 'Week over Week — Closed',    subtitle: 'Last week vs prior week',   current: 'Last Week',  prior: 'Prior Week' },
    month:      { title: 'Period Comparison — Closed', subtitle: 'Recent 7 days vs prior 7',  current: 'Recent 7d',  prior: 'Prior 7d'   },
    last_month: { title: 'Period Comparison — Closed', subtitle: 'Recent 7 days vs prior 7',  current: 'Recent 7d',  prior: 'Prior 7d'   },
  };
  const wowMeta = customRangeMode
    ? { title: 'Period Comparison — Closed', subtitle: 'Recent 7 days vs prior 7', current: 'Recent 7d', prior: 'Prior 7d' }
    : (WOW_META[periodFilter] ?? WOW_META.week);

  const wowData = {
    labels: wowLabels.length ? wowLabels : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [
      { label: wowMeta.current, data: thisWeek, backgroundColor: 'rgba(126,61,212,0.7)', borderRadius: 4 },
      { label: wowMeta.prior,   data: lastWeek, backgroundColor: 'rgba(56,217,169,0.3)',  borderRadius: 4 },
    ],
  };

  return (
    <div>
      {/* ── Activity vs Goals ── */}
      <SectionHeader title={`Activity vs Goals — ${periodLabel}`} />
      <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <AvsgCard label="Total Closed"  val={totalClosedPeriod}  goal={goals.closedDay}    higher="good" />
        <AvsgCard label="Avg Response"  val={avgResponseHrs}     goal={goals.responseHrs}  unit="h" higher="bad" />
        <AvsgCard label="Total Emails"  val={emailsToday}        goal={goals.emailsDay}    higher="good" />

        {/* Avg On Hold card removed — Talkdesk data only (tdMetrics?.avgHoldSec) */}
        {/* <AvsgCard label="Avg Availability" val={tdMetrics?.avgAvailPct ?? null} goal={goals.availPct} unit="%" higher="good" /> */}
      </div>

      {/* ── Case Status Snapshot ── */}
      <SectionHeader title="Case Status Snapshot" />
      <div className="flex gap-2 flex-wrap mb-3">
        <button
          onClick={() => setActiveStatus(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-colors cursor-pointer
            ${activeStatus === null
              ? 'bg-accent/20 border-accent'
              : 'bg-surface2 border-border hover:border-accent/50'}`}
        >
          <span className="font-bold font-mono text-sm text-text">{caseRows.length.toLocaleString()}</span>
          <span className="text-muted">All Cases</span>
        </button>
        <StatusPill dot="#38d9a9" count={totalNew}     label="New"          onClick={() => setActiveStatus(activeStatus === 'New'     ? null : 'New')}     active={activeStatus === 'New'} />
        <StatusPill dot="#7e3dd4" count={totalOpen}    label="Open"         onClick={() => setActiveStatus(activeStatus === 'Open'    ? null : 'Open')}    active={activeStatus === 'Open'} />
        <StatusPill dot="#f5a623" count={totalPending} label="Pending"      onClick={() => setActiveStatus(activeStatus === 'Pending' ? null : 'Pending')} active={activeStatus === 'Pending'} />
        <StatusPill dot="#e05c5c" count={totalHold}    label="On Hold"      onClick={() => setActiveStatus(activeStatus === 'On Hold' ? null : 'On Hold')} active={activeStatus === 'On Hold'} />
        <StatusPill dot="#38d9a9" count={totalClosed}  label="Closed"       onClick={() => setActiveStatus(activeStatus === 'Closed'  ? null : 'Closed')}  active={activeStatus === 'Closed'} />
      </div>

      {/* ── Case list filters ── */}
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Search case #…"
          value={caseNumberSearch}
          onChange={e => setCaseNumberSearch(e.target.value)}
          className="bg-surface2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text placeholder-muted focus:outline-none focus:border-accent w-40"
        />
        <select
          value={activeAgent}
          onChange={e => setActiveAgent(e.target.value)}
          className="bg-surface2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text focus:outline-none focus:border-accent"
        >
          <option value="">All Agents</option>
          {agentOptions.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {/* ── Case list table ── */}
      <div className="overflow-auto rounded-[10px] border border-border mb-5" style={{ maxHeight: 360 }}>
        <RepTable
          columns={[
            {
              key: 'CaseNumber', label: 'Case #',
              render: (v, row) => (
                <a
                  href={`https://joinhomebase.lightning.force.com/lightning/r/Case/${row.Id}/view`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline font-mono"
                >
                  {v}
                </a>
              ),
            },
            { key: 'Owner',       label: 'Case Owner',  render: v => v?.Name ?? '—' },
            { key: 'Subject',     label: 'Subject' },
            { key: 'Description', label: 'Description', render: v => v ? (v.length > 50 ? v.slice(0, 50) + '…' : v) : '—' },
            { key: 'Status',      label: 'Status' },
            {
              key: 'CreatedDate', label: 'Created',
              render: v => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
              align: 'right',
            },
          ]}
          rows={filteredCaseRows}
        />
      </div>

      {/* ── Row 1 charts ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title={`Cases Closed — ${periodLabel}`} subtitle={dailyClosedCounts.length >= 7 ? 'Daily + 7-day avg' : 'Daily'} />
          <CardBody>
            <div style={{ height: 180 }}>
              <Bar data={closedDailyData} options={baseOpts(true)} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={wowMeta.title} subtitle={wowMeta.subtitle} />
          <CardBody>
            <div style={{ height: 180 }}>
              <Bar data={wowData} options={baseOpts(true)} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Row 2 charts ── */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="SLA Breaches by Day" subtitle={`This week vs last week — breach threshold: ${goals.slaBreach}h`} />
          <CardBody>
            <div style={{ height: 180 }}>
              <Line
                data={{
                  labels: breachesByDay.labels,
                  datasets: [
                    {
                      label: 'This Week',
                      data: breachesByDay.thisWeek,
                      borderColor: '#e05c5c',
                      tension: 0.4,
                      fill: false,
                      pointRadius: 3,
                      pointBackgroundColor: '#e05c5c',
                    },
                    {
                      label: 'Last Week',
                      data: breachesByDay.lastWeek,
                      borderColor: '#6b7280',
                      borderDash: [4, 4],
                      tension: 0.4,
                      fill: false,
                      pointRadius: 0,
                    },
                  ],
                }}
                options={baseOpts(true)}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="New Cases by Hour — Today" subtitle="Staffing pattern view" />
          <CardBody>
            <div style={{ height: 180 }}>
              <Bar data={hourlyData} options={baseOpts(false)} />
            </div>
          </CardBody>
        </Card>
      </div>

    </div>
  );
}
