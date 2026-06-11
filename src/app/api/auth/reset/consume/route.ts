import { badRequest, readJson, tooManyRequests } from "@/lib/api";
import {
  createSession,
  destroyUserSessions,
  hashToken,
  jsonWithSession,
} from "@/lib/auth";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Consume a one-time reset link minted by the reset-admin CLI (spec 12b).
 * Single use, 30-minute expiry. On success every existing session for the
 * admin is revoked and a fresh one is issued so new credentials can be set.
 */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "reset"))) return tooManyRequests();
  const db = getPool();

  const body = await readJson(req);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token) return badRequest("token required");

  const { rows } = await db.query(
    `UPDATE reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token)],
  );
  if (rows.length === 0) return badRequest("reset link is invalid, expired or already used");

  const userId = rows[0].user_id as string;
  await destroyUserSessions(userId, db);
  const session = await createSession(userId, db);
  const { rows: users } = await db.query(
    "SELECT id, name, role FROM users WHERE id = $1",
    [userId],
  );
  logger.info("admin reset link consumed", { userId });
  return jsonWithSession(req, { user: users[0] }, session);
}
