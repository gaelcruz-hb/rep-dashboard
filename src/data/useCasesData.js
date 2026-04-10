import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

export function useCasesData({ period, startDate, endDate, manager, ownerId, ownerIds } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const filterKey = [period, startDate, endDate, manager, ownerId, (ownerIds ?? []).join(',')].join('|');

  useEffect(() => {
    if (startDate !== undefined && endDate !== undefined && (!startDate || !endDate)) return;
    const params = new URLSearchParams();
    if (period)    params.set('period', period);
    if (startDate) params.set('startDate', startDate);
    if (endDate)   params.set('endDate', endDate);
    if (manager)   params.set('manager', manager);
    if (ownerId)   params.set('ownerId', ownerId);
    if (ownerIds?.length) params.set('ownerIds', ownerIds.join(','));
    const qs  = params.toString();
    const url = `${API_URL}/api/cases-data${qs ? '?' + qs : ''}`;

    const fetchData = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        setData(raw);
        setError(null);
      } catch (err) {
        console.error('[Cases] Failed to fetch cases data:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    setLoading(true);
    fetchData();
    // Skip auto-poll for custom date ranges — historical data doesn't change
    if (startDate && endDate) return;
    const interval = setInterval(fetchData, 90 * 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  return { data, loading, error };
}
