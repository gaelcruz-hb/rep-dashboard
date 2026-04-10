import { useState, useEffect } from 'react';
import { cacheGet, cacheSet } from './cache.js';

const API_URL = import.meta.env.VITE_API_URL || '';

export function useResolutionData({ period, startDate, endDate } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const filterKey = `${period ?? ''}|${startDate ?? ''}|${endDate ?? ''}`;
  const cacheKey  = `resolution-data:${filterKey}`;

  useEffect(() => {
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;
    const params = new URLSearchParams();
    if (period)    params.set('period', period);
    if (startDate) params.set('startDate', startDate);
    if (endDate)   params.set('endDate', endDate);
    const qs  = params.toString();
    const url = `${API_URL}/api/resolution-data${qs ? '?' + qs : ''}`;

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
        console.error('[Resolution] Failed to fetch resolution data:', err);
        if (!cached) setError(err.message);
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
