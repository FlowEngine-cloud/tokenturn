import { getGoogleConfig, googleTick } from "@ee/lib/google";
import { requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

/** Run the Google Workspace roster sync now, admin. */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("google_workspace", db);
  if (locked) return locked;
  if ((await getGoogleConfig({ db })) === null) {
    return Response.json({ error: "Google Workspace is not connected" }, { status: 404 });
  }
  const result = await googleTick({ db, force: true });
  return Response.json(result);
}
