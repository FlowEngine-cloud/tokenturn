import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { reportData } from "@/lib/report";
import { ResolveError } from "@/lib/resolve";
import { readMonth } from "./params";

export const dynamic = "force-dynamic";

/**
 * The CFO report for one month (spec 10 page 6): spend by ROI and person -
 * archived rows and the no-ROI bucket included, so the page
 * sums to the whole ledger - unit costs, ROI where defined, and the
 * trailing month-over-month trend.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const month = readMonth(req);
  if (month instanceof Response) return month;

  try {
    return Response.json(await reportData(month, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
