import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { versionInfo } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * The version banner's source (spec 12b). With `update_check_enabled` off
 * (the default) this answers from local data alone - no request leaves the
 * machine; on, the server checks GitHub releases (cached six hours).
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json(await versionInfo({ db }));
}
