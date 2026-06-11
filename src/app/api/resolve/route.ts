import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { resolveQueue } from "@/lib/resolve";
import { tagConflicts } from "@/lib/tags";

export const dynamic = "force-dynamic";

/**
 * The Resolve queue (spec 5): identities auto-match could not place, each
 * with suggested matches - plus the visible per-vendor Unassigned buckets
 * and the tag conflicts (a key whose tags point at two products, spec 7b).
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const [queue, conflicts] = await Promise.all([resolveQueue(db), tagConflicts(db)]);
  return Response.json({ ...queue, conflicts });
}
