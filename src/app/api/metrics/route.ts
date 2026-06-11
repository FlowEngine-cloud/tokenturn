import { badRequest, cleanUuid, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { FACT_PAGE_MAX, listMetrics, VENDOR_RE, type MetricFilters } from "@/lib/overview";
import { DAY_RE } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

const METRIC_RE = /^[a-z0-9][a-z0-9_]*$/;

/**
 * The drill-down rows behind every counter-derived number (spec 3): raw
 * usage_metrics with their source_ref. Accept rates and vendor-estimated
 * costs sum to exactly these rows; ?metric= takes a comma-separated list so
 * a rate's two inputs land on one page.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const filters: MetricFilters = {};

  for (const key of ["from", "to"] as const) {
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
  const metric = params.get("metric");
  if (metric !== null) {
    const metrics = metric.split(",").map((m) => m.trim());
    if (metrics.length === 0 || metrics.some((m) => !METRIC_RE.test(m))) {
      return badRequest("metric must be a comma-separated list of counter names");
    }
    filters.metric = metrics;
  }
  const person = params.get("person");
  if (person !== null) {
    if (person !== "unassigned" && cleanUuid(person) === null) {
      return badRequest('person must be a uuid or "unassigned"');
    }
    filters.person = person === "unassigned" ? person : cleanUuid(person)!;
  }
  const key = params.get("key");
  if (key !== null) {
    if (cleanUuid(key) === null) return badRequest("key must be a uuid");
    filters.key = cleanUuid(key)!;
  }
  for (const name of ["limit", "offset"] as const) {
    const value = params.get(name);
    if (value === null) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < (name === "limit" ? 1 : 0)) {
      return badRequest(`bad ${name}`);
    }
    if (name === "limit" && n > FACT_PAGE_MAX) {
      return badRequest(`limit is capped at ${FACT_PAGE_MAX}`);
    }
    filters[name] = n;
  }

  try {
    return Response.json(await listMetrics(filters, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
