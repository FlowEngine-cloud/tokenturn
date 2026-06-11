import { getOktaConfig, oktaTick } from "@ee/lib/okta";
import { requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

/** Run the Okta tick now (roster + auto-invite + leaver poll), admin. */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("okta_sync", db);
  if (locked) return locked;
  if ((await getOktaConfig({ db })) === null) {
    return Response.json({ error: "Okta is not connected" }, { status: 404 });
  }
  const result = await oktaTick({ db, force: true });
  return Response.json(result);
}
