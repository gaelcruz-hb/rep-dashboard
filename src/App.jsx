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
  return (
    <DashboardProvider>
      <Dashboard />
    </DashboardProvider>
  );
}
