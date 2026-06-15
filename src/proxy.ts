import { NextResponse, type NextRequest } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { isDemoMode } from "@/lib/demo";

/**
 * Auth gate (spec 11 + 12b). Every request needs a valid session except
 * /healthz, the ingest API (its auth is per-product ingest keys), and the
 * login/claim/reset endpoints themselves. Runs on the Node runtime, so the
 * session is validated against the database - not just cookie presence.
 *
 * View-only users are enforced here too: viewers can only read, plus manage
 * their own credentials. Demo mode (env DEMO_MODE=1) is the same idea for
 * the whole instance: everyone reads, nobody writes - see isDemoMode().
 */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Writes that stay open in demo mode: getting in and out of the shared
 * account, and the self-disabling bootstrap calls - claim (refuses once
 * claimed), the demo seed (refuses once data exists) and the forward-only
 * onboarding stage - so a fresh demo box can finish onboarding while
 * already read-only. Credential changes (password, passkeys, reset links)
 * are NOT here on purpose: the demo account is shared, a visitor must not
 * be able to lock the owner out. Ingest writes are blocked too.
 */
function demoWriteAllowed(pathname: string): boolean {
  return (
    pathname === "/api/auth/logout" ||
    pathname.startsWith("/api/auth/login/") ||
    pathname.startsWith("/api/auth/setup/") ||
    pathname === "/api/demo" ||
    pathname === "/api/onboarding"
  );
}

/** Self-service auth endpoints a viewer may write to. */
const VIEWER_WRITE_ALLOWED = new Set([
  "/api/auth/logout",
  "/api/auth/password",
  "/api/auth/passkey/options",
  "/api/auth/passkey/verify",
  "/api/api-keys",
]);

function viewerWriteAllowed(pathname: string): boolean {
  return (
    VIEWER_WRITE_ALLOWED.has(pathname) ||
    /^\/api\/api-keys\/[0-9a-f-]{36}$/i.test(pathname)
  );
}

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

  // Demo mode gates writes before the public-path bypass, so the public
  // ingest API and reset consumption are read-only too.
  if (isDemoMode() && !READ_METHODS.has(req.method) && !demoWriteAllowed(pathname)) {
    return Response.json({ error: "demo mode: this instance is read-only" }, { status: 403 });
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  const user = await userFromRequest(req, getPool());

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
    !viewerWriteAllowed(pathname)
  ) {
    return Response.json({ error: "view-only user" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
