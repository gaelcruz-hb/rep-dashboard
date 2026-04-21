import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Bar } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useManagerData } from '../data/useManagerData';
import { parseManagerData } from '../data/parseManagerData';
import { ORG, getActiveMembers } from '../data/orgData';
import { Card, CardHeader, CardBody, SectionHeader } from '../components/ui/Card';

// const API_URL = import.meta.env.VITE_API_URL || ''; // removed with Talkdesk

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend);

const STACKED_PLUGINS = [ChartDataLabels];

const CHART_OPT = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: true, labels: { color: '#7b6d99', font: { size: 10 } } },
    tooltip: { backgroundColor: '#1c1729', titleColor: '#ede9f8', bodyColor: '#7b6d99', borderColor: '#2e2545', borderWidth: 1 },
  },
  scales: {
    x: { grid: { color: '#2e2545' }, ticks: { color: '#7b6d99', font: { size: 10 } } },
    y: { grid: { color: '#2e2545' }, ticks: { color: '#7b6d99', font: { size: 10 } } },
  },
};

const good = 'text-success font-semibold font-mono';
const bad  = 'text-danger font-semibold font-mono';

// const normalize = n => (n ?? '').toLowerCase().trim().replace(/\s+/g, ' '); // removed with Talkdesk

function MetricRow({ label, value, isGood }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-border last:border-b-0">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={`text-xs ${isGood ? good : bad}`}>{value}</span>
    </div>
  );
}



function LoadingCard({ h = 200 }) {
  return <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />;
}

function buildManagers(sfRepByName) {
  return ORG.map(({ manager, teams }) => {
    const repNames = teams.flatMap(t => getActiveMembers(t));
    const reps = repNames.map(name => {
      const sf = sfRepByName?.[name] ?? {};
      // Talkdesk fields removed — application uses Salesforce data only
      // const td = tdByAgent[normalize(name)] ?? {};
      return {
        name,
        closedWeek:     sf.closedWeek     ?? 0,
        avgResponseHrs: sf.avgResponseHrs ?? 0,
        holdCases:      sf.holdCases      ?? 0,
        openCases:      sf.openCases      ?? 0,
        // avgHoldSec: td.avgHoldSec ?? null,
        // availPct:   td.availPct   ?? null,
      };
    });
    return aggregateManager(manager, reps);
  });
}

function aggregateManager(name, reps) {
  const n = reps.length;
  const repsWithResp = reps.filter(r => r.avgResponseHrs > 0);
  return {
    name,
    reps,
    headcount:           n,
    avgResponse:         n ? parseFloat((reps.reduce((s, r) => s + r.avgResponseHrs, 0) / n).toFixed(2)) : 0,
    avgResponseFiltered: repsWithResp.length
      ? parseFloat((repsWithResp.reduce((s, r) => s + r.avgResponseHrs, 0) / repsWithResp.length).toFixed(2))
      : null,
    totalClosed: reps.reduce((s, r) => s + r.closedWeek, 0),
    totalOnHold: reps.reduce((s, r) => s + r.holdCases,  0),
    totalOpen:   reps.reduce((s, r) => s + r.openCases,  0),
  };
}

export function ManagerScorecard() {
  const { mgrWeek, setMgrWeek, goals, managerFilter, filteredRepNames, periodFilter, customRangeMode, customStartDate, customEndDate, setActiveTab, setSelectedRep } = useDashboard();
  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };

  // ── Salesforce data ────────────────────────────────────────────────────────────
  const { data: sfRaw, loading: sfLoading } = useManagerData(dateProps);
  const sfParsed   = parseManagerData(sfRaw);
  const sfRepByName = sfParsed
    ? Object.fromEntries(sfParsed.reps.map(r => [r.name, r]))
    : null;

  // Talkdesk data fetch removed — application uses Salesforce data only
  // const [tdRaw, setTdRaw] = useState(null);
  // useEffect(() => { fetch(`${API_URL}/api/talkdesk-metrics`) ... }, []);
  // const tdByAgent = tdRaw?.byAgent ?? {};

  // ── Date labels ────────────────────────────────────────────────────────────────
  const today        = new Date();
  const weekStr      = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const priorWeekStr = new Date(today - 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const displayWeek  = mgrWeek === 'current' ? weekStr : priorWeekStr;

  const CLOSED_LABEL = {
    today:      'Cases Closed Today',
    yesterday:  'Cases Closed Yesterday',
    week:       'Cases Closed This Week',
    last_week:  'Cases Closed Last Week',
    month:      'Cases Closed This Month',
    last_month: 'Cases Closed Last Month',
  };
  const closedLabel = customRangeMode && customStartDate && customEndDate
    ? `Cases Closed ${customStartDate} – ${customEndDate}`
    : (CLOSED_LABEL[periodFilter] ?? 'Cases Closed This Week');

  // ── Loading skeleton ───────────────────────────────────────────────────────────
  if (sfLoading || !sfParsed) {
    return (
      <div>
        <div className="grid grid-cols-2 gap-4 mb-5">
          <LoadingCard h={280} /><LoadingCard h={280} />
          <LoadingCard h={280} /><LoadingCard h={280} />
        </div>
        <SectionHeader title="Team Comparison" />
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={220} /><LoadingCard h={220} />
        </div>
      </div>
    );
  }

  // ── Build managers from ORG, populate with SF data ───────────────────────────
  let managers = buildManagers(sfRepByName);

  if (managerFilter !== 'all') {
    managers = managers.filter(m => m.name === managerFilter);
  }

  if (filteredRepNames) {
    managers = managers
      .map(m => {
        const reps = m.reps.filter(r => filteredRepNames.has(r.name));
        if (reps.length === 0) return null;
        return aggregateManager(m.name, reps);
      })
      .filter(Boolean);
  }

// ── Charts ─────────────────────────────────────────────────────────────────────
  const noLegendOpt = { ...CHART_OPT, plugins: { ...CHART_OPT.plugins, legend: { display: false } } };
  const mgrLabels   = managers.map(m => m.name);

  const STACK_COLORS = [
    'rgba(91,138,245,0.8)',  'rgba(56,217,169,0.8)',  'rgba(245,166,35,0.8)',
    'rgba(224,92,92,0.8)',   'rgba(126,61,212,0.8)',   'rgba(100,200,255,0.8)',
    'rgba(255,150,100,0.8)', 'rgba(200,100,255,0.8)',  'rgba(100,255,150,0.8)',
    'rgba(255,100,150,0.8)', 'rgba(50,200,200,0.8)',   'rgba(200,150,50,0.8)',
    'rgba(150,100,255,0.8)', 'rgba(255,200,100,0.8)',  'rgba(100,150,200,0.8)',
  ];

  const stackedClosedOpt = {
    ...CHART_OPT,
    plugins: {
      ...CHART_OPT.plugins,
      legend: {
        display: true,
        labels: {
          color: '#6b7280',
          font: { size: 9 },
          filter: item => item.text === 'Team Goal',
          boxWidth: 24,
        },
      },
      datalabels: {
        display: ctx => ctx.dataset.type !== 'line' && ctx.parsed.y > 0,
        color: '#fff',
        font: { size: 9, weight: 'bold' },
        formatter: v => v,
        anchor: 'center',
        align: 'center',
        clamp: true,
      },
    },
    scales: {
      x: { ...CHART_OPT.scales.x, stacked: true },
      y: { ...CHART_OPT.scales.y, stacked: true },
    },
  };

  const allReps = managers.flatMap(m => m.reps);
  const closedData = {
    labels: mgrLabels,
    datasets: [
      ...allReps.map((rep, i) => ({
        type: 'bar',
        label: rep.name,
        data: managers.map(m => m.reps.find(r => r.name === rep.name)?.closedWeek ?? 0),
        backgroundColor: STACK_COLORS[i % STACK_COLORS.length],
        stack: 'reps',
        borderWidth: 0,
      })),
      {
        type: 'line',
        label: 'Team Goal',
        data: managers.map(m => goals.closedDay * 5 * m.headcount),
        borderColor: 'rgba(255,255,255,0.5)',
        borderWidth: 2,
        borderDash: [5, 4],
        pointRadius: 3,
        pointBackgroundColor: 'rgba(255,255,255,0.5)',
        fill: false,
        tension: 0,
        order: -1,
      },
    ],
  };

  const openData = {
    labels: mgrLabels,
    datasets: [
      {
        label: 'Open',
        data: managers.map(m => m.totalOpen - m.totalOnHold),
        backgroundColor: 'rgba(91,138,245,0.6)',
        borderRadius: 4,
      },
      {
        label: 'On Hold',
        data: managers.map(m => m.totalOnHold),
        backgroundColor: 'rgba(245,166,35,0.6)',
        borderRadius: 4,
      },
    ],
  };

  const responseData = {
    labels: mgrLabels,
    datasets: [{
      label: 'Avg Response (hrs)',
      data: managers.map(m => parseFloat(m.avgResponse.toFixed(1))),
      backgroundColor: managers.map(m => m.avgResponse <= goals.responseHrs ? 'rgba(56,217,169,0.65)' : 'rgba(224,92,92,0.65)'),
      borderRadius: 4,
    }],
  };

  // holdChartData removed — Talkdesk data only
  // const holdChartData = { ... };

  // ── Coaching rows — built from real SF rep data; lastCoached has no data source
  const coachingRows = managers.flatMap(m =>
    m.reps.map(r => ({ name: r.name, manager: m.name, lastCoached: null }))
  );

  return (
    <div>
      {/* Week nav */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2.5">
        <div className="font-mono text-[11px] text-muted">
          Scorecard — Week of {displayWeek}
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => setMgrWeek('prior')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all ${mgrWeek === 'prior' ? 'bg-accent text-white' : 'bg-transparent border border-border text-text hover:border-accent hover:text-accent'}`}
          >
            ← Prior Week
          </button>
          <button
            onClick={() => setMgrWeek('current')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all ${mgrWeek === 'current' ? 'bg-accent text-white' : 'bg-transparent border border-border text-text hover:border-accent hover:text-accent'}`}
          >
            This Week
          </button>
        </div>
      </div>

      {/* ── Manager cards ── */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        {managers.map(m => (
            <Card key={m.name}>
              <div className="bg-surface2 px-4 py-3 border-b border-border">
                <div className="text-[15px] font-semibold text-text">{m.name}</div>
                <div className="text-[10px] text-muted font-mono mt-0.5">{m.headcount} reps</div>
              </div>

              <CardBody>
                <MetricRow label="Avg Response Time"    value={`${m.avgResponse.toFixed(1)}h`}           isGood={m.avgResponse <= goals.responseHrs} />
                {m.avgResponseFiltered != null && (
                  <MetricRow label="Avg Resp (w/ data)" value={`${m.avgResponseFiltered.toFixed(1)}h`}  isGood={m.avgResponseFiltered <= goals.responseHrs} />
                )}
                <MetricRow label={closedLabel}         value={m.totalClosed}                    isGood={m.totalClosed >= goals.closedDay * 5 * m.headcount} />
                <MetricRow label="Total Open Cases"   value={m.totalOpen}                      isGood={true} />
                <MetricRow label="Total On Hold"      value={m.totalOnHold}                    isGood={m.totalOnHold <= goals.maxOnHold * m.headcount} />
                {/* Talkdesk MetricRows removed — application uses Salesforce data only */}
                {/* {m.avgHoldSec  != null && <MetricRow label="Avg Hold Time"    value={`${m.avgHoldSec}s`}   isGood={m.avgHoldSec  <= goals.avgHoldSec} />} */}
                {/* {m.avgAvailPct != null && <MetricRow label="Avg Availability" value={`${m.avgAvailPct}%`}  isGood={m.avgAvailPct >= goals.availPct}   />} */}

              </CardBody>
            </Card>
        ))}
      </div>

      {/* ── Team comparison charts ── */}
      <SectionHeader title="Team Comparison" />
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title={`${closedLabel} — by Manager`} />
          <CardBody><div style={{ height: 280 }}><Bar data={closedData} options={stackedClosedOpt} plugins={STACKED_PLUGINS} /></div></CardBody>
        </Card>
        <Card>
          <CardHeader title="Open vs On Hold — by Manager" />
          <CardBody><div style={{ height: 200 }}><Bar data={openData} options={{ ...CHART_OPT, scales: { ...CHART_OPT.scales, x: { ...CHART_OPT.scales.x, stacked: true }, y: { ...CHART_OPT.scales.y, stacked: true } } }} /></div></CardBody>
        </Card>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="Avg Response Time — by Manager" subtitle="Hours — green ≤ goal" />
          <CardBody><div style={{ height: 200 }}><Bar data={responseData} options={noLegendOpt} /></div></CardBody>
        </Card>
        {/* Avg Hold Time chart removed — Talkdesk data only */}
      </div>

      {/* ── Rep Status per manager ── */}
      <SectionHeader title="Rep Status by Manager" />
      <div className="grid grid-cols-2 gap-4 mb-5">
        {managers.map(m => (
          <Card key={m.name}>
            <CardHeader title={`${m.name}'s Team`} subtitle={`${m.headcount} reps`} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {['Rep', closedLabel.replace('Cases ', ''), 'Response', 'On Hold', 'Open'].map(h => (
                      <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.reps.map(r => {
                    const closedOk = r.closedWeek >= goals.closedDay * 5;
                    const respOk   = r.avgResponseHrs <= goals.responseHrs;
                    return (
                      <tr key={r.name} className="hover:bg-surface2 transition-colors">
                        <td className="px-3 py-2 text-xs border-b border-border/50 whitespace-nowrap">
                          <button
                            onClick={() => { setSelectedRep(r.name); setActiveTab('rep-detail'); }}
                            className="text-accent hover:underline cursor-pointer font-medium"
                          >{r.name}</button>
                        </td>
                        <td className={`px-3 py-2 text-xs border-b border-border/50 font-mono font-semibold whitespace-nowrap ${closedOk ? 'text-success' : 'text-danger'}`}>{r.closedWeek}</td>
                        <td className={`px-3 py-2 text-xs border-b border-border/50 font-mono whitespace-nowrap ${respOk ? 'text-success' : 'text-danger'}`}>{r.avgResponseHrs.toFixed(1)}h</td>
                        <td className={`px-3 py-2 text-xs border-b border-border/50 font-mono whitespace-nowrap ${r.holdCases > goals.maxOnHold ? 'text-warn' : 'text-muted'}`}>{r.holdCases}</td>
                        <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">{r.openCases}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>

      {/* ── Coaching & Accountability Tracker ── */}
      <SectionHeader title="Coaching & Accountability Tracker">
        <span className="text-[11px] text-muted">Week of {displayWeek}</span>
      </SectionHeader>
      <Card className="mb-5">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Rep', 'Manager', 'Last Coached'].map(h => (
                  <th key={h} className="text-left text-[10px] font-mono uppercase tracking-[1px] text-muted px-3 py-2.5 border-b border-border whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {coachingRows.map(c => (
                <tr key={c.name} className="hover:bg-surface2 transition-colors">
                  <td className="px-3 py-2 text-xs border-b border-border/50 text-text whitespace-nowrap">{c.name}</td>
                  <td className="px-3 py-2 text-xs border-b border-border/50 text-muted whitespace-nowrap">{c.manager}</td>
                  <td className="px-3 py-2 text-xs border-b border-border/50 font-mono text-muted whitespace-nowrap">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
}
