import { isClaimed, userFromRequest } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { isDemoMode } from "@/lib/demo";

export const dynamic = "force-dynamic";

/**
 * Auth state: whether the instance has been claimed by an admin, whether it
 * runs read-only in demo mode, and who the caller is. The login page uses
 * this to choose claim vs sign-in; the shell shows the demo banner from it.
 */
export async function GET(req: Request) {
  const db = getPool();
  const [claimed, user] = await Promise.all([
    isClaimed(db),
    userFromRequest(req, db),
  ]);
  return Response.json({
    claimed,
    demoMode: isDemoMode(),
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
  });
}
