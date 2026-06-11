import { requireUser } from "@/lib/api";
import { allConnectorHealth } from "@/lib/connectors";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Connector health surface (spec 5): every registered connector with its
 * connection state, last sync, row counts, and the vendor's error verbatim.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  return Response.json({ connectors: await allConnectorHealth(db) });
}
