import { cleanName, badRequest, readJson, requireUser } from "@/lib/api";
import { listApiKeys, mintApiKey } from "@/lib/auth";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** List the caller's personal API keys. Tokens are never returned. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json({ keys: await listApiKeys(user.id, db) });
}

/** Mint a personal API key. The plaintext token is returned exactly once. */
export async function POST(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  const name = cleanName(body.name);
  if (!name) return badRequest("name must be 1-80 characters");

  const { key, token } = await mintApiKey(user.id, name, db);
  return Response.json({ key, token }, { status: 201 });
}
