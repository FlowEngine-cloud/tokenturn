import { badRequest, cleanUuid, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { ResolveError } from "@/lib/resolve";
import { cleanTag, tagDetail, updateTag, type TagUpdate } from "@/lib/tags";

export const dynamic = "force-dynamic";

/** One tag: its settings, the keys carrying it, and the vendor rows behind it. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ tag: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const tag = cleanTag((await params).tag);
  if (!tag) return badRequest("invalid tag");

  try {
    return Response.json(await tagDetail(tag, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Change a tag's settings (spec 7b): toggle counts-toward-personal-usage,
 * point it at a product (routing every key carrying it, full history
 * included), or un-point it (productId null).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tag: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const tag = cleanTag((await params).tag);
  if (!tag) return badRequest("invalid tag");

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  const update: TagUpdate = {};
  if (body.countsPersonal !== undefined) {
    if (typeof body.countsPersonal !== "boolean") {
      return badRequest("countsPersonal must be a boolean");
    }
    update.countsPersonal = body.countsPersonal;
  }
  if (body.productId !== undefined) {
    if (body.productId === null) {
      update.productId = null;
    } else {
      const productId = cleanUuid(body.productId);
      if (!productId) return badRequest("invalid productId");
      update.productId = productId;
    }
  }

  try {
    return Response.json(await updateTag(tag, update, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
