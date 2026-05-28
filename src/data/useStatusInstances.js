import { useState, useEffect } from 'react';
import { apiFetch } from './apiFetch.js';

const API_URL = import.meta.env.VITE_API_URL || '';

export function useStatusInstances(ownerId, period = 'week', startDate, endDate) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ownerId) return;
    setLoading(true);
    setData(null);
    const params = new URLSearchParams({ ownerId });
    if (startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    } else {
      params.set('period', period);
    }
    apiFetch(`${API_URL}/api/rep-status-instances?${params}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [ownerId, period, startDate, endDate]);

  return { data, loading };
}
