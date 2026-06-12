import { badRequest, cleanUuid, readJson, requireUser } from "@/lib/api";
import { revokeApiKey } from "@/lib/auth";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Revoke one of the caller's personal API keys. Revocation is permanent. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("id must be an API key UUID");
  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  if (body.revoked !== true) {
    return badRequest(
      'revocation is permanent: pass {"revoked": true} (mint a new key instead of un-revoking)',
    );
  }

  const key = await revokeApiKey(user.id, id, db);
  return key
    ? Response.json({ key })
    : Response.json({ error: "API key not found" }, { status: 404 });
}
