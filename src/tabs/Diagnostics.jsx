import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../data/apiFetch';

function EnvRow({ label, ok }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className={ok ? 'text-success' : 'text-danger'}>{ok ? '✓' : '✗'}</span>
      <span className={ok ? 'text-text' : 'text-muted'}>{label}</span>
    </div>
  );
}

export function Diagnostics() {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectResult, setReconnectResult] = useState(null);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/diagnostics');
      setData(await res.json());
    } catch (err) {
      setData({ error: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDiagnostics(); }, [fetchDiagnostics]);

  async function handleReconnect() {
    setReconnecting(true);
    setReconnectResult(null);
    try {
      const res  = await apiFetch('/api/reconnect', { method: 'POST' });
      const body = await res.json();
      setReconnectResult({ ok: body.ok, error: body.error ?? null });
      if (body.diagnostics) setData(body.diagnostics);
    } catch (err) {
      setReconnectResult({ ok: false, error: err.message });
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto mt-6 flex flex-col gap-5">
      <div className="bg-surface border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text">Databricks Connection</h2>
          <button
            onClick={fetchDiagnostics}
            disabled={loading}
            className="text-[11px] text-muted hover:text-accent transition-colors font-mono"
          >
            {loading ? 'loading…' : '↻ refresh'}
          </button>
        </div>

        {loading && !data && (
          <p className="text-xs text-muted">Checking…</p>
        )}

        {data && !data.error && (
          <div className="flex flex-col gap-4">
            {/* Status */}
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${data.connected ? 'bg-success' : 'bg-danger'}`} />
              <span className="text-sm font-medium text-text">
                {data.connected ? 'Connected' : 'Disconnected'}
              </span>
              {data.authMethod && (
                <span className="ml-auto text-[11px] font-mono bg-surface2 border border-border px-2 py-0.5 rounded text-accent uppercase">
                  {data.authMethod}
                </span>
              )}
            </div>

            {/* Token expiry */}
            {data.tokenExpiry && (
              <div className="text-xs text-muted font-mono">
                Token expires: {new Date(data.tokenExpiry).toLocaleString()}
              </div>
            )}

            {/* Env vars */}
            <div className="border-t border-border pt-3 flex flex-col gap-1.5">
              <p className="text-[11px] text-muted uppercase tracking-wider mb-1">Environment</p>
              <EnvRow label="DATABRICKS_HOST"          ok={data.env?.hasHost} />
              <EnvRow label="DATABRICKS_HTTP_PATH"     ok={data.env?.hasHttpPath} />
              <EnvRow label="DATABRICKS_TOKEN"         ok={data.env?.hasToken} />
              <EnvRow label="DATABRICKS_CLIENT_ID"     ok={data.env?.hasClientId} />
              <EnvRow label="DATABRICKS_CLIENT_SECRET" ok={data.env?.hasClientSecret} />
            </div>

            {/* Last error */}
            {data.lastError && (
              <div className="border-t border-border pt-3">
                <p className="text-[11px] text-muted uppercase tracking-wider mb-1.5">Last Error</p>
                <pre className="text-[11px] font-mono text-danger bg-surface2 border border-border rounded p-3 whitespace-pre-wrap break-words">
                  {data.lastError}
                </pre>
              </div>
            )}
          </div>
        )}

        {data?.error && (
          <p className="text-xs text-danger font-mono">{data.error}</p>
        )}
      </div>

      {/* Reconnect */}
      <div className="bg-surface border border-border rounded-lg p-5 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text">Force Reconnect</h2>
        <p className="text-xs text-muted">
          Clears the current connection and token cache, then establishes a fresh connection.
          Use this if the dashboard is stuck on 403 errors.
        </p>
        <button
          onClick={handleReconnect}
          disabled={reconnecting}
          className="self-start bg-accent text-white px-4 py-2 rounded-md text-xs font-medium hover:opacity-85 transition-opacity disabled:opacity-50 cursor-pointer"
        >
          {reconnecting ? 'Reconnecting…' : '⚡ Force Reconnect'}
        </button>

        {reconnectResult && (
          <div className={`text-xs font-mono px-3 py-2 rounded border ${
            reconnectResult.ok
              ? 'text-success bg-surface2 border-border'
              : 'text-danger bg-surface2 border-danger/40'
          }`}>
            {reconnectResult.ok ? 'Reconnected successfully.' : `Failed: ${reconnectResult.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
