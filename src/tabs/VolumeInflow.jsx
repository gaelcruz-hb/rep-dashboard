import { useMemo } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement,
  ArcElement, LineElement, PointElement,
  Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useVolumeData } from '../data/useVolumeData';
import { parseVolumeData } from '../data/parseVolumeData';
import { Card, CardHeader, CardBody } from '../components/ui/Card';

ChartJS.register(
  CategoryScale, LinearScale, BarElement,
  ArcElement, LineElement, PointElement,
  Title, Tooltip, Legend, Filler,
);

// ── Chart base styles ──────────────────────────────────────────────────────────
const TICK    = { color: '#7b6d99', font: { family: 'DM Mono', size: 10 } };
const GRID    = { color: 'rgba(46,37,69,0.8)' };
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

function hBarOpts() {
  return {
    ...baseOpts(false),
    indexAxis: 'y',
    scales: {
      x: { ticks: TICK, grid: GRID },
      y: { ticks: TICK, grid: { color: 'transparent' } },
    },
  };
}

const DOUGHNUT_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'right',
      labels: { color: '#7b6d99', font: { family: 'DM Mono', size: 10 }, boxWidth: 12 },
    },
    tooltip: TOOLTIP,
  },
};

// ── Simple stat card (no goal) ─────────────────────────────────────────────────
function StatCard({ label, value }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none">{value.toLocaleString()}</div>
    </div>
  );
}

function LoadingCard({ h = 200 }) {
  return <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />;
}

const CHANNEL_COLORS = [
  'rgba(126,61,212,0.8)',
  'rgba(56,217,169,0.8)',
  'rgba(245,166,35,0.8)',
  'rgba(224,92,92,0.8)',
  'rgba(91,138,245,0.8)',
  'rgba(235,87,87,0.8)',
];

export function VolumeInflow() {
  const { managerFilter, teamFilter, repFilter, availableReps, repList, periodFilter, customRangeMode, customStartDate, customEndDate } = useDashboard();

  // Map available rep names → Salesforce user IDs for the API query
  const ownerIds = useMemo(() => {
    if (managerFilter === 'all' && teamFilter === 'all' && repFilter === 'all') return [];
    if (repFilter !== 'all') {
      const rep = repList.find(r => r.name === repFilter);
      return rep ? [rep.id] : [];
    }
    return availableReps
      .map(r => repList.find(rl => rl.name === r.name)?.id)
      .filter(Boolean);
  }, [managerFilter, teamFilter, repFilter, availableReps, repList]);

  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };
  const { data: rawData, loading, error } = useVolumeData({
    manager: managerFilter !== 'all' ? managerFilter : undefined,
    ownerIds,
    ...dateProps,
  });
  const parsed = parseVolumeData(rawData);

  if (!loading && (error || !parsed)) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono">
        {error ? `Error loading data: ${error}` : 'No volume data available'}
      </div>
    );
  }

  if (loading || !parsed) {
    return (
      <div>
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 4 }).map((_, i) => <LoadingCard key={i} h={90} />)}
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={240} /><LoadingCard h={240} />
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={220} /><LoadingCard h={220} />
        </div>
        <LoadingCard h={200} />
      </div>
    );
  }

  const {
    newCasesToday, newCasesWeek, emailsToday, totalOpen,
    channelLabels, channelCounts,
    hourlyLabels, hourlyCounts,
    dailyLabels, dailyCounts,
    typeLabels, typeCounts,
    wowLabels, emailThisWeek, emailLastWeek,
  } = parsed;

  // ── Chart datasets ───────────────────────────────────────────────────────────
  const channelData = {
    labels: channelLabels,
    datasets: [{
      data: channelCounts,
      backgroundColor: channelLabels.map((_, i) => CHANNEL_COLORS[i % CHANNEL_COLORS.length]),
      borderWidth: 0,
      hoverOffset: 6,
    }],
  };

  const hourlyData = {
    labels: hourlyLabels,
    datasets: [{
      label: 'Cases Created',
      data: hourlyCounts,
      backgroundColor: 'rgba(56,217,169,0.5)',
      borderRadius: 3,
    }],
  };

  const newCasesData = {
    labels: dailyLabels,
    datasets: [{
      label: 'New',
      data: dailyCounts,
      borderColor: '#7e3dd4',
      backgroundColor: 'rgba(126,61,212,0.1)',
      fill: true,
      tension: 0.4,
      pointRadius: 2,
      borderWidth: 1.5,
    }],
  };

  const issueData = {
    labels: typeLabels,
    datasets: [{
      label: 'Cases',
      data: typeCounts,
      backgroundColor: 'rgba(126,61,212,0.6)',
      borderRadius: 3,
    }],
  };

  const emailWoWData = {
    labels: wowLabels.length ? wowLabels : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
    datasets: [
      {
        label: 'This Week',
        data: emailThisWeek,
        borderColor: '#7e3dd4',
        backgroundColor: 'rgba(126,61,212,0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        borderWidth: 1.5,
      },
      {
        label: 'Last Week',
        data: emailLastWeek,
        borderColor: '#7b6d99',
        borderDash: [4, 4],
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 1.5,
      },
    ],
  };

  return (
    <div>
      {/* ── Stat Cards ── */}
      <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <StatCard label="New Cases Today"       value={newCasesToday} />
        <StatCard label="New Cases This Week"   value={newCasesWeek} />
        <StatCard label="Email Cases Today"     value={emailsToday} />
        <StatCard label="Total Open Cases"      value={totalOpen} />
      </div>

      {/* ── Row 1 ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="Cases by Channel" subtitle="Distribution today by origin" />
          <CardBody>
            <div style={{ height: 220 }}>
              {channelCounts.length > 0
                ? <Doughnut data={channelData} options={DOUGHNUT_OPTS} />
                : <div className="flex items-center justify-center h-full text-muted text-xs font-mono">No channel data today</div>
              }
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Cases Created by Hour — Today" subtitle="Staffing pattern" />
          <CardBody>
            <div style={{ height: 220 }}>
              <Bar data={hourlyData} options={baseOpts(false)} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Row 2 ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="New Cases — Daily Trend" subtitle="Last 14 days" />
          <CardBody>
            <div style={{ height: 200 }}>
              <Line data={newCasesData} options={baseOpts(false)} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Cases by Issue Type" subtitle="Last 7 days" />
          <CardBody>
            <div style={{ height: 200 }}>
              {typeLabels.length > 0
                ? <Bar data={issueData} options={hBarOpts()} />
                : <div className="flex items-center justify-center h-full text-muted text-xs font-mono">No type data available</div>
              }
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Email WoW ── */}
      <Card>
        <CardHeader title="Email Cases — WoW" subtitle="This week vs last week" />
        <CardBody>
          <div style={{ height: 180 }}>
            <Line data={emailWoWData} options={baseOpts(true)} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
