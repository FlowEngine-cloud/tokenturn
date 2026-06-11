import { createHash, randomBytes } from "node:crypto";
import { getPool, type Db } from "./db";

/**
 * Sessions and the auth model (spec 11 + 12b):
 * - exactly one admin (claimed by the first visitor), plus view-only users
 * - the session cookie holds a random token; the DB stores only its sha256
 * - no email anywhere in login - the identifier is the username
 */

export const SESSION_COOKIE = "ai_pnl_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type Role = "admin" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** True once an admin exists; until then the instance is unclaimed. */
export async function isClaimed(db: Db = getPool()): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1",
  );
  return rows.length > 0;
}

/**
 * Serialize the first-boot claim. The one-admin unique index used to break
 * the double-claim race at the DB level; it is gone since migration 013
 * (more admins is a licensed feature, spec 11), so the claim transaction
 * takes this advisory lock and re-checks - the race loser sees the winner's
 * committed admin and gets the 409. Call inside an open transaction; the
 * lock releases on commit/rollback. Returns false when already claimed.
 */
const CLAIM_LOCK_KEY = 0x61_69_70_6e; // "aipn", arbitrary app-wide constant
export async function lockClaim(client: Db): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK_KEY]);
  return !(await isClaimed(client));
}

export async function createSession(
  userId: string,
  db: Db = getPool(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export async function getSessionUser(
  token: string,
  db: Db = getPool(),
): Promise<SessionUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows.length > 0 ? (rows[0] as SessionUser) : null;
}

export async function destroySession(
  token: string,
  db: Db = getPool(),
): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [
    hashToken(token),
  ]);
}

/** Revoke every session a user holds (reset flow, viewer removal). */
export async function destroyUserSessions(
  userId: string,
  db: Db = getPool(),
): Promise<void> {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

// ---- request plumbing (plain Request/Response - no next/headers, so the
// same code runs in route handlers, the proxy, and node tests) ----

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function sessionTokenFromRequest(req: Request): string | null {
  return parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ?? null;
}

export async function userFromRequest(
  req: Request,
  db: Db = getPool(),
): Promise<SessionUser | null> {
  const token = sessionTokenFromRequest(req);
  return token ? getSessionUser(token, db) : null;
}

/** TLS is the reverse proxy's job (spec 12b); Secure follows the proxy. */
export function requestIsSecure(req: Request): boolean {
  const fwd = req.headers.get("x-forwarded-proto");
  if (fwd) return fwd.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

export function sessionCookie(
  token: string,
  expiresAt: Date,
  secure: boolean,
): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", new Date(0), secure);
}

/** JSON response that also signs the caller in. */
export function jsonWithSession(
  req: Request,
  body: unknown,
  session: { token: string; expiresAt: Date },
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Set-Cookie": sessionCookie(
        session.token,
        session.expiresAt,
        requestIsSecure(req),
      ),
    },
  });
}
