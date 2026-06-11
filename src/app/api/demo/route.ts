import { requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { seedDemoData } from "@/lib/demo";
import { getOnboardingStage, onboardingState, setOnboardingStage } from "@/lib/onboarding";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Seed the demo dataset (admin, spec 10 Onboarding): ~6 months of realistic
 * people, keys, tags, products, daily spend and outcomes so every page
 * looks alive. Wiped automatically when the first real connector connects.
 * Refuses when demo data already exists or a vendor is already connected.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  try {
    const summary = await seedDemoData(db);
    if ((await getOnboardingStage(db)) === "welcome") {
      await setOnboardingStage("setup", db);
    }
    return Response.json(
      { demo: summary, onboarding: await onboardingState(db) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
