import { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { REPS_DATA, DEFAULT_GOALS } from '../data/mockData';
import { ORG, MANAGERS, TEAMS, ALL_REPS, getActiveMembers } from '../data/orgData';
import { apiFetch } from '../data/apiFetch.js';

const DashboardContext = createContext(null);

export function DashboardProvider({ children }) {
  const [activeTab, setActiveTab]     = useState('overview');
  const [managerFilter, setManagerFilterRaw] = useState('all');
  function setManagerFilter(val) {
    setManagerFilterRaw(val);
    setTeamFilterRaw('all');
    setRepFilter('all');
  }
  const [teamFilter, setTeamFilterRaw] = useState('all');
  function setTeamFilter(val) {
    setTeamFilterRaw(val);
    setRepFilter('all');
  }
  const [repFilter, setRepFilterRaw]  = useState('all');
  function setRepFilter(val) {
    setRepFilterRaw(val);
    if (val !== 'all') setSelectedRep(val);
  }
  const [periodFilter, setPeriodFilter] = useState('week');
  const [customRangeMode, setCustomRangeModeRaw] = useState(false);
  const [customStartDate, setCustomStartDate]    = useState('');
  const [customEndDate, setCustomEndDate]        = useState('');
  function setCustomRangeMode(val) {
    setCustomRangeModeRaw(val);
    if (!val) { setCustomStartDate(''); setCustomEndDate(''); }
  }
  const [goals, setGoals]             = useState(DEFAULT_GOALS);
  const [goalsOpen, setGoalsOpen]     = useState(false);
  const [repList, setRepList]         = useState([]);

  useEffect(() => {
    apiFetch('/api/goals')
      .then(r => r.json())
      .then(data => setGoals(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const loadRepList = (isRetry = false) => {
      apiFetch('/api/rep-list')
        .then(r => r.json())
        .then(data => {
          const reps = (data.records ?? [])
            .map(r => ({ id: r.Id, name: r.Name }))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (reps.length === 0 && !isRetry) {
            // Databricks not ready yet — retry once after 4s
            setTimeout(() => loadRepList(true), 4000);
          } else {
            setRepList(reps);
            if (import.meta.env.DEV) {
              const sfNames = new Set(reps.map(r => r.name));
              const missing = ALL_REPS.filter(name => !sfNames.has(name));
              if (missing.length > 0) {
                console.warn('[orgData mismatch] Names not found in crm_user:\n', missing.join('\n'));
              }
            }
          }
        })
        .catch(() => {});
    };
    loadRepList();
  }, []);
  const [selectedRep, setSelectedRep] = useState(REPS_DATA[0]?.name ?? '');
  const [activeChannel, setActiveChannel] = useState('all');
  const [mgrWeek, setMgrWeek]         = useState('current');

  const lastUpdated = useMemo(() => new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  }), []);

  // Filtered reps based on current dropdowns
  const filteredReps = useMemo(() => {
    return REPS_DATA.filter(rep => {
      if (managerFilter !== 'all' && rep.manager !== managerFilter) return false;
      if (teamFilter    !== 'all' && rep.team    !== teamFilter)    return false;
      if (repFilter     !== 'all' && rep.name    !== repFilter)     return false;
      return true;
    });
  }, [managerFilter, teamFilter, repFilter]);

  const availableReps = useMemo(() => {
    let reps;
    if (managerFilter === 'all' && teamFilter === 'all') {
      reps = ALL_REPS;
    } else if (managerFilter !== 'all' && teamFilter === 'all') {
      reps = MANAGERS[managerFilter] ?? [];
    } else if (managerFilter === 'all' && teamFilter !== 'all') {
      reps = TEAMS[teamFilter] ?? [];
    } else {
      const mgr = ORG.find(m => m.manager === managerFilter);
      const team = mgr?.teams.find(t => t.name === teamFilter);
      reps = team ? getActiveMembers(team) : [];
    }
    return reps.map(name => ({ id: name, name }));
  }, [managerFilter, teamFilter]);

  const filteredRepNames = useMemo(() => {
    if (managerFilter === 'all' && teamFilter === 'all' && repFilter === 'all') return null;
    if (repFilter !== 'all') return new Set([repFilter]);
    return new Set(availableReps.map(r => r.name));
  }, [managerFilter, teamFilter, repFilter, availableReps]);

  const value = {
    // State
    activeTab, setActiveTab,
    managerFilter, setManagerFilter,
    teamFilter, setTeamFilter,
    repFilter, setRepFilter,
    periodFilter, setPeriodFilter,
    customRangeMode, setCustomRangeMode,
    customStartDate, setCustomStartDate,
    customEndDate, setCustomEndDate,
    repList,
    availableReps,
    goals, setGoals,
    goalsOpen, setGoalsOpen,
    selectedRep, setSelectedRep,
    activeChannel, setActiveChannel,
    mgrWeek, setMgrWeek,
    // Derived
    filteredReps,
    filteredRepNames,
    lastUpdated,
    allReps: REPS_DATA,
    managers: ORG.map(m => m.manager),
    teams: managerFilter === 'all'
      ? [...new Set(ORG.flatMap(m => m.teams.map(t => t.name)))]
      : ORG.find(m => m.manager === managerFilter)?.teams.map(t => t.name) ?? [],
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
