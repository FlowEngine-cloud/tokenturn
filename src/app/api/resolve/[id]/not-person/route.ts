import { badRequest, cleanName, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { markNotPerson, ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Mark an identity "not a person" (spec 5): a service account. Routes its
 * spend - full history included - to a product and/or a tag instead.
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

  const body = await readJson(req);
  const productId = body?.productId === undefined ? null : cleanUuid(body.productId);
  if (body?.productId !== undefined && !productId) {
    return badRequest("invalid productId");
  }
  const tag = body?.tag === undefined ? null : cleanName(body.tag);
  if (body?.tag !== undefined && !tag) return badRequest("invalid tag");

  try {
    return Response.json(await markNotPerson(identityId, { productId, tag }, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
