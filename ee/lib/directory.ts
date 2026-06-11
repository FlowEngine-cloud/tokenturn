import { Pool } from "pg";
import { getPool, type Db } from "@/lib/db";
import { importPeople, type PersonCsvRow } from "@/lib/people-import";

/**
 * Shared plumbing for the directory syncs (spec 11: Okta, Google
 * Workspace) - part of ee/, commercial license (see ee/LICENSE).
 *
 * Run history lands in sync_runs like every vendor connector, so each
 * directory shows the same honest health surface: last sync, rows, the
 * provider's error verbatim. Roster upserts go through the people CSV
 * import path, inheriting its semantics exactly: upsert by email, names
 * never regress, nobody is ever removed, and identities that synced before
 * their person existed auto-match with full-history re-attribution.
 */

export const DIRECTORY_SYNC_INTERVAL_MS = 60 * 60 * 1000; // hourly, like connectors

export interface DirectoryRunSummary {
  status: "success" | "error";
  rowsSynced: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** True when the directory's last run started over an hour ago (or never). */
export async function directorySyncDue(
  connector: string,
  now: Date,
  db: Db = getPool(),
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT started_at FROM sync_runs WHERE connector = $1
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [connector],
  );
  if (rows.length === 0) return true;
  return (
    (rows[0].started_at as Date).getTime() <= now.getTime() - DIRECTORY_SYNC_INTERVAL_MS
  );
}

export async function startDirectoryRun(
  connector: string,
  db: Db = getPool(),
): Promise<{ runId: string; cursor: Record<string, string> }> {
  const { rows: last } = await db.query(
    `SELECT cursor FROM sync_runs
     WHERE connector = $1 AND status = 'success' AND cursor IS NOT NULL
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [connector],
  );
  let cursor: Record<string, string> = {};
  if (last.length > 0) {
    try {
      const parsed = JSON.parse(last[0].cursor as string) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cursor = parsed as Record<string, string>;
      }
    } catch {
      cursor = {};
    }
  }
  const { rows } = await db.query(
    `INSERT INTO sync_runs (connector, status, rows_synced)
     VALUES ($1, 'running', 0) RETURNING id::text`,
    [connector],
  );
  return { runId: rows[0].id as string, cursor };
}

export async function finishDirectoryRun(
  runId: string,
  outcome:
    | { status: "success"; cursor: Record<string, string>; rowsSynced: number }
    | { status: "error"; error: string },
  db: Db = getPool(),
): Promise<void> {
  if (outcome.status === "success") {
    await db.query(
      `UPDATE sync_runs SET status = 'success', cursor = $2, rows_synced = $3,
         finished_at = now() WHERE id = $1`,
      [runId, JSON.stringify(outcome.cursor), outcome.rowsSynced],
    );
  } else {
    await db.query(
      `UPDATE sync_runs SET status = 'error', error = $2, finished_at = now()
       WHERE id = $1`,
      [runId, outcome.error],
    );
  }
}

/** The Settings health line for a directory: its latest run. */
export async function lastDirectoryRun(
  connector: string,
  db: Db = getPool(),
): Promise<DirectoryRunSummary | null> {
  const { rows } = await db.query(
    `SELECT status, rows_synced, error, started_at, finished_at FROM sync_runs
     WHERE connector = $1 AND status <> 'running'
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [connector],
  );
  if (rows.length === 0) return null;
  return {
    status: rows[0].status as "success" | "error",
    rowsSynced: rows[0].rows_synced === null ? null : Number(rows[0].rows_synced),
    error: rows[0].error as string | null,
    startedAt: (rows[0].started_at as Date).toISOString(),
    finishedAt: rows[0].finished_at ? (rows[0].finished_at as Date).toISOString() : null,
  };
}

export interface RosterPerson {
  email: string;
  name: string | null;
}

export interface RosterUpsertResult {
  created: { id: string; email: string }[];
  updated: number;
  matchedIdentities: number;
}

/** Upsert directory users through the people-import path (same semantics). */
export async function upsertRoster(
  people: RosterPerson[],
  source: "okta" | "google",
  db: Db = getPool(),
): Promise<RosterUpsertResult> {
  if (people.length === 0) {
    return { created: [], updated: 0, matchedIdentities: 0 };
  }
  const rows: PersonCsvRow[] = people.map((p, i) => ({
    line: i + 1,
    email: p.email,
    name: p.name,
    error: null,
  }));
  const pool = db instanceof Pool ? db : getPool();
  const result = await importPeople(rows, pool, source);
  return {
    created: result.rows
      .filter((r) => r.action === "created")
      .map((r) => ({ id: r.id, email: r.email })),
    updated: result.updated,
    matchedIdentities: result.matchedIdentities,
  };
}
