import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { focusLines, FOCUS_VERSION } from "@/lib/report";
import { readMonth } from "../params";

export const dynamic = "force-dynamic";

/**
 * FOCUS 1.4 export (spec 10 page 6): one CSV row per raw spend fact in the
 * month, streamed - the export IS the drill-down, in the FinOps open
 * format any cost tool can ingest.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const month = readMonth(req);
  if (month instanceof Response) return month;

  const lines = focusLines(month, db);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(`${value}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void lines.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tokenturn-focus-${FOCUS_VERSION}-${month}.csv"`,
    },
  });
}
