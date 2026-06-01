import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { useMemo, useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useOverviewData } from '../data/useOverviewData';
import { useOverviewRepTable } from '../data/useOverviewRepTable';
import { parseOverviewData } from '../data/parseOverviewData';
import { useSlaData } from '../data/useSlaData';
// import { useTalkdeskMetrics } from '../data/useTalkdeskMetrics';
import { Card, CardHeader, CardBody, SectionHeader } from '../components/ui/Card';
import { AvsgCard } from '../components/ui/AvsgCard';
import { buildHourlyChartData, HOURLY_CHART_OPTS, fmtDuration } from '../data/productivityUtils';
import { getRepChannelType } from '../data/getRepChannelType';

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
  const { goals, managerFilter, teamFilter, repFilter, periodFilter, repList, filteredRepNames, availableReps, customRangeMode, customStartDate, customEndDate, setActiveTab, selectedRep, setSelectedRep } = useDashboard();

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
  const { data: repTableRaw, loading: repTableLoading } = useOverviewRepTable({
    manager:  managerParam,
    ownerId:  ownerIdParam,
    ownerIds: effectiveOwnerIds.length ? effectiveOwnerIds : undefined,
    ...dateProps,
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

  const avgProductiveSecs  = rawData?.avgProductiveSecs ?? null;
  const productivityHourly = rawData?.productivityHourly ?? [];
  const prodChartData      = buildHourlyChartData(productivityHourly);

  const mrrTotal        = rawData?.mrrTotal ?? 0;
  const mrrUpgradeCount = rawData?.mrrUpgradeCount ?? 0;
  const mrrByRep        = rawData?.mrrByRep ?? [];
  const totalCalls      = rawData?.totalCalls ?? 0;
  const totalChats      = rawData?.totalChats ?? 0;
  const _rawRepRows = repTableRaw?.reps ?? [];
  const repRows = filteredRepNames ? _rawRepRows.filter(r => filteredRepNames.has(r.repName)) : _rawRepRows;
  const mrrWithData     = mrrByRep.filter(r => r.mrrTotal > 0);
  const mrrChartData    = mrrWithData.length ? {
    labels: mrrWithData.map(r => r.repName),
    datasets: [{
      label: 'MRR Added',
      data:  mrrWithData.map(r => r.mrrTotal),
      backgroundColor: 'rgba(56,217,169,0.7)',
      borderColor:     'rgba(56,217,169,1)',
      borderWidth: 1,
      borderRadius: 4,
    }],
  } : null;
  const mrrChartOpts = {
    ...baseOpts(false),
    scales: {
      x: { ticks: TICK, grid: GRID },
      y: { ticks: { ...TICK, callback: v => `$${Number(v).toLocaleString()}` }, grid: GRID },
    },
    plugins: {
      ...baseOpts(false).plugins,
      tooltip: {
        ...TOOLTIP,
        callbacks: { label: ctx => `$${Number(ctx.raw).toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
      },
    },
  };


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
    month:      { period: 'This Month',   closed: 'Closed This Month',   emails: 'Emails This Month' },
    last_month: { period: 'Last Month',   closed: 'Closed Last Month',   emails: 'Emails Last Month' },
    last_30:    { period: 'Last 30 Days', closed: 'Closed Last 30 Days', emails: 'Emails Last 30 Days' },
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
    last_30:    { title: 'Period Comparison — Closed', subtitle: 'Recent 7 days vs prior 7',  current: 'Recent 7d',  prior: 'Prior 7d'   },
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
        <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
          <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">Avg Productive Time</div>
          <div className="text-2xl font-bold font-mono leading-none mb-1">
            {loading ? '…' : (avgProductiveSecs ? fmtDuration(avgProductiveSecs) : '—')}
          </div>
          <div className="text-[10px] text-muted mt-1">avg per rep / day</div>
        </div>
        <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
          <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">Total Calls</div>
          <div className="text-2xl font-bold font-mono leading-none mb-1">
            {loading ? '…' : totalCalls.toLocaleString()}
          </div>
          <div className="text-[10px] text-muted mt-1">{periodLabel}</div>
        </div>
        <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ backgroundColor: '#38d9a9' }} />
          <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">Total Chats</div>
          <div className="text-2xl font-bold font-mono leading-none mb-1" style={{ color: '#38d9a9' }}>
            {loading ? '…' : totalChats.toLocaleString()}
          </div>
          <div className="text-[10px] text-muted mt-1">{periodLabel}</div>
        </div>
        <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-success" />
          <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">MRR Added</div>
          <div className="text-2xl font-bold font-mono leading-none mb-1 text-success">
            {loading ? '…' : `$${mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          </div>
          <div className="text-[10px] text-muted mt-1">{loading ? '' : `${mrrUpgradeCount} upgrade${mrrUpgradeCount !== 1 ? 's' : ''}`}</div>
        </div>
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

      {/* ── Productivity by Hour ── */}
      {prodChartData && (
        <Card className="mt-4">
          <CardHeader title="Productivity by Hour" subtitle={`${periodLabel} · avg per rep / day`} />
          <CardBody>
            <div style={{ height: 220 }}>
              <Bar data={prodChartData} options={HOURLY_CHART_OPTS} />
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── MRR by Agent chart ── */}
      {mrrChartData && (
        <Card className="mt-4">
          <CardHeader title={`MRR by Agent — ${periodLabel}`} subtitle={`${mrrWithData.length} rep${mrrWithData.length !== 1 ? 's' : ''} with upgrades`} />
          <CardBody>
            <div style={{ height: 220 }}>
              <Bar data={mrrChartData} options={mrrChartOpts} />
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Rep Summary Table ── */}
      <Card className="mt-4">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="text-xs font-semibold text-text">Rep Summary — {periodLabel}</div>
          {repTableLoading && <span className="text-[10px] text-muted font-mono animate-pulse">Loading…</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {[
                  { label: 'Rep',          color: null },
                  { label: 'Instascore',   color: '#a855f7' },
                  { label: 'TD CSAT',      color: '#f5a623' },
                  { label: 'Inbound',      color: '#f5a623' },
                  { label: 'Chats',        color: '#38d9a9' },
                  { label: 'Outbound',     color: '#f5a623' },
                  { label: 'Missed',       color: '#e05c5c' },
                  { label: 'Total Calls',  color: '#f5a623' },
                  { label: 'Open Cases',   color: '#5b8af5' },
                  { label: 'Hot Cases',    color: '#e05c5c' },
                  { label: 'Productivity', color: '#f5a623' },
                  { label: 'MRR',          color: '#38d9a9' },
                ].map(({ label, color }) => (
                  <th key={label} className="text-left text-[10px] font-mono uppercase tracking-[1px] px-3 py-2.5 border-b border-border whitespace-nowrap"
                    style={{ color: color ?? '#6b7280' }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repTableLoading && repRows.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-muted text-xs font-mono animate-pulse">Loading rep data…</td></tr>
              ) : repRows.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-muted text-xs font-mono">No data for this period</td></tr>
              ) : repRows.map((r, i) => {
                const instaColor = r.instascore == null ? '#6b7280'
                  : r.instascore >= 85 ? '#38d9a9'
                  : r.instascore >= 75 ? '#f5a623'
                  : '#e05c5c';
                // Productive time per the rep's own channel type, matching the
                // Rep Details "Productive/day" calc (computeProductivity):
                // calls → available + on a call; chats → chat (fallback to
                // available when no chat time); else → all.
                const _ct = getRepChannelType(r.repName);
                const prodSecs = _ct === 'calls' ? (r.availSecs ?? 0) + (r.onCallSecs ?? 0)
                  : _ct === 'chats' ? ((r.chatSecs ?? 0) || (r.availSecs ?? 0))
                  : (r.availSecs ?? 0) + (r.onCallSecs ?? 0) + (r.chatSecs ?? 0);
                // Productivity % vs an 8h expected day — matches Rep Details "vs Expected".
                const prodPct = (prodSecs / (8 * 3600)) * 100;
                const prodColor = prodPct >= 75 ? '#38d9a9' : prodPct >= 50 ? '#f5a623' : '#e05c5c';
                return (
                  <tr key={i} className="hover:bg-surface2 transition-colors">
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-medium whitespace-nowrap">
                      <button
                        onClick={() => { setSelectedRep(r.repName); setActiveTab('rep'); }}
                        className="text-accent hover:underline cursor-pointer text-left"
                      >{r.repName}</button>
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono font-semibold whitespace-nowrap" style={{ color: instaColor }}>
                      {r.instascore != null ? `${r.instascore}%` : '—'}
                      {r.scoredConvos > 0 && <span className="text-[10px] text-muted ml-1">({r.scoredConvos})</span>}
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono whitespace-nowrap">
                      {r.avgCsat != null ? (
                        <span className="text-text">{r.avgCsat.toFixed(1)}<span className="text-muted text-[10px] ml-0.5">({r.csatCount})</span></span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted">{r.inboundCalls ?? '—'}</td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono" style={{ color: '#38d9a9' }}>{r.totalChats ?? '—'}</td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted">{r.outboundCalls ?? '—'}</td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono" style={{ color: r.missedCalls > 0 ? '#e05c5c' : '#6b7280' }}>
                      {r.missedCalls ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-text font-semibold">{r.totalCalls ?? '—'}</td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted">{r.openCases ?? '—'}</td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono whitespace-nowrap">
                      {r.hotCases > 0
                        ? <span style={{ color: '#e05c5c' }}>🔥 {r.hotCases}</span>
                        : <span className="text-muted">{r.hotCases ?? '—'}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">
                      {prodSecs > 0 ? (
                        <span>
                          {fmtDuration(prodSecs)}
                          <span className="ml-1" style={{ color: prodColor }}>({prodPct.toFixed(0)}%)</span>
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs border-b border-border/50 font-mono whitespace-nowrap" style={{ color: r.mrrTotal > 0 ? '#38d9a9' : '#6b7280' }}>
                      {r.mrrTotal > 0 ? `$${r.mrrTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
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
