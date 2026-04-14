import { DashboardProvider, useDashboard } from './context/DashboardContext';
import { Header }          from './components/layout/Header';
import { GoalsBanner }     from './components/layout/GoalsBanner';
import { Controls }        from './components/layout/Controls';
import { Tabs }            from './components/layout/Tabs';
import { Overview }        from './tabs/Overview';
import { ResponseSLA }     from './tabs/ResponseSLA';
import { Resolution }      from './tabs/Resolution';
import { VolumeInflow }    from './tabs/VolumeInflow';
import { Channels }        from './tabs/Channels';
import { ManagerScorecard }from './tabs/ManagerScorecard';
import { RepDetail }       from './tabs/RepDetail';
import { useAuth }         from './auth/useAuth';
import { LoginScreen }     from './auth/LoginScreen';

const TAB_MAP = {
  overview:    Overview,
  response:    ResponseSLA,
  resolution:  Resolution,
  volume:      VolumeInflow,
  channels:    Channels,
  manager:     ManagerScorecard,
  rep:         RepDetail,
};

function Dashboard() {
  const { activeTab } = useDashboard();
  const TabComponent  = TAB_MAP[activeTab] ?? Overview;

  return (
    <div className="min-h-screen bg-bg text-text">
      <Header />
      <GoalsBanner />
      <Controls />
      <Tabs />
      <main className="px-6 py-5">
        <TabComponent />
      </main>
    </div>
  );
}

export default function App() {
  const { authenticated, loading, error, login } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="text-muted text-xs font-mono animate-pulse">Authenticating…</div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginScreen onLogin={login} error={error} />;
  }

  return (
    <DashboardProvider>
      <Dashboard />
    </DashboardProvider>
  );
}
