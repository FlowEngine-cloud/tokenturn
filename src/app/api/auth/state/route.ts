import { isClaimed, userFromRequest } from "@/lib/auth";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Auth state: whether the instance has been claimed by an admin, and who the
 * caller is. The login page uses this to choose claim vs sign-in. Demo mode
 * has one source of truth - the server's isDemoMode() - read by the dashboard
 * layout (which feeds DemoProvider/useDemo so every write control disables)
 * and by the proxy (which rejects the writes); it is never re-exposed here.
 */
export async function GET(req: Request) {
  const db = getPool();
  const [claimed, user] = await Promise.all([
    isClaimed(db),
    userFromRequest(req, db),
  ]);
  return Response.json({
    claimed,
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
  });
}
