import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { DBSQLClient } from "@databricks/sql";
import pLimit from "p-limit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

let client = null;
let _connection       = null;
let _connectionExpiry = Infinity;
let _m2mToken         = null;
let _m2mExpiry        = 0;
let _cliToken         = null;
let _cliExpiry        = 0;
let _lastError        = null;
let _authMethod       = null; // 'pat' | 'cli' | 'm2m' | null

// Single-flight guard so concurrent callers share ONE connect attempt instead of
// each closing + recreating the shared client (which used to abort siblings).
let _connectPromise   = null;
// Monotonic generation of the live connection. A query captures the gen it ran on;
// only the first failure on that gen triggers a reconnect (later failers are no-ops).
let _gen              = 0;

// Cap concurrent Databricks statements so a burst of requests (each fanning out many
// queries) can't overwhelm the SQL warehouse — excess queries queue inside Node.
const MAX_CONCURRENCY = Number(process.env.DATABRICKS_MAX_CONCURRENCY) || 8;
// Generous by design: the goal is to release a TRULY stuck session, not to fail slow-but-
// progressing queries. A serverless SQL warehouse can take ~30-60s just to wake from idle,
// so a tight timeout would newly break legitimate cold-start loads.
const QUERY_TIMEOUT_MS = Number(process.env.DATABRICKS_QUERY_TIMEOUT_MS) || 90_000;
const GRACE_CLOSE_MS   = 30_000; // let in-flight siblings finish before closing an old client
const limit = pLimit(MAX_CONCURRENCY);

// Errors that mean "the connection/auth is bad, reconnect" vs a plain query error (just throw).
// Note: our own statement timeout (QUERY_TIMEOUT_MS) is intentionally NOT treated as a connection
// error — a single slow query shouldn't rotate the shared connection or get retried (which would
// double the wait under load). Genuine dead connections surface as closed/socket/reset instead.
function isConnectionError(err) {
  if (err?.isQueryTimeout) return false;
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    err?.statusCode === 401 || err?.statusCode === 403 ||
    /\b(401|403)\b/.test(msg) ||
    msg.includes("closed") || msg.includes("econnreset") || msg.includes("socket") ||
    msg.includes("thrift") || msg.includes("texception") ||
    msg.includes("connection reset") || msg.includes("connection refused")
  );
}

// Invalidate the live connection exactly once per generation. Schedules the old client
// to close after a grace period so queries still running on it aren't killed mid-flight.
function invalidateConnection(gen, { clearTokens } = {}) {
  if (gen !== _gen) return;          // someone else already rotated this connection
  _gen += 1;
  const stale = client;
  _connection = null;
  client = null;
  _connectionExpiry = Infinity;
  if (clearTokens) { _m2mToken = null; _cliToken = null; }
  if (stale) setTimeout(() => { stale.close().catch(() => {}); }, GRACE_CLOSE_MS);
}

function getCliToken() {
  if (_cliToken && Date.now() < _cliExpiry - 60_000) return _cliToken;

  const profile = process.env.DATABRICKS_PROFILE;
  const args    = ['auth', 'token', ...(profile ? ['--profile', profile] : [])];
  try {
    const out  = execFileSync('databricks', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const data = JSON.parse(out);
    _cliToken  = data.access_token;
    _cliExpiry = data.expiry
      ? new Date(data.expiry).getTime()
      : Date.now() + 50 * 60_000;
    return _cliToken;
  } catch {
    return null;
  }
}

async function getM2MToken(host) {
  if (_m2mToken && Date.now() < _m2mExpiry - 60_000) return _m2mToken;

  const resp = await fetch(`https://${host}/oidc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     process.env.DATABRICKS_CLIENT_ID,
      client_secret: process.env.DATABRICKS_CLIENT_SECRET,
      scope:         "all-apis",
    }),
  });

  if (!resp.ok) {
    throw new Error(`[Databricks] M2M OAuth failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  _m2mToken  = data.access_token;
  _m2mExpiry = Date.now() + data.expires_in * 1000;
  return _m2mToken;
}

async function getToken(host) {
  if (process.env.DATABRICKS_TOKEN) {
    _authMethod = 'pat';
    return process.env.DATABRICKS_TOKEN;
  }

  const cliToken = getCliToken();
  if (cliToken) {
    _authMethod = 'cli';
    return cliToken;
  }

  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    _authMethod = 'm2m';
    return getM2MToken(host);
  }

  throw new Error(
    "[Databricks] No auth configured. Set DATABRICKS_TOKEN, run `databricks auth login`, or configure DATABRICKS_CLIENT_ID/SECRET."
  );
}

async function getConnection() {
  // Proactively rotate before the token expires — go through invalidateConnection so the
  // old client is grace-closed (not killed) and a single reconnect happens below.
  if (_connection && Date.now() > _connectionExpiry - 5 * 60_000) {
    console.log('[Databricks] Token expiring soon — reconnecting proactively...');
    invalidateConnection(_gen, { clearTokens: true });
  }

  if (_connection) return _connection;

  // Single-flight: all concurrent callers await the same connect attempt.
  if (_connectPromise) return _connectPromise;

  _connectPromise = (async () => {
    const host     = process.env.DATABRICKS_HOST;
    const httpPath = process.env.DATABRICKS_HTTP_PATH;
    if (!host || !httpPath) {
      throw new Error("[Databricks] Missing env vars: DATABRICKS_HOST, DATABRICKS_HTTP_PATH");
    }
    const fresh = new DBSQLClient();
    const token = await getToken(host);
    const conn  = await fresh.connect({ host, path: httpPath, token });
    client            = fresh;
    _connection       = conn;
    _connectionExpiry = _m2mExpiry || Infinity;
    return conn;
  })();

  try {
    return await _connectPromise;
  } finally {
    _connectPromise = null;
  }
}

// Open a session, run the statement, fetch results — with a timeout that cancels the
// operation so a hung query releases its concurrency slot instead of blocking forever.
async function runStatement(conn, sql) {
  const session = await conn.openSession();
  let op = null;
  let timer = null;
  try {
    const exec = (async () => {
      op = await session.executeStatement(sql, { runAsync: true });
      return op.fetchAll();
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`Databricks query timed out after ${QUERY_TIMEOUT_MS}ms`);
        e.isQueryTimeout = true;
        reject(e);
      }, QUERY_TIMEOUT_MS);
    });
    return await Promise.race([exec, timeout]);
  } finally {
    clearTimeout(timer);
    await op?.cancel?.().catch(() => {});
    await op?.close?.().catch(() => {});
    await session.close().catch(() => {});
  }
}

/**
 * Run a SQL query against Databricks and return rows as plain objects.
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function query(sql) {
  // Bound concurrent statements against the warehouse; excess queue here, not on Databricks.
  return limit(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await getConnection();
      const gen  = _gen;                 // capture the generation we ran on
      try {
        const result = await runStatement(conn, sql);
        _lastError = null;
        return result;
      } catch (err) {
        _lastError = err.message;
        // Only reconnect+retry for connection/auth errors — and only once per generation,
        // so a single failure doesn't kill or stampede sibling queries.
        if (attempt === 0 && isConnectionError(err)) {
          const is401or403 = err?.statusCode === 401 || err?.statusCode === 403
            || /\b(401|403)\b/.test(String(err?.message ?? ""));
          console.warn(`[Databricks] Query failed (${err.message}) — rotating connection and retrying...`);
          invalidateConnection(gen, { clearTokens: is401or403 });
          continue;
        }
        throw err;
      }
    }
  });
}

export function getDiagnostics() {
  return {
    connected:   _connection !== null,
    authMethod:  _authMethod,
    tokenExpiry: _m2mExpiry ? new Date(_m2mExpiry).toISOString() : null,
    lastError:   _lastError,
    env: {
      hasHost:         !!process.env.DATABRICKS_HOST,
      hasHttpPath:     !!process.env.DATABRICKS_HTTP_PATH,
      hasToken:        !!process.env.DATABRICKS_TOKEN,
      hasClientId:     !!process.env.DATABRICKS_CLIENT_ID,
      hasClientSecret: !!process.env.DATABRICKS_CLIENT_SECRET,
    },
  };
}

export async function resetConnection() {
  await client?.close().catch(() => {});
  _gen             += 1;
  _connectPromise   = null;
  client            = null;
  _connection       = null;
  _connectionExpiry = Infinity;
  _m2mToken         = null;
  _cliToken         = null;
  _lastError        = null;
  _authMethod       = null;
  await getConnection();
}

export async function getDbToken() {
  const host = process.env.DATABRICKS_HOST;
  if (!host) throw new Error('[Databricks] Missing DATABRICKS_HOST');
  return getToken(host);
}
