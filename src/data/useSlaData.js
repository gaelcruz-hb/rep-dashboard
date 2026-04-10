import { useState, useEffect } from 'react';
import { cacheGet, cacheSet } from './cache.js';

const API_URL = import.meta.env.VITE_API_URL || '';

export function useSlaData({ period, startDate, endDate, ownerIds, ownerId } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const filterKey = `${period ?? ''}|${startDate ?? ''}|${endDate ?? ''}|${ownerId ?? ''}|${(ownerIds ?? []).join(',')}`;
  const cacheKey  = `sla-data:${filterKey}`;

  useEffect(() => {
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;
    const params = new URLSearchParams();
    if (period)           params.set('period', period);
    if (startDate)        params.set('startDate', startDate);
    if (endDate)          params.set('endDate', endDate);
    if (ownerId)          params.set('ownerId', ownerId);
    if (ownerIds?.length) params.set('ownerIds', ownerIds.join(','));
    const qs  = params.toString();
    const url = `${API_URL}/api/sla-data${qs ? '?' + qs : ''}`;

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
        console.error('[SLA] Failed to fetch sla data:', err);
        if (!cached) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    setLoading(true);
    fetchData();
    // Skip auto-poll for custom date ranges — historical data doesn't change
    if (startDate && endDate) return () => controller.abort();
    const interval = setInterval(() => fetchData(true), 90 * 1000);
    return () => { clearInterval(interval); controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  return { data, loading, error };
}
