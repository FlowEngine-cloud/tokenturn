import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { revokeIngestKey } from "@/lib/ingest";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/** Revoke an ingest key (admin). Revocation is permanent - the SDK's next
 * flush gets 401 - and the key row stays: history never loses its source. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await ctx.params).id);
  if (!id) return badRequest("id must be an ingest key UUID");
  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  if (body.revoked !== true) {
    return badRequest("revocation is permanent: pass {\"revoked\": true} (mint a new key instead of un-revoking)");
  }

  try {
    return Response.json({ key: await revokeIngestKey(id, db) });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
