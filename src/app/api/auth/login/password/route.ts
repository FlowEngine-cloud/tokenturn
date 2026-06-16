import { badRequest, readJson, tooManyRequests, unauthorized } from "@/lib/api";
import { createSession, jsonWithSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DEMO_LOGIN_NAME, DEMO_LOGIN_PASSWORD, isDemoMode } from "@/lib/demo";
import { logger } from "@/lib/logger";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Username + password sign-in. No email anywhere in login (spec 12b). */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "login"))) return tooManyRequests();
  const db = getPool();

  const body = await readJson(req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!name || !password) return badRequest("name and password required");

  if (
    isDemoMode() &&
    name.toLowerCase() === DEMO_LOGIN_NAME &&
    password === DEMO_LOGIN_PASSWORD
  ) {
    const { rows } = await db.query(
      `INSERT INTO users (name, role)
       VALUES ($1, 'admin')
       ON CONFLICT (lower(name))
       DO UPDATE SET role = 'admin', updated_at = now()
       RETURNING id, name, role`,
      [DEMO_LOGIN_NAME],
    );
    const user = rows[0];
    const session = await createSession(user.id, db);
    logger.info("login", { userId: user.id, method: "demo" });
    return jsonWithSession(
      req,
      { user: { id: user.id, name: user.name, role: user.role } },
      session,
    );
  }

  const { rows } = await db.query(
    `SELECT id, name, role, password_hash FROM users WHERE lower(name) = lower($1)`,
    [name],
  );
  const user = rows[0];

  if (!user?.password_hash) {
    // Burn comparable time for unknown users so timing doesn't leak names.
    await hashPassword(password);
    return unauthorized("wrong name or password");
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return unauthorized("wrong name or password");
  }

  const session = await createSession(user.id, db);
  logger.info("login", { userId: user.id, method: "password" });
  return jsonWithSession(
    req,
    { user: { id: user.id, name: user.name, role: user.role } },
    session,
  );
}
