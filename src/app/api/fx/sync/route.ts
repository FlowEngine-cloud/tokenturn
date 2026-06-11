import { conflict, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { syncFxRates } from "@/lib/fx";

export const dynamic = "force-dynamic";

/** Fetch ECB rates now (admin). Runs inline and returns the run's outcome. */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const result = await syncFxRates({ pool: db });
  if (result.skipped) return conflict("an FX sync is already running");
  return Response.json({
    run: {
      id: result.runId,
      status: result.status,
      rowsSynced: result.rowsSynced ?? null,
      latestDay: result.latestDay ?? null,
      error: result.error ?? null,
    },
  });
}
