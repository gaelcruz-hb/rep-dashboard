import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { DBSQLClient } from "@databricks/sql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const client = new DBSQLClient();
let _connection = null;

function getToken(host) {
  // Prefer a static PAT from the environment — avoids OAuth expiry on long-running servers.
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;

  // Fall back to the Databricks CLI OAuth session.
  const profile = process.env.DATABRICKS_PROFILE || "DEFAULT";
  try {
    const out = execSync(`databricks auth token --profile "${profile}"`, { encoding: "utf8" });
    const match = out.match(/Token:\s*(\S+)/);
    if (match) return match[1];
    // Some versions output JSON
    return JSON.parse(out).access_token;
  } catch (err) {
    throw new Error(
      `[Databricks] Could not get OAuth token for profile "${profile}". ` +
      `Set DATABRICKS_TOKEN in .env or run: databricks auth login --host https://${host}\n${err.message}`
    );
  }
}

async function getConnection() {
  if (_connection) return _connection;

  const host     = process.env.DATABRICKS_HOST;
  const httpPath = process.env.DATABRICKS_HTTP_PATH;

  if (!host || !httpPath) {
    throw new Error("[Databricks] Missing env vars: DATABRICKS_HOST, DATABRICKS_HTTP_PATH");
  }

  const token = getToken(host);

  _connection = await client.connect({ host, path: httpPath, token });
  return _connection;
}

/**
 * Run a SQL query against Databricks and return rows as plain objects.
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function query(sql) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = await getConnection();
    const session = await conn.openSession();
    let sessionClosed = false;
    try {
      const op = await session.executeStatement(sql, { runAsync: true });
      const result = await op.fetchAll();
      await op.close();
      return result;
    } catch (err) {
      sessionClosed = true;
      await session.close().catch(() => {});
      const is403 = err?.message?.includes("403") || err?.statusCode === 403;
      if (is403 && attempt === 0) {
        console.warn("[Databricks] Auth failure (403) — resetting connection and retrying...");
        _connection = null;
        continue;
      }
      throw err;
    } finally {
      if (!sessionClosed) await session.close().catch(() => {});
    }
  }
}
