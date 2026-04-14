import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DBSQLClient } from "@databricks/sql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const client = new DBSQLClient();
let _connection = null;
let _m2mToken   = null;
let _m2mExpiry  = 0;
let _userToken  = null;

// Called by server middleware on each request to keep the token current.
export function setUserToken(token) {
  if (token && token !== _userToken) {
    _userToken  = token;
    _connection = null; // reconnect with the updated token
  }
}

async function getM2MToken(host) {
  // Return cached token if still valid (with 60s buffer)
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
  // Option 1: user OAuth token forwarded by Databricks Apps (preferred — runs as the user)
  if (_userToken) return _userToken;

  // Option 2: static token (local dev via server/.env)
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;

  // Option 3: M2M OAuth via service principal (fallback)
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    return getM2MToken(host);
  }

  throw new Error(
    "[Databricks] No auth configured. For local dev, set DATABRICKS_TOKEN in server/.env"
  );
}

async function getConnection() {
  if (_connection) return _connection;

  const host     = process.env.DATABRICKS_HOST;
  const httpPath = process.env.DATABRICKS_HTTP_PATH;

  if (!host || !httpPath) {
    throw new Error("[Databricks] Missing env vars: DATABRICKS_HOST, DATABRICKS_HTTP_PATH");
  }

  const token  = await getToken(host);
  _connection  = await client.connect({ host, path: httpPath, token });
  return _connection;
}

/**
 * Run a SQL query against Databricks and return rows as plain objects.
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function query(sql) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn    = await getConnection();
    const session = await conn.openSession();
    let sessionClosed = false;
    try {
      const op     = await session.executeStatement(sql, { runAsync: true });
      const result = await op.fetchAll();
      await op.close();
      return result;
    } catch (err) {
      sessionClosed = true;
      await session.close().catch(() => {});
      const is403 = err?.message?.includes("403") || err?.statusCode === 403;
      if (is403 && attempt === 0) {
        console.warn("[Databricks] Auth failure (403) — resetting and retrying...");
        _connection = null;
        _m2mToken   = null;
        _userToken  = null;
        continue;
      }
      throw err;
    } finally {
      if (!sessionClosed) await session.close().catch(() => {});
    }
  }
}
