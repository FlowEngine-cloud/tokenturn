import { userFromRequest, type SessionUser } from "./auth";
import { getPool, type Db } from "./db";

/** Shared plumbing for JSON route handlers. */

export function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

export function unauthorized(error = "unauthorized"): Response {
  return Response.json({ error }, { status: 401 });
}

export function forbidden(error = "forbidden"): Response {
  return Response.json({ error }, { status: 403 });
}

export function conflict(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

export function tooManyRequests(): Response {
  return Response.json({ error: "too many attempts, retry in a minute" }, { status: 429 });
}

export async function readJson(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Login identifier / display name: trimmed, 1-80 chars. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

export function cleanPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length >= 8 && value.length <= 200 ? value : null;
}

export async function requireUser(
  req: Request,
  db: Db = getPool(),
): Promise<SessionUser | Response> {
  const user = await userFromRequest(req, db);
  return user ?? unauthorized();
}

export async function requireAdmin(
  req: Request,
  db: Db = getPool(),
): Promise<SessionUser | Response> {
  const user = await userFromRequest(req, db);
  if (!user) return unauthorized();
  return user.role === "admin" ? user : forbidden("admin only");
}
