import { useState, useEffect } from 'react';
import { cacheGet, cacheSet } from './cache.js';
import { apiFetch } from './apiFetch.js';

const API_URL = import.meta.env.VITE_API_URL || '';

function buildMockOverview(filteredReps) {
  if (!filteredReps.length) {
    return {
      statusTotals: { records: [] },
      closedToday: 0, avgResponseHrs: 0, emailsToday: 0,
      dailyClosed14d: { records: [] },
      hourlyNew: { records: [] },
    };
  }

  const sum  = (fn) => filteredReps.reduce((s, r) => s + fn(r), 0);
  const n    = filteredReps.length;

  const closedToday    = sum(r => r.closedToday);
  const avgResponseHrs = sum(r => r.avgResponseHrs) / n;
  const emailsToday    = sum(r => r.emailsToday);

  const statusTotals = {
    records: [
      { Status: 'New',     cnt: sum(r => r.newCases) },
      { Status: 'Open',    cnt: sum(r => r.openCases) },
      { Status: 'Pending', cnt: sum(r => r.pendingCases) },
      { Status: 'On Hold', cnt: sum(r => r.holdCases) },
    ].filter(r => r.cnt > 0),
  };

  // Synthetic 14-day history spread from closedWeek + closedLastWeek
  const today = new Date();
  const weekdayShare  = 1 / 5;
  const weekendShare  = 0.15 / 2;
  const totalThis  = sum(r => r.closedWeek);
  const totalLast  = sum(r => r.closedLastWeek);
  const dailyClosed14d = {
    records: Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (13 - i));
      const dow = d.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const pool = i < 7 ? totalLast : totalThis;
      const cnt = Math.round(pool * (isWeekend ? weekendShare : weekdayShare));
      return { day: d.toISOString().split('T')[0], cnt };
    }),
  };

  // Synthetic hourly new cases (bell curve around noon)
  const totalNew = sum(r => r.newCasesToday ?? r.newCases);
  const weights  = Array.from({ length: 24 }, (_, hr) =>
    hr >= 7 && hr <= 18 ? Math.exp(-0.5 * ((hr - 12) / 3) ** 2) : 0,
  );
  const wSum = weights.reduce((s, w) => s + w, 0);
  const hourlyNew = {
    records: weights
      .map((w, hr) => ({ hr, cnt: wSum > 0 ? Math.round(totalNew * w / wSum) : 0 }))
      .filter(r => r.cnt > 0),
  };

  return { statusTotals, closedToday, avgResponseHrs, emailsToday, dailyClosed14d, hourlyNew };
}

export function useOverviewData({ manager, ownerId, ownerIds, period, startDate, endDate } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Build a stable dep key so we only re-fetch when filters actually change
  const filterKey = `${manager ?? ''}|${ownerId ?? ''}|${(ownerIds ?? []).join(',')}|${period ?? ''}|${startDate ?? ''}|${endDate ?? ''}`;
  const cacheKey  = `overview-data:${filterKey}`;

  useEffect(() => {
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;
    const params = new URLSearchParams();
    if (manager)              params.set('manager', manager);
    if (ownerId)              params.set('ownerId', ownerId);
    if (ownerIds?.length)     params.set('ownerIds', ownerIds.join(','));
    if (period)               params.set('period', period);
    if (startDate)            params.set('startDate', startDate);
    if (endDate)              params.set('endDate', endDate);
    const qs = params.toString();
    const url = `${API_URL}/api/overview-data${qs ? '?' + qs : ''}`;

    const controller = new AbortController();

    const fetchData = async (bypassCache = false) => {
      const cached = !bypassCache ? cacheGet(cacheKey) : null;
      if (cached) { setData(cached); setLoading(false); }
      try {
        const res = await apiFetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        cacheSet(cacheKey, raw);
        setData(raw);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[Overview] Failed to fetch overview data:', err);
        if (!cached) setData(buildMockOverview([]));
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
