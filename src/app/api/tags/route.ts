import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

/**
 * Every tag in use (key names become tags, spec 7b) with its
 * counts-toward-personal-usage toggle, product routing, and the keys and
 * spend behind it.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  return Response.json({ tags: await listTags(db) });
}
