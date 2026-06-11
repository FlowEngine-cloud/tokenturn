import { requireAdmin } from "@/lib/api";
import { auditLogCsv, listAuditLog } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

/**
 * The audit log viewer + export (spec 11, enterprise). Admin-only and
 * license-gated: without the `audit_log` feature this answers 403 with the
 * locked-feature line. Recording (src/lib/audit.ts) is always on.
 *
 * `?format=csv` downloads the whole log; otherwise JSON pages newest-first
 * (`?limit=`, `?before=<id>`).
 */
export async function GET(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("audit_log", db);
  if (locked) return locked;

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    return new Response(await auditLogCsv(db), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="audit-log.csv"',
      },
    });
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const before = url.searchParams.get("before");
  const entries = await listAuditLog(
    {
      limit: Number.isInteger(limitRaw) ? limitRaw : 100,
      before: before && /^\d+$/.test(before) ? before : null,
    },
    db,
  );
  return Response.json({ entries });
}
