import { badRequest, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  canTransition,
  getOnboardingStage,
  isOnboardingStage,
  onboardingState,
  setOnboardingStage,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/** Onboarding state (spec 10): the stage, demo-data presence, and the real
 * (non-demo) progress behind the three setup steps. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json(await onboardingState(db));
}

/** Advance the stage (admin). Forward-only: welcome -> setup -> done. */
export async function PATCH(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  const stage = body?.stage;
  if (!isOnboardingStage(stage)) {
    return badRequest("stage must be one of welcome, setup, done");
  }
  const current = await getOnboardingStage(db);
  if (stage !== current && !canTransition(current, stage)) {
    return Response.json(
      { error: `cannot move onboarding from ${current} to ${stage}` },
      { status: 409 },
    );
  }
  if (stage !== current) await setOnboardingStage(stage, db);
  return Response.json(await onboardingState(db));
}
