import { useState, useEffect } from 'react';
import { cacheGet, cacheSet } from './cache.js';
import { apiFetch } from './apiFetch.js';

const API_URL = import.meta.env.VITE_API_URL || '';

export function useRepDetail(ownerId, period = 'week', startDate, endDate) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!ownerId) return;
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;

    const cacheKey = `rep-detail:${ownerId ?? ''}|${period ?? ''}|${startDate ?? ''}|${endDate ?? ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) { setData(cached); setLoading(false); }
    else { setLoading(true); setData(null); }

    const controller = new AbortController();
    const params = new URLSearchParams({ ownerId });
    if (startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    } else {
      params.set('period', period);
    }

    apiFetch(`${API_URL}/api/rep-detail?${params.toString()}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(raw => { cacheSet(cacheKey, raw); setData(raw); setError(null); })
      .catch(err => {
        if (err.name === 'AbortError') return;
        console.error('[RepDetail] Failed to fetch rep detail:', err);
        if (!cached) setError(err.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [ownerId, period, startDate, endDate]);

  return { data, loading, error };
}
