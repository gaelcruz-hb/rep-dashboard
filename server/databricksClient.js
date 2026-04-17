import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { DBSQLClient } from "@databricks/sql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

let client = new DBSQLClient();
let _connection       = null;
let _connectionExpiry = Infinity;
let _m2mToken         = null;
let _m2mExpiry        = 0;
let _cliToken         = null;
let _cliExpiry        = 0;
let _lastError        = null;
let _authMethod       = null; // 'pat' | 'cli' | 'm2m' | null

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
  if (_connection && Date.now() > _connectionExpiry - 5 * 60_000) {
    console.log('[Databricks] Token expiring soon — reconnecting proactively...');
    await client.close().catch(() => {});
    client            = new DBSQLClient();
    _connection       = null;
    _connectionExpiry = Infinity;
    _m2mToken         = null;
  }

  if (_connection) return _connection;

  const host     = process.env.DATABRICKS_HOST;
  const httpPath = process.env.DATABRICKS_HTTP_PATH;

  if (!host || !httpPath) {
    throw new Error("[Databricks] Missing env vars: DATABRICKS_HOST, DATABRICKS_HTTP_PATH");
  }

  const token  = await getToken(host);
  _connection  = await client.connect({ host, path: httpPath, token });
  _connectionExpiry = _m2mExpiry || Infinity;
  return _connection;
}

/**
 * Run a SQL query against Databricks and return rows as plain objects.
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function query(sql) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let session = null;
    try {
      const conn = await getConnection();
      session    = await conn.openSession();
      const op   = await session.executeStatement(sql, { runAsync: true });
      const result = await op.fetchAll();
      await op.close();
      _lastError = null;
      return result;
    } catch (err) {
      _lastError = err.message;
      await session?.close().catch(() => {});
      if (attempt === 0) {
        const is403 = err?.message?.includes("403") || err?.statusCode === 403;
        console.warn(`[Databricks] Query failed: ${err.message} — closing client and retrying...`);
        await client.close().catch(() => {});
        client            = new DBSQLClient();
        _connection       = null;
        _connectionExpiry = Infinity;
        if (is403) { _m2mToken = null; _cliToken = null; }
        continue;
      }
      throw err;
    }
  }
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
  await client.close().catch(() => {});
  client            = new DBSQLClient();
  _connection       = null;
  _connectionExpiry = Infinity;
  _m2mToken         = null;
  _cliToken         = null;
  _lastError        = null;
  _authMethod       = null;
  await getConnection();
}
