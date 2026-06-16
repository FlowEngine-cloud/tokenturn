import { badRequest, cleanUuid, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { FACT_PAGE_MAX, listFacts, VENDOR_RE, type FactFilters } from "@/lib/overview";
import { DAY_RE } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * The drill-down rows behind every spend number (spec 3: every displayed
 * number drills to the vendor rows behind it). Raw spend_facts, filtered the
 * same way the tile was aggregated; totals cover the whole filter so the
 * drill page can prove it sums to the tile.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const filters: FactFilters = {};

  for (const key of ["from", "to", "day"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!DAY_RE.test(value)) return badRequest(`${key} must be YYYY-MM-DD`);
    filters[key] = value;
  }
  const vendor = params.get("vendor");
  if (vendor !== null) {
    if (!VENDOR_RE.test(vendor)) return badRequest("bad vendor");
    filters.vendor = vendor;
  }
  const person = params.get("person");
  if (person !== null) {
    if (person !== "unassigned" && cleanUuid(person) === null) {
      return badRequest('person must be a uuid or "unassigned"');
    }
    filters.person = person === "unassigned" ? person : cleanUuid(person)!;
  }
  const product = params.get("product");
  if (product !== null) {
    if (product !== "none" && cleanUuid(product) === null) {
      return badRequest('product must be a uuid or "none"');
    }
    filters.product = product === "none" ? product : cleanUuid(product)!;
  }
  const identity = params.get("key");
  if (identity !== null) {
    if (cleanUuid(identity) === null) return badRequest("key must be a uuid");
    filters.key = cleanUuid(identity)!;
  }
  const model = params.get("model");
  if (model !== null) {
    if (model.length < 1 || model.length > 200) return badRequest("bad model");
    filters.model = model;
  }
  const basis = params.get("basis");
  if (basis !== null) {
    if (basis !== "estimated" && basis !== "invoiced") {
      return badRequest("basis must be estimated or invoiced");
    }
    filters.basis = basis;
  }
  const billingMode = params.get("billingMode");
  if (billingMode !== null) {
    if (billingMode !== "subscription" && billingMode !== "metered") {
      return badRequest("billingMode must be subscription or metered");
    }
    filters.billingMode = billingMode;
  }
  for (const key of ["limit", "offset"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < (key === "limit" ? 1 : 0)) {
      return badRequest(`bad ${key}`);
    }
    if (key === "limit" && n > FACT_PAGE_MAX) {
      return badRequest(`limit is capped at ${FACT_PAGE_MAX}`);
    }
    filters[key] = n;
  }

  try {
    return Response.json(await listFacts(filters, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
