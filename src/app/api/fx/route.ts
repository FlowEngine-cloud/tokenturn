import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { fxStatus } from "@/lib/fx";

export const dynamic = "force-dynamic";

/** FX health: latest rate day, currency coverage, last ECB run. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json({ fx: await fxStatus(db) });
}
