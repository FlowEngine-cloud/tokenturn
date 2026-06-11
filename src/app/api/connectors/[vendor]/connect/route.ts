import { badRequest, readJson, requireAdmin } from "@/lib/api";
import { connectConnector, getConnector, runSync } from "@/lib/connectors";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Connect a vendor (admin only). Validates token scopes first - a rejected
 * token stores nothing and the vendor's error comes back verbatim (422).
 * On success the full backfill starts immediately in the background; its
 * progress is visible on GET /api/connectors.
 */
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

  const body = await readJson(req);
  const config = body?.config;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.values(config).some((v) => typeof v !== "string")
  ) {
    return badRequest("config must be an object of strings");
  }

  let row;
  try {
    row = await connectConnector(vendor, config as Record<string, string>, { db });
  } catch (error) {
    // Scope/auth rejection: the vendor's error, verbatim (spec 5).
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 422 });
  }
  logger.info("connector connected via api", { connector: vendor, by: admin.id });

  // Kick off the first backfill; the caller polls health for progress.
  void runSync(vendor).catch((err) => {
    logger.error("initial backfill failed to start", { connector: vendor, error: err });
  });

  return Response.json(
    {
      connector: {
        vendor: row.vendor,
        connectedAt: row.connected_at,
        historyLimitDays: row.history_limit_days,
        scopes: row.scopes,
      },
    },
    { status: 201 },
  );
}
