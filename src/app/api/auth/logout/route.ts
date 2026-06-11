import {
  clearSessionCookie,
  destroySession,
  requestIsSecure,
  sessionTokenFromRequest,
} from "@/lib/auth";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = sessionTokenFromRequest(req);
  if (token) await destroySession(token, getPool());
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookie(requestIsSecure(req)) } },
  );
}
