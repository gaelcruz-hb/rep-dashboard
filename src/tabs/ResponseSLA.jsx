import { useMemo, useState } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useSlaData } from '../data/useSlaData';
import { parseSlaData } from '../data/parseSlaData';
import { useCasesData } from '../data/useCasesData';
import { AvsgCard } from '../components/ui/AvsgCard';
import { Card, CardHeader, CardBody, SectionHeader } from '../components/ui/Card';

function LoadingCard({ h = 200 }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />
  );
}

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend);

const SF_BASE = 'https://joinhomebase.lightning.force.com/lightning/r/Case/';

const TICK = { color: '#7b6d99', font: { family: 'DM Mono', size: 10 } };
const GRID = { color: 'rgba(46,37,69,0.8)' };
const TOOLTIP = {
  backgroundColor: '#1c1729',
  titleColor: '#ede9f8',
  bodyColor: '#7b6d99',
  borderColor: '#2e2545',
  borderWidth: 1,
};

function hBarOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: TOOLTIP },
    scales: {
      x: { ticks: TICK, grid: GRID },
      y: { ticks: TICK, grid: { color: 'transparent' } },
    },
  };
}

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

export function ResponseSLA() {
  const { goals, filteredRepNames, periodFilter, customRangeMode, customStartDate, customEndDate, managerFilter, teamFilter, repFilter, repList, availableReps } = useDashboard();
  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };

  // All Cases state
  const [caseStatusFilter, setCaseStatusFilter] = useState('all');
  const [caseSearch, setCaseSearch] = useState('');
  const [casesPage, setCasesPage] = useState(1);
  const PAGE_SIZE = 100;

  // Resolve owner IDs for the All Cases query (same pattern as Overview/VolumeInflow)
  const allCasesOwnerIds = useMemo(() => {
    if (repFilter !== 'all') {
      const rep = repList.find(r => r.name === repFilter);
      return rep ? [rep.id] : [];
    }
    if (managerFilter === 'all' && teamFilter === 'all') return [];
    const targetNames = new Set(availableReps.map(r => r.name));
    return repList.filter(r => targetNames.has(r.name)).map(r => r.id);
  }, [repFilter, managerFilter, teamFilter, availableReps, repList]);

  const allCasesManagerParam = managerFilter !== 'all' ? managerFilter : undefined;
  const allCasesOwnerIdParam = repFilter !== 'all'
    ? repList.find(r => r.name === repFilter)?.id
    : undefined;

  const { data: casesRaw, loading: casesLoading } = useCasesData({
    ...dateProps,
    manager: allCasesManagerParam,
    ownerId: allCasesOwnerIdParam,
    ownerIds: allCasesOwnerIds.length ? allCasesOwnerIds : undefined,
  });
  const { data: rawData, loading, error } = useSlaData({
    ...dateProps,
    ownerIds: allCasesOwnerIds.length ? allCasesOwnerIds : undefined,
    ownerId:  allCasesOwnerIdParam,
  });
  const allParsed = parseSlaData(rawData, goals.slaBreach) ?? [];
  const filteredReps = filteredRepNames
    ? allParsed.filter(r => filteredRepNames.has(r.name))
    : allParsed;
  const n = filteredReps.length || 1;

  // Must be before any early returns (Rules of Hooks)
  // Group response-time SLA breaches (Case_Response_Time_Hours__c > goals.responseHrs)
  // by Mon–Sun for this week and last week
  const breachesByDay = useMemo(() => {
    const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const thisWeek = [0, 0, 0, 0, 0, 0, 0];
    const lastWeek = [0, 0, 0, 0, 0, 0, 0];

    const now = new Date();
    // Start of this week (Monday 00:00 local)
    const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
    const startThis = new Date(now);
    startThis.setHours(0, 0, 0, 0);
    startThis.setDate(startThis.getDate() - dayOfWeek);
    const startLast = new Date(startThis);
    startLast.setDate(startLast.getDate() - 7);

    for (const c of (rawData?.records ?? [])
        .filter(c => !filteredRepNames || filteredRepNames.has(c.Owner?.Name))) {
      if (c.Case_Response_Time_Hours__c == null) continue;
      if (c.Case_Response_Time_Hours__c <= goals.slaBreach) continue;
      const created = new Date(c.CreatedDate);
      const dow = (created.getDay() + 6) % 7; // Mon=0
      if (created >= startThis)      thisWeek[dow]++;
      else if (created >= startLast) lastWeek[dow]++;
    }
    return { labels: DOW_LABELS, thisWeek, lastWeek };
  }, [rawData, goals.slaBreach, filteredRepNames]);

  if (!loading && (error || filteredReps.length === 0)) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono">
        {error ? `Error loading data: ${error}` : 'No case data available'}
      </div>
    );
  }

  if (loading || filteredReps.length === 0) {
    return (
      <div>
        <SectionHeader title="SLA & Response KPIs" />
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 5 }).map((_, i) => <LoadingCard key={i} h={90} />)}
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={200} /><LoadingCard h={200} />
        </div>
        <LoadingCard h={200} />
      </div>
    );
  }

  const avgResp     = filteredReps.reduce((s, r) => s + r.avgResponseHrs,    0) / n;
  const medResp     = filteredReps.reduce((s, r) => s + r.medianResponseHrs, 0) / n;
  const totalBreach = filteredReps.reduce((s, r) => s + r.slaBreachCount,    0);
  const totalRisk   = filteredReps.reduce((s, r) => s + r.slaRiskCount,      0);
  const avgSLAMeet  = filteredReps.reduce((s, r) => s + r.slaMeetPct,        0) / n;
  const totalOpen   = filteredReps.reduce((s, r) => s + r.openCases,         0);

  const breachGoal = Math.max(1, Math.round(totalOpen * 0.05)); // target: ≤5% of open cases breaching
  const slaMetGoal = 95; // target: ≥95% of cases meeting SLA threshold

  const breachByDayData = {
    labels: breachesByDay.labels,
    datasets: [
      {
        label: 'This Week',
        data: breachesByDay.thisWeek,
        borderColor: '#e05c5c',
        backgroundColor: 'rgba(224,92,92,0.1)',
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
  };

  const breachByDayOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#6b7280', font: { size: 10, family: 'DM Mono' } } },
      tooltip: TOOLTIP,
    },
    scales: {
      x: { ticks: TICK, grid: GRID },
      y: { ticks: TICK, grid: GRID },
    },
  };

  // Chart 1: avg response sorted ascending
  const sortedByResp = [...filteredReps].sort((a, b) => a.avgResponseHrs - b.avgResponseHrs);
  const responseData = {
    labels: sortedByResp.map(r => r.name.split(' ')[0]),
    datasets: [{
      label: 'Avg Hrs',
      data: sortedByResp.map(r => parseFloat(r.avgResponseHrs.toFixed(1))),
      backgroundColor: sortedByResp.map(r =>
        r.avgResponseHrs <= goals.responseHrs ? 'rgba(56,217,169,0.7)' : 'rgba(224,92,92,0.7)'
      ),
      borderRadius: 3,
    }],
  };

  // Chart 2: SLA % sorted descending
  const sortedBySLA = [...filteredReps].sort((a, b) => b.slaMeetPct - a.slaMeetPct);
  const slaData = {
    labels: sortedBySLA.map(r => r.name.split(' ')[0]),
    datasets: [{
      label: '% SLA Met',
      data: sortedBySLA.map(r => parseFloat(r.slaMeetPct.toFixed(1))),
      backgroundColor: sortedBySLA.map(r =>
        r.slaMeetPct >= slaMetGoal ? 'rgba(56,217,169,0.7)' : 'rgba(224,92,92,0.7)'
      ),
      borderRadius: 3,
    }],
  };

  // Risk cases: breached or at-risk (flags already computed via last-activity logic), max 3/rep, top 20
  const riskRows = filteredReps
    .flatMap(r =>
      r.cases
        .filter(c => c.isBreached || c.isAtRisk)
        .slice(0, 3)
        .map(c => ({ ...c, repName: r.name }))
    )
    .sort((a, b) => b.slaPct - a.slaPct)
    .slice(0, 20);

  const chartH = Math.max(160, sortedByResp.length * 22);

  return (
    <div>
      {/* ── KPI Cards ── */}
      <SectionHeader title="SLA & Response KPIs" />
      <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <AvsgCard label="Avg First Response"    val={parseFloat(avgResp.toFixed(1))}    goal={goals.responseHrs} unit="h" higher="bad" />
        <AvsgCard label="Median First Response" val={parseFloat(medResp.toFixed(1))}    goal={goals.responseHrs} unit="h" higher="bad" />
        <AvsgCard label="SLA Breaches"          val={totalBreach}                        goal={breachGoal}                  higher="bad" />
        <AvsgCard label="Cases at Risk"         val={totalRisk}                          goal={5}                           higher="bad" />
        <AvsgCard label="% Meeting SLA"         val={parseFloat(avgSLAMeet.toFixed(1))} goal={slaMetGoal}        unit="%" higher="good" />
      </div>

      {/* ── Charts ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="Avg First Response by Rep" subtitle="Sorted ascending — green ≤ goal" />
          <CardBody>
            <div style={{ height: chartH }}>
              <Bar data={responseData} options={hBarOpts()} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="% Cases Meeting SLA by Rep" subtitle="Sorted descending — green ≥ goal" />
          <CardBody>
            <div style={{ height: chartH }}>
              <Bar data={slaData} options={hBarOpts()} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── SLA Breaches by Day ── */}
      <Card className="mb-4">
        <CardHeader
          title="SLA Breaches by Day"
          subtitle={`This week vs last week — breach threshold: ${goals.slaBreach}h`}
        />
        <CardBody>
          <div style={{ height: 180 }}>
            <Line data={breachByDayData} options={breachByDayOpts} />
          </div>
        </CardBody>
      </Card>

      {/* ── Risk Table ── */}
      <Card>
        <CardHeader title="Cases Breaching or Approaching SLA" subtitle="Click case # to open in Salesforce" />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Case #', 'Rep', 'Subject', 'Status', 'Created', 'Age', 'Last Activity', 'Response', 'Risk'].map(h => (
                  <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {riskRows.map((c, i) => {
                const sfUrl = `${SF_BASE}${c.sfId}/view`;
                const riskEl = c.waitingOnClient
                  ? <span className="text-accent text-[11px]">⏳ Awaiting Client</span>
                  : c.isBreached
                    ? <span className="text-danger font-semibold text-[11px]">⚠ Breaching</span>
                    : c.isAtRisk
                      ? <span className="text-warn text-[11px]">↑ Approaching</span>
                      : <span className="text-muted text-[11px]">Aged ({c.ageDays}d)</span>;
                return (
                  <tr key={i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      <a href={sfUrl} target="_blank" rel="noreferrer"
                        className="font-mono text-[11px] text-accent hover:underline cursor-pointer">
                        {c.caseNum}
                      </a>
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap text-muted">{c.repName}</td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap" title={c.subject}>{c.subject}</td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap text-muted">{c.created}</td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap text-muted">{c.ageDays}d</td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${c.lastActivityDays > 7 ? 'text-danger' : c.lastActivityDays > 3 ? 'text-warn' : 'text-muted'}`}>
                      {c.lastActivityDays != null ? `${c.lastActivityDays}d ago` : '—'}
                    </td>
                    <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${c.respHrs != null && c.respHrs > goals.responseHrs ? 'text-danger' : 'text-muted'}`}>
                      {c.respHrs != null ? `${c.respHrs.toFixed(1)}h` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">{riskEl}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── All Cases ── */}
      {(() => {
        const now = Date.now();
        const allCases = (casesRaw?.records ?? []).map(c => {
          const ageDays          = Math.round((now - new Date(c.CreatedDate).getTime()) / 86400000);
          const lastActivityDays = c.LastModifiedDate
            ? Math.round((now - new Date(c.LastModifiedDate).getTime()) / 86400000)
            : null;
          const lastActivityHrs  = c.LastModifiedDate
            ? (now - new Date(c.LastModifiedDate).getTime()) / 3600000
            : ageDays * 24;
          const respHrs   = c.Case_Response_Time_Hours__c != null
            ? parseFloat(c.Case_Response_Time_Hours__c.toFixed(1))
            : null;
          const isClosed        = c.IsClosed === true || c.Status === 'Closed';
          const waitingOnClient = !isClosed && (c.Status === 'Pending' || c.Status === 'On Hold');
          const isBreached = !isClosed && !waitingOnClient && (respHrs != null
            ? respHrs > goals.slaBreach
            : lastActivityHrs > goals.slaBreach);
          const isAtRisk   = !isClosed && !waitingOnClient && !isBreached && (respHrs != null
            ? respHrs > goals.slaBreach * 0.75
            : lastActivityHrs > goals.slaBreach * 0.75);
          const created    = new Date(c.CreatedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return { sfId: c.Id, caseNum: c.CaseNumber, subject: c.Subject ?? '—', status: c.Status,
                   rep: c.Owner?.Name ?? '—', ageDays, lastActivityDays, respHrs, isBreached, isAtRisk, isClosed, waitingOnClient, created };
        });

        // Client-side filters
        const searchLower = caseSearch.toLowerCase();
        const filtered = allCases.filter(c => {
          if (caseStatusFilter !== 'all' && c.status !== caseStatusFilter) return false;
          if (searchLower && !c.caseNum.toLowerCase().includes(searchLower) && !c.subject.toLowerCase().includes(searchLower)) return false;
          return true;
        });

        const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
        const page = Math.min(casesPage, Math.max(1, totalPages));
        const visible = filtered.slice(0, page * PAGE_SIZE);

        return (
          <Card className="mt-4">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs font-semibold text-text">
                All Cases {casesLoading ? '…' : `(${filtered.length})`}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Search case # or subject…"
                  value={caseSearch}
                  onChange={e => { setCaseSearch(e.target.value); setCasesPage(1); }}
                  className="bg-surface2 border border-border text-text px-2.5 py-1 rounded-md text-[11px] outline-none focus:border-accent transition-colors w-48"
                />
                <select
                  value={caseStatusFilter}
                  onChange={e => { setCaseStatusFilter(e.target.value); setCasesPage(1); }}
                  className="bg-surface2 border border-border text-text px-2 py-1 rounded-md text-[11px] outline-none focus:border-accent transition-colors cursor-pointer"
                >
                  <option value="all">All Statuses</option>
                  <option value="New">New</option>
                  <option value="Open">Open</option>
                  <option value="Pending">Pending</option>
                  <option value="On Hold">On Hold</option>
                  <option value="Closed">Closed</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {['Case #', 'Rep', 'Subject', 'Status', 'Created', 'Age', 'Last Activity', 'Response', 'SLA'].map(h => (
                      <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {casesLoading ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading cases…</td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-muted text-xs font-mono">No cases match this filter</td>
                    </tr>
                  ) : visible.map((c, i) => {
                    const sfUrl    = `${SF_BASE}${c.sfId}/view`;
                    const ageColor = c.ageDays > 90 ? 'text-danger' : c.ageDays > 30 ? 'text-warn' : 'text-muted';
                    const slaEl    = c.isClosed
                      ? <span className="text-muted text-[11px]">—</span>
                      : c.waitingOnClient
                        ? <span className="text-accent text-[11px]">⏳ Awaiting Client</span>
                        : c.isBreached
                          ? <span className="text-danger font-semibold text-[11px]">⚠ Breaching</span>
                          : c.isAtRisk
                            ? <span className="text-warn text-[11px]">↑ Approaching</span>
                            : c.respHrs != null
                              ? <span className="text-success text-[11px]">Met</span>
                              : <span className="text-muted text-[11px]">—</span>;
                    return (
                      <tr key={i} className="hover:bg-surface2 transition-colors">
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                          <a href={sfUrl} target="_blank" rel="noreferrer"
                            className="font-mono text-[11px] text-accent hover:underline cursor-pointer">
                            {c.caseNum}
                          </a>
                        </td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap text-muted">{c.rep}</td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap" title={c.subject}>{c.subject}</td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap text-muted">{c.created}</td>
                        <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${ageColor}`}>{c.ageDays}d</td>
                        <td className={`px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap ${c.lastActivityDays > 7 ? 'text-danger' : c.lastActivityDays > 3 ? 'text-warn' : 'text-muted'}`}>
                          {c.lastActivityDays != null ? `${c.lastActivityDays}d ago` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 font-mono whitespace-nowrap text-muted">
                          {c.respHrs != null ? `${c.respHrs}h` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs border-b border-border/50 whitespace-nowrap">{slaEl}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!casesLoading && visible.length < filtered.length && (
                <div className="px-4 py-3 text-center">
                  <button
                    onClick={() => setCasesPage(p => p + 1)}
                    className="text-[11px] font-mono text-accent hover:underline cursor-pointer"
                  >
                    Load more ({filtered.length - visible.length} remaining)
                  </button>
                </div>
              )}
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
