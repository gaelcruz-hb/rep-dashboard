import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DBSQLClient } from "@databricks/sql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const client = new DBSQLClient();
let _connection = null;

async function getConnection() {
  if (_connection) return _connection;

  const host     = process.env.DATABRICKS_HOST;
  const httpPath = process.env.DATABRICKS_HTTP_PATH;
  const token    = process.env.DATABRICKS_TOKEN;

  if (!host || !httpPath || !token) {
    throw new Error(
      "[Databricks] Missing env vars: DATABRICKS_HOST, DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN. " +
      "These are auto-injected by Databricks Apps at runtime. For local dev, add them to server/.env"
    );
  }

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
