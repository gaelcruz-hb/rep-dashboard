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

function LevelAIDiagnostics() {
  const [checks,  setChecks]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [ran,     setRan]     = useState(false);

  async function runChecks() {
    setLoading(true);
    setRan(true);
    try {
      const res = await apiFetch('/api/diagnostics/levelai');
      const body = await res.json();
      setChecks(body.checks ?? []);
    } catch (err) {
      setChecks([{ label: 'Request failed', ok: false, error: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text">LevelAI Instascore</h2>
          <p className="text-[11px] text-muted mt-0.5">Checks table access, email join, and data availability</p>
        </div>
        <button
          onClick={runChecks}
          disabled={loading}
          className="text-[11px] bg-accent/10 text-accent border border-accent/30 px-3 py-1.5 rounded-md hover:bg-accent/20 transition-colors font-mono disabled:opacity-50 cursor-pointer"
        >
          {loading ? 'Running…' : ran ? '↻ Re-run' : '▶ Run checks'}
        </button>
      </div>

      {loading && (
        <p className="text-xs text-muted font-mono animate-pulse">Running diagnostics…</p>
      )}

      {!loading && checks && (
        <div className="flex flex-col gap-2">
          {checks.map((c, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex items-start gap-2 text-xs font-mono">
                <span className={`mt-px shrink-0 ${c.ok ? 'text-success' : 'text-danger'}`}>
                  {c.ok ? '✓' : '✗'}
                </span>
                <span className="text-muted">{c.label}</span>
              </div>
              {c.ok && c.value && (
                <div className="ml-5 text-[11px] font-mono text-text bg-surface2 border border-border/60 rounded px-2 py-1 break-all">
                  {c.value}
                </div>
              )}
              {!c.ok && c.error && (
                <div className="ml-5 text-[11px] font-mono text-danger bg-surface2 border border-danger/30 rounded px-2 py-1 break-all">
                  {c.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationInspector() {
  const [inputId, setInputId]   = useState('');
  const [loading, setLoading]   = useState(false);
  const [result,  setResult]    = useState(null);
  const [error,   setError]     = useState(null);

  async function inspect() {
    const id = inputId.trim();
    if (!id) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res  = await apiFetch(`/api/instascore/conversation/${encodeURIComponent(id)}`);
      const body = await res.json();
      if (body.error) setError(body.error);
      else setResult(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const scoreColor = pct => {
    const p = Math.max(0, Math.min(100, pct));
    if (p <= 50) {
      const t = p / 50;
      return `rgb(${Math.round(224+(245-224)*t)},${Math.round(92+(166-92)*t)},${Math.round(92+(35-92)*t)})`;
    }
    const t = (p - 50) / 50;
    return `rgb(${Math.round(245+(56-245)*t)},${Math.round(166+(217-166)*t)},${Math.round(35+(169-35)*t)})`;
  };

  return (
    <div className="bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-text">Conversation Instascore Inspector</h2>
        <p className="text-[11px] text-muted mt-0.5">Shows every scored question for a single conversation ID and traces the calculation</p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={inputId}
          onChange={e => setInputId(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && inspect()}
          placeholder="ASR Log ID (e.g. 568758)"
          className="flex-1 bg-surface2 border border-border text-text px-3 py-1.5 rounded-md text-xs font-mono outline-none focus:border-accent transition-colors"
        />
        <button
          onClick={inspect}
          disabled={loading || !inputId.trim()}
          className="text-[11px] bg-accent/10 text-accent border border-accent/30 px-3 py-1.5 rounded-md hover:bg-accent/20 transition-colors font-mono disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          {loading ? 'Fetching…' : '▶ Inspect'}
        </button>
      </div>

      {error && (
        <div className="text-[11px] font-mono text-danger bg-surface2 border border-danger/30 rounded px-3 py-2 break-all">
          {error}
        </div>
      )}

      {result && result.summary && (
        <div className="flex flex-col gap-3">
          {/* Summary */}
          <div className="bg-surface2 border border-border rounded-lg p-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted">Instascore</span>
              <span
                className="text-sm font-bold font-mono px-2 py-0.5 rounded text-black/70"
                style={{ backgroundColor: scoreColor(result.summary.instascore) }}
              >
                {result.summary.instascore}%
              </span>
              <span className="text-[10px] text-muted font-mono ml-auto">{result.summary.total_questions} questions</span>
            </div>
            <div className="text-[10px] font-mono text-muted break-all leading-relaxed mt-1">
              <span className="text-muted/60">Formula: </span>{result.summary.formula}
            </div>
          </div>

          {/* All rubrics found on this conversation */}
          {result.all_rubrics?.length > 0 && (
            <div className="text-[11px] font-mono bg-surface2 border border-border rounded px-3 py-2 flex flex-col gap-1">
              <span className="text-muted uppercase tracking-wider text-[10px]">All rubrics on this conversation</span>
              {result.all_rubrics.map(r => (
                <div key={r.rubric_title} className={`flex items-center gap-2 ${r.rubric_title === 'Unstoppable Call Experience (IS)' ? 'text-accent' : 'text-muted/60'}`}>
                  <span>{r.rubric_title === 'Unstoppable Call Experience (IS)' ? '✓' : '○'}</span>
                  <span>{r.rubric_title}</span>
                  <span className="ml-auto text-muted">{r.question_count}q</span>
                </div>
              ))}
            </div>
          )}

          {/* Per-question rows */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px] font-mono">
              <thead>
                <tr className="text-muted">
                  <th className="text-left px-2 py-1.5 border-b border-border font-normal">Question</th>
                  <th className="text-left px-2 py-1.5 border-b border-border font-normal whitespace-nowrap">Category</th>
                  <th className="text-left px-2 py-1.5 border-b border-border font-normal whitespace-nowrap">Section</th>
                  <th className="text-left px-2 py-1.5 border-b border-border font-normal whitespace-nowrap">Selected Option</th>
                  <th className="text-right px-2 py-1.5 border-b border-border font-normal whitespace-nowrap">Q Score %</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i} className="hover:bg-surface2 transition-colors">
                    <td className="px-2 py-1.5 border-b border-border/40 text-text max-w-[280px]">{r.question}</td>
                    <td className="px-2 py-1.5 border-b border-border/40 text-muted whitespace-nowrap">{r.category}</td>
                    <td className="px-2 py-1.5 border-b border-border/40 text-muted whitespace-nowrap">{r.section}</td>
                    <td className="px-2 py-1.5 border-b border-border/40 text-muted">{r.selected_option ?? '—'}</td>
                    <td className="px-2 py-1.5 border-b border-border/40 text-right">
                      <span
                        className="inline-block px-1.5 py-0.5 rounded text-black/70 font-bold"
                        style={{ backgroundColor: scoreColor(r.question_score_pcnt) }}
                      >
                        {r.question_score_pcnt}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && result.rows?.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-danger font-mono">{result.debug ?? `No rows found for ID ${result.asr_log_id} with the active rubric filter`}</p>
          {result.all_rubrics?.length > 0 && (
            <div className="text-[11px] font-mono text-muted bg-surface2 border border-border rounded px-3 py-2">
              <span className="text-text">Rubrics found for this ID:</span>
              {result.all_rubrics.map(r => (
                <div key={r.rubric_title} className="ml-2">• {r.rubric_title} ({r.question_count} questions)</div>
              ))}
            </div>
          )}
        </div>
      )}
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

      <LevelAIDiagnostics />

      <ConversationInspector />

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
