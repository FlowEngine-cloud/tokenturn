/**
 * Migration runner. Runs on container boot, before the server starts.
 *
 * - Applies migrations/*.sql in lexicographic order (use NNN_name.sql).
 * - Each migration runs in its own transaction and is recorded in
 *   schema_migrations; already-applied files are skipped.
 * - A Postgres advisory lock serializes concurrent boots.
 * - Any failure rolls back that migration and exits non-zero, so the
 *   container never starts on a half-applied schema.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

// Stable app-wide advisory lock key: first 8 hex chars of sha256("ai-pnl:migrate").
const LOCK_KEY = parseInt(
  createHash("sha256").update("ai-pnl:migrate").digest("hex").slice(0, 8),
  16,
);

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    component: "migrate",
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

async function listMigrationFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Apply pending migrations from `dir` against `databaseUrl`.
 * Returns the list of migration names applied in this run.
 */
export async function runMigrations({ databaseUrl, dir }) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = await listMigrationFiles(dir);
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`, {
          cause: err,
        });
      }
      applied.push(file);
      log("info", "migration applied", { file });
    }

    log("info", "migrations up to date", {
      total: files.length,
      appliedNow: applied.length,
    });
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    } catch {
      // Connection may already be broken; end() below closes it either way.
    }
    await client.end();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "..", "migrations");
  runMigrations({ databaseUrl: process.env.DATABASE_URL, dir }).catch(
    (err) => {
      log("error", "migration run failed", {
        error: { name: err.name, message: err.message, stack: err.stack },
      });
      process.exit(1);
    },
  );
}
