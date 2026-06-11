import { badRequest, cleanName, cleanPassword, conflict, readJson, tooManyRequests } from "@/lib/api";
import { createSession, isClaimed, jsonWithSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/lib/password";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** First boot, password fallback: claim the instance as the one admin. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "claim"))) return tooManyRequests();
  const pool = getPool();
  if (await isClaimed(pool)) return conflict("instance already claimed");

  const body = await readJson(req);
  const name = cleanName(body?.name);
  const password = cleanPassword(body?.password);
  if (!name) return badRequest("name required (1-80 characters)");
  if (!password) return badRequest("password required (8-200 characters)");

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (name, role, password_hash)
       VALUES ($1, 'admin', $2) RETURNING id, name, role`,
      [name, passwordHash],
    );
    const user = rows[0];
    const session = await createSession(user.id, client);
    await client.query("COMMIT");
    logger.info("instance claimed", { userId: user.id, method: "password" });
    return jsonWithSession(req, { user }, session);
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      return conflict("instance already claimed");
    }
    throw error;
  } finally {
    client.release();
  }
}
