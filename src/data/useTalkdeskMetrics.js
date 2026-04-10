import { useState, useEffect, useMemo } from 'react';
import { cacheGet, cacheSet } from './cache.js';
import { useDashboard } from '../context/DashboardContext';

const API_URL = import.meta.env.VITE_API_URL || '';

// Must match server-side normalizeName
const normalize = name => (name ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

export function useTalkdeskMetrics() {
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tdError, setTdError] = useState(null);
  const {
    managerFilter, teamFilter, repFilter, availableReps, periodFilter,
    customRangeMode, customStartDate, customEndDate,
  } = useDashboard();

  useEffect(() => {
    if (customRangeMode && (!customStartDate || !customEndDate)) return;

    const params = new URLSearchParams();
    if (customRangeMode && customStartDate && customEndDate) {
      params.set('startDate', customStartDate);
      params.set('endDate', customEndDate);
    } else {
      params.set('period', periodFilter);
    }

    const cacheKey = `talkdesk-metrics:${periodFilter ?? ''}|${customStartDate ?? ''}|${customEndDate ?? ''}`;
    const controller = new AbortController();
    let retryTimer = null;

    const fetchData = async (bypassCache = false) => {
      const cached = !bypassCache ? cacheGet(cacheKey) : null;
      if (cached) { setRaw(cached); setLoading(false); }
      try {
        const res = await fetch(`${API_URL}/api/talkdesk-metrics?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // Server cache still warming up — retry in 15s rather than waiting the full poll interval
        if (json?.refreshing) {
          retryTimer = setTimeout(fetchData, 15_000);
          return;
        }
        cacheSet(cacheKey, json, 300_000);
        setRaw(json);
        if (json?.errors) {
          console.warn('[TalkdeskMetrics] Server-side job errors:', json.errors);
          setTdError(json.errors);
        } else {
          setTdError(null);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[TalkdeskMetrics] Failed to fetch:', err);
        if (!cached) setTdError({ fetch: err.message });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();
    // Skip auto-poll for custom date ranges — historical data doesn't change
    if (customRangeMode) return () => { controller.abort(); if (retryTimer) clearTimeout(retryTimer); };
    const interval = setInterval(() => fetchData(true), 5 * 60 * 1000); // 5 min — matches server cache TTL
    return () => { clearInterval(interval); controller.abort(); if (retryTimer) clearTimeout(retryTimer); };
  }, [periodFilter, customRangeMode, customStartDate, customEndDate]);

  const data = useMemo(() => {
    if (!raw) return null;

    // Legacy shape (server not yet updated to { org, byAgent })
    if (!raw.org) return raw;

    const { org, byAgent } = raw;

    // No filter → org-wide aggregate
    if (managerFilter === 'all' && teamFilter === 'all' && repFilter === 'all') {
      return org;
    }

    // Single rep filter — look up by normalized name
    if (repFilter !== 'all') {
      const entry = byAgent[normalize(repFilter)];
      if (!entry) return null;
      return { avgHoldSec: entry.avgHoldSec ?? null, avgAvailPct: entry.availPct ?? null };
    }

    // Manager or team filter — average over all reps in scope
    const entries = availableReps
      .map(r => byAgent[normalize(r.name)])
      .filter(Boolean);
    if (!entries.length) return org;

    const holdEntries  = entries.filter(e => e.avgHoldSec != null);
    const availEntries = entries.filter(e => e.availPct   != null);
    return {
      avgHoldSec:  holdEntries.length  ? Math.round(holdEntries.reduce((s, e) => s + e.avgHoldSec, 0) / holdEntries.length)                          : null,
      avgAvailPct: availEntries.length ? parseFloat((availEntries.reduce((s, e) => s + e.availPct,  0) / availEntries.length).toFixed(1)) : null,
    };
  }, [raw, managerFilter, teamFilter, repFilter, availableReps]);

  return { data, loading, byAgent: raw?.byAgent ?? {}, error: tdError };
}
