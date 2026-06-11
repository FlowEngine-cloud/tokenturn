import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { mergePeople, ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Two emails, one human (spec 5): merge one person into another. History
 * follows the surviving person, and the merged email is remembered forever.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  const fromPersonId = cleanUuid(body?.fromPersonId);
  const intoPersonId = cleanUuid(body?.intoPersonId);
  if (!fromPersonId || !intoPersonId) {
    return badRequest("fromPersonId and intoPersonId required");
  }

  try {
    return Response.json(await mergePeople(fromPersonId, intoPersonId, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
