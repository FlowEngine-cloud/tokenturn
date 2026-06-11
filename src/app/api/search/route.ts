import { badRequest, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { searchEverything } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** Cmd-K: search to any person, product, or vendor (spec 10). */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length === 0) return badRequest("q is required");
  if (q.length > 80) return badRequest("q is too long");

  return Response.json(await searchEverything(q, db));
}
