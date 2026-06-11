import { requireAdmin, requireUser } from "@/lib/api";
import { connectorHealth, disconnectConnector, getConnector } from "@/lib/connectors";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Health for one connector. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ vendor: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const { vendor } = await params;
  const health = await connectorHealth(vendor, db);
  if (!health) {
    return Response.json({ error: "no such connector" }, { status: 404 });
  }
  return Response.json({ connector: health });
}

/**
 * Disconnect (admin only): forget the credentials, stop syncing. Synced
 * history stays - nothing hard-deletes (spec 4).
 */
export async function DELETE(
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
  const removed = await disconnectConnector(vendor, { db });
  if (!removed) {
    return Response.json({ error: "not connected" }, { status: 404 });
  }
  logger.info("connector disconnected via api", { connector: vendor, by: admin.id });
  return Response.json({ ok: true });
}
