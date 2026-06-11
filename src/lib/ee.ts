/**
 * Enterprise constants shared by server and client code (spec 11). This
 * module is dependency-free on purpose: the Settings UI imports it, so it
 * must never pull crypto or the database into the client bundle. The
 * license machinery itself lives in src/lib/license.ts.
 */

/** The one line every locked enterprise feature shows (spec 11). */
export const EE_LOCKED_COPY = "Enterprise feature - contact hi@flowengine.cloud";

/** Every enterprise feature key a license can grant (spec 11). */
export const EE_FEATURES = [
  "okta_sync",
  "google_workspace",
  "more_admins",
  "audit_log",
  "multi_org",
  "scheduled_reports",
] as const;
export type EeFeature = (typeof EE_FEATURES)[number];

export const EE_FEATURE_LABELS: Record<EeFeature, string> = {
  okta_sync: "Okta sync",
  google_workspace: "Google Workspace roster sync",
  more_admins: "More admins",
  audit_log: "Audit log",
  multi_org: "Multi-org rollup",
  scheduled_reports: "Scheduled reports",
};

export type LicenseState = "none" | "valid" | "expired";

export interface LicenseStatus {
  state: LicenseState;
  org: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /** The concrete features the license names (wildcard expanded). */
  features: EeFeature[];
}
