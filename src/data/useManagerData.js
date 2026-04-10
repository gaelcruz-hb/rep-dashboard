import { useState, useEffect } from 'react';
import { REPS_DATA } from './mockData';
import { cacheGet, cacheSet } from './cache.js';

const API_URL = import.meta.env.VITE_API_URL || '';

function buildMockRaw() {
  const userInfo     = { records: REPS_DATA.map((r, i) => ({ Id: `mock_${i}`, Name: r.name, Manager: { Name: r.manager }, UserRole: { Name: r.team } })) };
  const openByStatus = { records: REPS_DATA.flatMap((r, i) => [
    ...(r.openCases - r.holdCases > 0 ? [{ OwnerId: `mock_${i}`, Name: r.name, cnt: r.openCases - r.holdCases, Status: 'Open' }] : []),
    ...(r.holdCases > 0              ? [{ OwnerId: `mock_${i}`, Name: r.name, cnt: r.holdCases,                Status: 'On Hold' }] : []),
  ]) };
  const closedWeek   = { records: REPS_DATA.map((r, i) => ({ OwnerId: `mock_${i}`, cnt: r.closedWeek })) };
  const avgResponse  = { records: REPS_DATA.map((r, i) => ({ OwnerId: `mock_${i}`, avgRespHrs: r.avgResponseHrs })) };
  const csatData     = { records: REPS_DATA.map((r, i) => ({ OwnerId: `mock_${i}`, Satisfaction_Score__c: r.instascore })) };
  return { userInfo, openByStatus, closedWeek, avgResponse, csatData };
}

export function useManagerData({ period, startDate, endDate } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const filterKey = `${period ?? ''}|${startDate ?? ''}|${endDate ?? ''}`;
  const cacheKey  = `manager-data:${filterKey}`;

  useEffect(() => {
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;
    const params = new URLSearchParams();
    if (period)    params.set('period', period);
    if (startDate) params.set('startDate', startDate);
    if (endDate)   params.set('endDate', endDate);
    const qs  = params.toString();
    const url = `${API_URL}/api/manager-data${qs ? '?' + qs : ''}`;

    const controller = new AbortController();

    const fetchData = async (bypassCache = false) => {
      const cached = !bypassCache ? cacheGet(cacheKey) : null;
      if (cached) { setData(cached); setLoading(false); }
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        cacheSet(cacheKey, raw);
        setData(raw);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[Manager] Failed to fetch manager data:', err);
        if (!cached) setData(buildMockRaw());
        setError(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    setLoading(true);
    fetchData();
    if (startDate && endDate) return () => controller.abort();
    const interval = setInterval(() => fetchData(true), 90 * 1000);
    return () => { clearInterval(interval); controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  return { data, loading, error };
}
