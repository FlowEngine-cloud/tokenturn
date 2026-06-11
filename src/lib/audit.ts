import type { SessionUser } from "./auth";
import { getPool, type Db } from "./db";
import { logger } from "./logger";

/**
 * The audit log (spec 11): every sweep, every settings change, exportable.
 * Recording is always on - an instance that buys a license later gets its
 * full history; viewing and exporting (src/app/api/audit) is the licensed
 * feature. Detail rows never contain secret values - callers log keys and
 * outcomes, never credentials.
 */

export type AuditActor = SessionUser | "system";

export async function audit(
  actor: AuditActor,
  action: string,
  detail: Record<string, unknown> = {},
  db: Db = getPool(),
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        actor === "system" ? null : actor.id,
        actor === "system" ? "system" : actor.name,
        action,
        JSON.stringify(detail),
      ],
    );
  } catch (error) {
    // The log must never break the action it records.
    logger.error("audit write failed", { action, error });
  }
}

export interface AuditRow {
  id: string;
  ts: string;
  actorName: string | null;
  action: string;
  detail: Record<string, unknown>;
}

/** Newest first; `before` (an id) pages older entries. */
export async function listAuditLog(
  opts: { limit?: number; before?: string | null } = {},
  db: Db = getPool(),
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const params: unknown[] = [limit];
  let where = "";
  if (opts.before) {
    params.push(opts.before);
    where = "WHERE id < $2";
  }
  const { rows } = await db.query(
    `SELECT id::text, ts, actor_name, action, detail
     FROM audit_log ${where}
     ORDER BY id DESC LIMIT $1`,
    params,
  );
  return rows.map((r) => ({
    id: r.id as string,
    ts: (r.ts as Date).toISOString(),
    actorName: r.actor_name as string | null,
    action: r.action as string,
    detail: r.detail as Record<string, unknown>,
  }));
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The export (spec 11: "exportable") - the whole log, oldest first. */
export async function auditLogCsv(db: Db = getPool()): Promise<string> {
  const { rows } = await db.query(
    `SELECT id::text, ts, actor_name, action, detail
     FROM audit_log ORDER BY id ASC`,
  );
  const lines = ["id,ts,actor,action,detail"];
  for (const r of rows) {
    lines.push(
      [
        r.id as string,
        (r.ts as Date).toISOString(),
        csvCell((r.actor_name as string | null) ?? ""),
        csvCell(r.action as string),
        csvCell(JSON.stringify(r.detail)),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
