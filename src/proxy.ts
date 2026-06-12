import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { getPool } from "@/lib/db";

/**
 * Auth gate (spec 11 + 12b). Every request needs a valid session except
 * /healthz, the ingest API (its auth is per-product ingest keys), and the
 * login/claim/reset endpoints themselves. Runs on the Node runtime, so the
 * session is validated against the database - not just cookie presence.
 *
 * View-only users are enforced here too: viewers can only read, plus manage
 * their own credentials.
 */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Self-service auth endpoints a viewer may write to. */
const VIEWER_WRITE_ALLOWED = new Set([
  "/api/auth/logout",
  "/api/auth/password",
  "/api/auth/passkey/options",
  "/api/auth/passkey/verify",
]);

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/login" ||
    // Brand assets: the logo and the generated icon route must load on
    // /login too, where there is no session yet.
    pathname === "/logo.svg" ||
    pathname === "/icon.png" ||
    pathname.startsWith("/reset/") ||
    pathname === "/api/ingest" ||
    pathname.startsWith("/api/ingest/") ||
    pathname === "/api/auth/state" ||
    pathname.startsWith("/api/auth/setup/") ||
    pathname.startsWith("/api/auth/login/") ||
    pathname === "/api/auth/reset/consume"
  );
}

export async function proxy(req: NextRequest): Promise<Response> {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = token ? await getSessionUser(token, getPool()) : null;

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (
    user.role === "viewer" &&
    !READ_METHODS.has(req.method) &&
    !VIEWER_WRITE_ALLOWED.has(pathname)
  ) {
    return Response.json({ error: "view-only user" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
