import { badRequest, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { importInvoices, parseInvoiceCsv } from "@/lib/invoices";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Monthly invoice CSV import (admin, spec 4). Body = the CSV text; columns
 * vendor, month (YYYY-MM), amount, currency (+ optional invoice ref, note;
 * headers auto-detect). ?preview=1 validates and returns per-row results
 * without committing. A commit is all-or-nothing: any row error rejects the
 * whole file, with every row's verdict in the response.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const text = await req.text();
  if (!text.trim()) return badRequest("the CSV is empty");
  const preview = new URL(req.url).searchParams.get("preview");

  try {
    const parsed = await parseInvoiceCsv(text, new Date(), db);
    if (preview === "1" || preview === "true") {
      return Response.json(parsed);
    }
    if (!parsed.ok) {
      return Response.json(
        { error: "no rows imported - fix the rows below and retry", rows: parsed.rows },
        { status: 400 },
      );
    }
    return Response.json(await importInvoices(parsed.rows, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
