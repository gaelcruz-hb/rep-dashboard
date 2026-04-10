import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement,
  ArcElement,
  Title, Tooltip, Legend,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useChannelsData } from '../data/useChannelsData';
import { parseChannelsData } from '../data/parseChannelsData';
import { Card, CardHeader, CardBody, SectionHeader } from '../components/ui/Card';

ChartJS.register(
  CategoryScale, LinearScale, BarElement,
  ArcElement,
  Title, Tooltip, Legend,
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

const HBAR_OPTS = {
  responsive: true, maintainAspectRatio: false, indexAxis: 'y',
  plugins: { legend: { display: false }, tooltip: TOOLTIP },
  scales: {
    x: { ticks: TICK, grid: GRID },
    y: { ticks: TICK, grid: { color: 'transparent' } },
  },
};

const VBAR_OPTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: TOOLTIP },
  scales: {
    x: { ticks: TICK, grid: { color: 'transparent' } },
    y: { ticks: TICK, grid: GRID },
  },
};

const DOUGHNUT_OPTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'right',
      labels: { color: '#7b6d99', font: { family: 'DM Mono', size: 10 }, boxWidth: 12 },
    },
    tooltip: TOOLTIP,
  },
};

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" />
      <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">{label}</div>
      <div className="text-2xl font-bold font-mono leading-none">{value}</div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────────
function LoadingCard({ h = 200 }) {
  return (
    <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function Channels() {
  const { filteredRepNames, periodFilter, customRangeMode, customStartDate, customEndDate } = useDashboard();
  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };
  const { data: rawData, loading, error } = useChannelsData(dateProps);
  const sf = parseChannelsData(rawData);

  // ── Error / empty state ──────────────────────────────────────────────────────
  if (!loading && (error || !sf)) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono">
        {error ? `Error loading data: ${error}` : 'No data available'}
      </div>
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (loading || !sf) {
    return (
      <div>
        <SectionHeader title="Chat & Messaging" />
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 4 }).map((_, i) => <LoadingCard key={i} h={90} />)}
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

  // ── Derived values ───────────────────────────────────────────────────────────
  const agentEndedTotal = sf.endedBy['Agent'] ?? 0;
  const userEndedTotal  = sf.endedBy['End User'] ?? 0;
  const endedTotal      = agentEndedTotal + userEndedTotal;
  const agentEndedPct   = endedTotal > 0 ? ((agentEndedTotal / endedTotal) * 100).toFixed(0) : '—';

  // Volume trend (oldest → newest)
  const volLabels = sf.volumeTrend.map(d => d.date.replace(/\/\d{4}$/, ''));
  const volCounts = sf.volumeTrend.map(d => d.value);

  // Chats by agent — sorted desc, top 15
  const agentVol = Object.entries(sf.chatsByAgent)
    .filter(([name]) => name && name !== '-' && name !== 'Automated Process')
    .filter(([name]) => !filteredRepNames || filteredRepNames.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // Accept time by agent — sorted asc (lower = better), exclude 0s
  const agentAccept = Object.entries(sf.acceptByAgent)
    .filter(([, v]) => v > 0)
    .filter(([name]) => !filteredRepNames || filteredRepNames.has(name))
    .sort((a, b) => a[1] - b[1]);

  // ── Chart datasets ───────────────────────────────────────────────────────────
  const volumeData = {
    labels: volLabels,
    datasets: [{
      data: volCounts,
      backgroundColor: 'rgba(126,61,212,0.6)',
      borderRadius: 4,
    }],
  };

  const endedByData = {
    labels: ['Agent', 'End User'],
    datasets: [{
      data: [agentEndedTotal, userEndedTotal],
      backgroundColor: ['rgba(126,61,212,0.8)', 'rgba(56,217,169,0.8)'],
      borderWidth: 0,
      hoverOffset: 6,
    }],
  };

  const agentVolData = {
    labels: agentVol.map(([n]) => n.split(' ')[0]),
    datasets: [{
      data: agentVol.map(([, v]) => v),
      backgroundColor: 'rgba(126,61,212,0.6)',
      borderRadius: 3,
    }],
  };

  const agentAcceptData = {
    labels: agentAccept.map(([n]) => n),
    datasets: [{
      data: agentAccept.map(([, v]) => parseFloat(v.toFixed(2))),
      backgroundColor: agentAccept.map(([, v]) => v > 10 ? 'rgba(224,92,92,0.7)' : v > 5 ? 'rgba(245,166,35,0.7)' : 'rgba(56,217,169,0.7)'),
      borderRadius: 3,
    }],
  };

  return (
    <div>
      <SectionHeader title="Chat & Messaging" />

      {/* ── KPI Cards ── */}
      <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <StatCard label="Total Chats"       value={sf.totalChats.toLocaleString()} />
        <StatCard label="Avg Accept Time"   value={sf.avgAccept > 0 ? `${sf.avgAccept.toFixed(1)}m` : '—'} />
        <StatCard label="Avg Chat Duration" value={`${sf.avgAHT.toFixed(1)}m`} />
        <StatCard label="Agent-Ended"       value={`${agentEndedPct}%`} sub={`${agentEndedTotal.toLocaleString()} of ${endedTotal.toLocaleString()}`} />
      </div>

      {/* ── Row 1: Volume + Ended By ── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="Chat Volume" subtitle="Chats created per day" />
          <CardBody>
            <div style={{ height: 200 }}>
              <Bar data={volumeData} options={VBAR_OPTS} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Sessions Ended By" subtitle="Agent vs End User" />
          <CardBody>
            <div style={{ height: 200 }}>
              <Doughnut data={endedByData} options={DOUGHNUT_OPTS} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Row 2: By Agent ── */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Chats Handled by Agent" subtitle="Sorted descending" />
          <CardBody>
            <div style={{ height: Math.max(200, agentVol.length * 24) }}>
              <Bar data={agentVolData} options={HBAR_OPTS} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Avg Accept Time by Agent" subtitle="Minutes — green ≤ 5m, orange ≤ 10m" />
          <CardBody>
            <div style={{ height: Math.max(200, agentAccept.length * 24) }}>
              <Bar data={agentAcceptData} options={HBAR_OPTS} />
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
