import { badRequest, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { invoiceDrift } from "@/lib/invoices";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Imported invoices with their drift against the synced facts - the rows
 * behind Overview's estimated/invoiced reconciliation. ?from/?to bound the
 * months (YYYY-MM, inclusive).
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const range: { from?: string; to?: string } = {};
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!MONTH_RE.test(value)) return badRequest(`${key} must be YYYY-MM`);
    range[key] = value;
  }

  try {
    return Response.json(await invoiceDrift(range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
