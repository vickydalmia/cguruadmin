import { existsSync, readFileSync } from "fs";
import path from "path";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

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
    });
  }
  return pool;
}

export async function pgQuery<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const pool = getPgPool();
  const result = await pool.query(sql, params);
  return result.rows as T[];
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
