import { badRequest, cleanUuid, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { keyDetail } from "@/lib/people";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * One vendor identity - key, seat, or user (spec 10 page 2 key
 * click-through): its tags say what it's for and where it's plugged;
 * owner, product routing, models, last used. All-time, from the key's own
 * raw facts - the same rows /drill?key= lists.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid key id");

  try {
    return Response.json(await keyDetail(id, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
