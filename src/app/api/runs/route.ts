import { badRequest, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { listSyncRuns, RUNS_MAX, VENDOR_RE } from "@/lib/overview";

export const dynamic = "force-dynamic";

/**
 * Sync-run history - the rows behind the connector-health tile: every run
 * with its status, row count, and the vendor's error verbatim (spec 5).
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const opts: { vendor?: string; limit?: number } = {};
  const vendor = params.get("vendor");
  if (vendor !== null) {
    if (!VENDOR_RE.test(vendor)) return badRequest("bad vendor");
    opts.vendor = vendor;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > RUNS_MAX) {
      return badRequest(`limit must be 1..${RUNS_MAX}`);
    }
    opts.limit = n;
  }

  return Response.json({ runs: await listSyncRuns(opts, db) });
}
