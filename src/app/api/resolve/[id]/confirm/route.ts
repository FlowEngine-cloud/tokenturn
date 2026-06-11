import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { confirmMatch, ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * One-click confirm (spec 5): this identity is this person. Re-attributes
 * the identity's full history and remembers the match forever.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const identityId = cleanUuid((await params).id);
  if (!identityId) return badRequest("invalid identity id");
  const personId = cleanUuid((await readJson(req))?.personId);
  if (!personId) return badRequest("personId required");

  try {
    return Response.json(await confirmMatch(identityId, personId, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
