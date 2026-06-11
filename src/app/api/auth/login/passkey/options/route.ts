import { conflict } from "@/lib/api";
import { isClaimed } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { authenticationOptions, rpFromRequest } from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Passkey sign-in, step 1: a one-time challenge. Usernameless. */
export async function POST(req: Request) {
  const db = getPool();
  if (!(await isClaimed(db))) return conflict("instance not claimed yet");
  const { challengeId, options } = await authenticationOptions(
    rpFromRequest(req),
    db,
  );
  return Response.json({ challengeId, options });
}
