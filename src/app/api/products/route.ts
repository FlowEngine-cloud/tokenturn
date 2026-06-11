import { badRequest, cleanName, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  createProduct,
  isAttribution,
  isOutcomeKind,
  listProducts,
  parseDefaultValue,
} from "@/lib/products";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/** List products. Archived ones leave current views: ask with ?archived=1. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const archived = new URL(req.url).searchParams.get("archived");
  const includeArchived = archived === "1" || archived === "true";
  return Response.json({ products: await listProducts({ includeArchived }, db) });
}

/** Create a product row = a user-defined ROI (admin, spec 7). */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");
  const name = cleanName(body.name);
  if (!name) return badRequest("name required (1-80 characters)");
  if (!isAttribution(body.attribution)) {
    return badRequest("attribution must be one of connector, key, sdk, manual");
  }
  if (body.outcomeKind !== undefined && !isOutcomeKind(body.outcomeKind)) {
    return badRequest("outcomeKind must be one of none, github_pr, jira_issue, linear_issue, sdk_event, manual");
  }

  try {
    const product = await createProduct(
      {
        name,
        attribution: body.attribution,
        outcomeKind: isOutcomeKind(body.outcomeKind) ? body.outcomeKind : undefined,
        defaultValue: parseDefaultValue(body) ?? null,
      },
      db,
    );
    return Response.json({ product }, { status: 201 });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
