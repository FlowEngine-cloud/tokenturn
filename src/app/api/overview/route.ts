import { badRequest, requireUser } from "@/lib/api";
import { allConnectorHealth } from "@/lib/connectors";
import { getPool } from "@/lib/db";
import { overviewData } from "@/lib/overview";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Overview (spec 10 page 1): totals with the estimated/invoiced split and
 * invoice drift, attribution coverage, trend, by vendor, top people, top
 * products - all from the daily rollups - plus connector health. Every
 * number here has a drill route (/api/facts, /api/runs, /api/invoices)
 * that sums to it from raw rows.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const range = { ...defaultRange() };
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!DAY_RE.test(value)) return badRequest(`${key} must be YYYY-MM-DD`);
    range[key] = value;
  }
  if (range.from > range.to) {
    return badRequest(`from ${range.from} is after to ${range.to}`);
  }

  try {
    const data = await overviewData(range, db);
    return Response.json({ ...data, connectors: await allConnectorHealth(db) });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
