import { badRequest, cleanName, cleanUuid, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  cleanDay,
  isAttribution,
  isOutcomeKind,
  parseDefaultValue,
  productDetail,
  updateProduct,
  type DayRange,
  type ProductUpdate,
} from "@/lib/products";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD - the selected range; absent = all time. */
function readRange(req: Request): DayRange | Response {
  const params = new URL(req.url).searchParams;
  const range: DayRange = {};
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const day = cleanDay(raw);
    if (!day) return badRequest(`${key} must be YYYY-MM-DD`);
    range[key] = day;
  }
  if (range.from && range.to && range.from > range.to) {
    return badRequest("from is after to");
  }
  return range;
}

/**
 * One product: spend, outcomes, unit cost, value and ROI over the selected
 * range - with the raw rows behind every number (facts, outcomes, manual
 * entries). Archived products stay fully readable.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid product id");
  const range = readRange(req);
  if (range instanceof Response) return range;

  try {
    return Response.json(await productDetail(id, range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Change a product (admin): rename, re-describe its attribution or outcome
 * kind, set or clear the default value per outcome, archive or restore.
 * Archive is the only exit - products never hard-delete (spec 4).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid product id");
  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");

  const update: ProductUpdate = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return badRequest("name must be 1-80 characters");
    update.name = name;
  }
  if (body.attribution !== undefined) {
    if (!isAttribution(body.attribution)) {
      return badRequest("attribution must be one of connector, key, sdk, manual");
    }
    update.attribution = body.attribution;
  }
  if (body.outcomeKind !== undefined) {
    if (!isOutcomeKind(body.outcomeKind)) {
      return badRequest("outcomeKind must be one of none, github_pr, sdk_event, manual");
    }
    update.outcomeKind = body.outcomeKind;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return badRequest("archived must be a boolean");
    }
    update.archived = body.archived;
  }

  try {
    const defaultValue = parseDefaultValue(body);
    if (defaultValue !== undefined) update.defaultValue = defaultValue;
    return Response.json({ product: await updateProduct(id, update, db) });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
