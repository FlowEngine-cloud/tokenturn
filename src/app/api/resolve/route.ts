import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { resolveQueue } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * The Resolve queue (spec 5): identities auto-match could not place, each
 * with suggested matches - plus the visible per-vendor Unassigned buckets.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  return Response.json(await resolveQueue(db));
}
