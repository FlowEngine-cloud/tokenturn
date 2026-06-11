import { badRequest, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { addTag, cleanTag, listTags } from "@/lib/tags";

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

/**
 * Add a tag ahead of its keys (spec 7b): name a key with this tag in the
 * vendor console and its spend shows up under it on next sync. Idempotent.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  if (typeof body.tag !== "string") return badRequest("tag must be a string");
  const tag = cleanTag(body.tag);
  if (!tag) return badRequest("invalid tag");

  const result = await addTag(tag, db);
  return Response.json(result, { status: result.created ? 201 : 200 });
}
