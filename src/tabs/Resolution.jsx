import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import { useDashboard } from '../context/DashboardContext';
import { useResolutionData } from '../data/useResolutionData';
import { parseResolutionData } from '../data/parseResolutionData';
import { AvsgCard } from '../components/ui/AvsgCard';
import { Card, CardHeader, CardBody } from '../components/ui/Card';

function LoadingCard({ h = 200 }) {
  return <div className="bg-surface border border-border rounded-[10px] animate-pulse" style={{ height: h }} />;
}

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend);

const HBAR = {
  responsive: true, maintainAspectRatio: false, indexAxis: 'y',
  plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e2333', titleColor: '#e8eaf0', bodyColor: '#6b7280', borderColor: '#2a2f42', borderWidth: 1 } },
  scales: {
    x: { grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 } } },
    y: { grid: { color: 'transparent' }, ticks: { color: '#e8eaf0', font: { size: 10 } } },
  },
};

const lineOpts = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: true, labels: { color: '#6b7280', font: { size: 10 } } },
    tooltip: { backgroundColor: '#1e2333', titleColor: '#e8eaf0', bodyColor: '#6b7280', borderColor: '#2a2f42', borderWidth: 1 },
  },
  scales: {
    x: { grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 } } },
    y: { grid: { color: '#2a2f42' }, ticks: { color: '#6b7280', font: { size: 10 } } },
  },
};

export function Resolution() {
  const { goals, filteredRepNames, periodFilter, customRangeMode, customStartDate, customEndDate } = useDashboard();
  const dateProps = customRangeMode ? { startDate: customStartDate, endDate: customEndDate } : { period: periodFilter };
  const { data: rawData, loading, error } = useResolutionData(dateProps);
  const parsed = parseResolutionData(rawData, filteredRepNames);
  const allParsedReps = parsed?.reps ?? [];
  const filteredReps = filteredRepNames
    ? allParsedReps.filter(r => filteredRepNames.has(r.name))
    : allParsedReps;
  const n = filteredReps.length || 1;

  if (!loading && (error || !parsed)) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-xs font-mono">
        {error ? `Error loading data: ${error}` : 'No resolution data available'}
      </div>
    );
  }

  if (loading || !parsed) {
    return (
      <div>
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 6 }).map((_, i) => <LoadingCard key={i} h={90} />)}
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <LoadingCard h={240} /><LoadingCard h={240} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <LoadingCard h={180} /><LoadingCard h={180} />
        </div>
      </div>
    );
  }

  const avgTTR       = filteredReps.reduce((s, r) => s + r.avgTTRHrs,    0) / n;
  const medTTR       = filteredReps.reduce((s, r) => s + r.medianTTRHrs, 0) / n;
  const totalClosed  = filteredReps.reduce((s, r) => s + r.closedWeek,   0);
  const totalCreated = filteredReps.reduce((s, r) => s + r.newCasesWeek, 0);
  const avgReopen    = filteredReps.reduce((s, r) => s + r.reopenedPct,  0) / n;
  const totalEsc     = filteredReps.reduce((s, r) => s + r.escalated,    0);

  const closeRatePct  = totalCreated > 0 ? Math.round((totalClosed / totalCreated) * 100) : 0;
  const closeRateGood = totalClosed >= totalCreated;

  const ttrSorted    = [...filteredReps].sort((a, b) => a.avgTTRHrs - b.avgTTRHrs);
  const escSorted    = [...filteredReps].sort((a, b) => b.escalated - a.escalated).slice(0, 12);
  const reopenSorted = [...filteredReps].sort((a, b) => b.reopenedPct - a.reopenedPct).slice(0, 12);

  const ttrData = {
    labels: ttrSorted.map(r => r.name.split(' ')[0]),
    datasets: [{
      label: 'Avg TTR (hrs)',
      data: ttrSorted.map(r => r.avgTTRHrs),
      backgroundColor: ttrSorted.map(r => r.avgTTRHrs <= 48 ? 'rgba(56,217,169,0.7)' : 'rgba(224,92,92,0.7)'),
      borderRadius: 3,
    }],
  };

  const closeRateData = {
    labels: parsed.dailyLabels,
    datasets: [
      { label: 'Created', data: parsed.dailyCreated, borderColor: '#f5a623', tension: 0.4, fill: false, pointRadius: 2 },
      { label: 'Closed',  data: parsed.dailyClosed,  borderColor: '#38d9a9', tension: 0.4, fill: false, pointRadius: 2 },
    ],
  };

  const escalData = {
    labels: escSorted.map(r => r.name.split(' ')[0]),
    datasets: [{ label: 'Escalated', data: escSorted.map(r => r.escalated), backgroundColor: 'rgba(224,92,92,0.6)', borderRadius: 3 }],
  };

  const reopenData = {
    labels: reopenSorted.map(r => r.name.split(' ')[0]),
    datasets: [{
      label: 'Reopen %',
      data: reopenSorted.map(r => r.reopenedPct),
      backgroundColor: reopenSorted.map(r => r.reopenedPct > 5 ? 'rgba(224,92,92,0.6)' : 'rgba(56,217,169,0.6)'),
      borderRadius: 3,
    }],
  };

  return (
    <div>
      <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <AvsgCard label="Avg Time to Resolution" val={Math.round(avgTTR)}   goal={48}                     unit="h" higher="bad" />
        <AvsgCard label="Median Time to Resolution" val={Math.round(medTTR)} goal={24}                    unit="h" higher="bad" />
        <AvsgCard label="Closed This Week"         val={totalClosed}         goal={goals.closedDay * 5 * n}         higher="good" />

        {/* Close Rate — special card */}
        <div className="bg-surface border border-border rounded-[10px] px-4 py-3.5 relative overflow-hidden">
          <div className={`absolute top-0 left-0 right-0 h-[3px] ${closeRateGood ? 'bg-success' : 'bg-danger'}`} />
          <div className="text-[10px] text-muted font-mono uppercase tracking-[1px] mb-1.5">Close Rate</div>
          <div className="text-xl font-bold font-mono leading-none mb-1">{totalClosed}/{totalCreated}</div>
          <div className="text-[11px] text-muted mb-1.5">Closed vs Created</div>
          <div className="h-1 bg-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${closeRateGood ? 'bg-success' : 'bg-danger'}`}
              style={{ width: `${Math.min(100, closeRatePct)}%` }}
            />
          </div>
          <div className={`text-[10px] font-mono mt-1 ${closeRateGood ? 'text-success' : 'text-danger'}`}>{closeRatePct}%</div>
        </div>

        <AvsgCard label="Avg Reopen Rate"  val={parseFloat(avgReopen.toFixed(1))} goal={5}  unit="%" higher="bad" />
        <AvsgCard label="Total Escalated"  val={totalEsc}                          goal={10}               higher="bad" />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader title="Avg Time to Resolution by Rep" subtitle="Hours" />
          <CardBody><div style={{ height: 240 }}><Bar data={ttrData} options={HBAR} /></div></CardBody>
        </Card>
        <Card>
          <CardHeader title="Close Rate — Created vs Closed" subtitle="Last 14 days" />
          <CardBody><div style={{ height: 240 }}><Line data={closeRateData} options={lineOpts} /></div></CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Escalated Cases by Rep" />
          <CardBody><div style={{ height: 180 }}><Bar data={escalData} options={HBAR} /></div></CardBody>
        </Card>
        <Card>
          <CardHeader title="Reopened Cases %" subtitle="By rep" />
          <CardBody><div style={{ height: 180 }}><Bar data={reopenData} options={HBAR} /></div></CardBody>
        </Card>
      </div>
    </div>
  );
}
