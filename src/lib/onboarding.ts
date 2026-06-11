import { getPool, type Db } from "./db";
import { demoMarker } from "./demo";

/**
 * Onboarding state (spec 10, Onboarding). The stage lives in the settings
 * table like all config:
 *
 * - 'welcome': the admin just claimed a fresh instance - the one popup
 *   (import employees vs demo data) is up.
 * - 'setup': the popup was answered - the one-screen three steps (connect a
 *   vendor, upload the people CSV, name a product) with live backfill
 *   progress.
 * - 'done': the Overview is the Overview. No settings row = 'done', so
 *   existing instances upgraded into this feature never see onboarding.
 *
 * The stage is set to 'welcome' at claim time only when the ledger is
 * completely empty - a claim against a database that already has data goes
 * straight to the dashboard.
 */

export const ONBOARDING_KEY = "onboarding_stage";

export const ONBOARDING_STAGES = ["welcome", "setup", "done"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export function isOnboardingStage(v: unknown): v is OnboardingStage {
  return typeof v === "string" && (ONBOARDING_STAGES as readonly string[]).includes(v);
}

/** Forward-only: the popup never comes back once answered. */
const TRANSITIONS: Record<OnboardingStage, OnboardingStage[]> = {
  welcome: ["setup", "done"],
  setup: ["done"],
  done: [],
};

export function canTransition(from: OnboardingStage, to: OnboardingStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export async function getOnboardingStage(db: Db = getPool()): Promise<OnboardingStage> {
  const { rows } = await db.query(
    "SELECT value FROM settings WHERE key = $1 AND secret = false",
    [ONBOARDING_KEY],
  );
  const value = rows[0]?.value;
  return isOnboardingStage(value) ? value : "done";
}

export async function setOnboardingStage(
  stage: OnboardingStage,
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, secret) VALUES ($1, $2::jsonb, false)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, secret = false, updated_at = now()`,
    [ONBOARDING_KEY, JSON.stringify(stage)],
  );
}

/**
 * Called when the first admin claims the instance (both claim paths). A
 * completely empty ledger starts onboarding; anything pre-existing skips it.
 */
export async function startOnboarding(db: Db = getPool()): Promise<void> {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM people)
          + (SELECT count(*) FROM products)
          + (SELECT count(*) FROM spend_facts)
          + (SELECT count(*) FROM connectors) AS n`,
  );
  if (Number(rows[0].n) === 0) {
    await setOnboardingStage("welcome", db);
  }
}

export interface OnboardingState {
  stage: OnboardingStage;
  demo: { present: boolean; seededAt: string | null };
  /** Real (non-demo) progress behind the three setup steps. */
  progress: { connectors: number; people: number; products: number };
}

export async function onboardingState(db: Db = getPool()): Promise<OnboardingState> {
  const [stage, marker] = await Promise.all([getOnboardingStage(db), demoMarker(db)]);
  const demoPeople = marker?.peopleIds ?? [];
  const demoProducts = marker?.productIds ?? [];
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM connectors)::int AS connectors,
       (SELECT count(*) FROM people
        WHERE merged_into IS NULL AND NOT (id = ANY($1::uuid[])))::int AS people,
       (SELECT count(*) FROM products
        WHERE archived_at IS NULL AND NOT (id = ANY($2::uuid[])))::int AS products`,
    [demoPeople, demoProducts],
  );
  return {
    stage,
    demo: { present: marker !== null, seededAt: marker?.seededAt ?? null },
    progress: {
      connectors: rows[0].connectors,
      people: rows[0].people,
      products: rows[0].products,
    },
  };
}
