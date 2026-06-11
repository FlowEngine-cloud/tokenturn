import { conflict, requireAdmin } from "@/lib/api";
import { getConnector, runSync } from "@/lib/connectors";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Sync now (admin only). Runs inline and returns the run's outcome. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ vendor: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { vendor } = await params;
  if (!getConnector(vendor)) {
    return Response.json({ error: "no such connector" }, { status: 404 });
  }

  let result;
  try {
    result = await runSync(vendor, { pool: db });
  } catch (error) {
    // Not connected / no config - a caller mistake, not a vendor error.
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 409 });
  }
  if (result.skipped) return conflict("a sync is already running");

  return Response.json({
    run: {
      id: result.runId,
      status: result.status,
      window: result.window,
      rowsSynced: result.rowsSynced,
      error: result.error ?? null,
    },
  });
}
