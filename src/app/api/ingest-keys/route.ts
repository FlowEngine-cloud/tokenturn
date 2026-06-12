import { badRequest, cleanName, cleanUuid, readJson, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { listIngestKeys, mintIngestKey } from "@/lib/ingest";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/** List ingest keys - prefixes only, never tokens (shown once at mint). */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json({ keys: await listIngestKeys(db) });
}

/** Mint an ingest key (any signed-in user, spec 6): scoped to one product, the plaintext
 * token is in this response and nowhere else - it is never stored. */
export async function POST(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  const productId = cleanUuid(body.productId);
  if (!productId) return badRequest("productId must be a product UUID");
  let name: string | null = null;
  if (body.name !== undefined && body.name !== null) {
    name = cleanName(body.name);
    if (!name) return badRequest("name must be 1-80 characters");
  }

  try {
    const { key, token } = await mintIngestKey(productId, name, db);
    return Response.json({ key, token }, { status: 201 });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
