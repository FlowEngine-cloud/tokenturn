import { Pool } from "pg";

/**
 * Shared Postgres pool. DATABASE_URL is the only env var the app reads
 * (spec 12b); everything else lives in the DB.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/** Test-only: drop the cached pool so the next getPool() re-reads the env. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
