import { badRequest, cleanPassword, readJson, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

/** Set the signed-in user's password (fallback credential, reset flow). */
export async function POST(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  const password = cleanPassword(body?.password);
  if (!password) return badRequest("password required (8-200 characters)");

  await db.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [
    user.id,
    await hashPassword(password),
  ]);
  logger.info("password set", { userId: user.id });
  return Response.json({ ok: true });
}
