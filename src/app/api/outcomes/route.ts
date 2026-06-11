import { badRequest, cleanUuid, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { FACT_PAGE_MAX, listOutcomes, type OutcomeFilters } from "@/lib/overview";
import { DAY_RE } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * The drill-down rows behind every outcome count (spec 3: every displayed
 * number drills to the rows behind it). Raw outcomes with their source_ref
 * (PR URL, ticket id, manual entry id); totals cover the whole filter so
 * the live count provably matches the tile it was reached from.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const filters: OutcomeFilters = {};

  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!DAY_RE.test(value)) return badRequest(`${key} must be YYYY-MM-DD`);
    filters[key] = value;
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
    if (cleanUuid(product) === null) return badRequest("product must be a uuid");
    filters.product = cleanUuid(product)!;
  }
  const kind = params.get("kind");
  if (kind !== null) {
    if (kind.length < 1 || kind.length > 100) return badRequest("bad kind");
    filters.kind = kind;
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
    return Response.json(await listOutcomes(filters, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
