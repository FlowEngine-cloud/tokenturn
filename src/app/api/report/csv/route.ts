import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { reportCsv, reportData } from "@/lib/report";
import { ResolveError } from "@/lib/resolve";
import { readMonth } from "../params";

export const dynamic = "force-dynamic";

/** The report table as a CSV download - the same rows the page shows. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const month = readMonth(req);
  if (month instanceof Response) return month;

  try {
    const csv = reportCsv(await reportData(month, db));
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="tokenturn-report-${month}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
