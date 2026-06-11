import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { listLimitStatus } from "@/lib/limits";

export const dynamic = "force-dynamic";

/**
 * Limits surface (spec 9): every active person with our monthly limit,
 * month-to-date (UTC calendar month) spend, thresholds already alerted
 * this month, and the vendor's own limit next to ours where the vendor
 * reports one - plus what each vendor can actually enforce, verbatim.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json(await listLimitStatus(db));
}
