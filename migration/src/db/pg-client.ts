import { AsyncLocalStorage } from "async_hooks";
import { existsSync, readFileSync } from "fs";
import path from "path";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

// When set, pgQuery routes through this client so a whole call tree can run
// inside one transaction without threading the client through every helper.
const txStorage = new AsyncLocalStorage<pg.PoolClient>();

function buildSslConfig(): pg.PoolConfig["ssl"] {
  const { caCertPath, rejectUnauthorized } = config.pg;
  if (!caCertPath) return false;
  const resolved = path.isAbsolute(caCertPath)
    ? caCertPath
    : path.resolve(process.cwd(), caCertPath);
  if (!existsSync(resolved)) {
    throw new Error(`PG CA cert not found at ${resolved}`);
  }
  return { ca: readFileSync(resolved, "utf8"), rejectUnauthorized };
}

export function getPgPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.pg.connectionString,
      ssl: buildSslConfig(),
      max: 10,
      // Fail fast instead of hanging when the host is unreachable.
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function pgQuery<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const tx = txStorage.getStore();
  const result = tx
    ? await tx.query(sql, params)
    : await getPgPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Runs fn inside BEGIN/COMMIT on a dedicated client; every pgQuery made
 * (directly or transitively) during fn joins the transaction. Rolls back on
 * error so a crashed run leaves no partial rows. Nested calls join the
 * outer transaction.
 */
export async function pgTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txStorage.getStore()) return fn();
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    const result = await txStorage.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the pool will discard it
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pgQueryOne<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const rows = await pgQuery<T>(sql, params);
  return rows[0] || null;
}

export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
