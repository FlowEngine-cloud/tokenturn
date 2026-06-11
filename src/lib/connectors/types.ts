import type { Logger } from "../logger";

/**
 * The connector contract (spec section 5). Every vendor connector implements
 * this interface; everything else - hourly scheduling, cursor storage,
 * backfill windows, resume after failure, idempotent upserts, the trailing
 * 7-day re-pull, health - is the framework's job (sync.ts), so vendor code
 * stays a thin "fetch + parse" layer that recorded-fixture tests can pin.
 */

export interface ConnectorContext {
  /**
   * Decrypted connector config (token etc.) from Settings. Shape is
   * vendor-specific; the framework treats it as opaque.
   */
  config: Record<string, string>;
  /** HTTP client. Injected so the fixture harness can replay recordings. */
  fetch: typeof fetch;
  log: Logger;
}

/** Inclusive UTC day window, YYYY-MM-DD. */
export interface SyncWindow {
  since: string;
  until: string;
}

/** A vendor identity (user, API key, seat) discovered during sync. */
export interface IdentityInput {
  externalId: string;
  kind: "user" | "api_key" | "seat";
  /** Vendor-side email, when the vendor knows it. Drives auto-match. */
  email?: string;
  /** Vendor-side display name (user name / key name). */
  displayName?: string;
  /** Key names become tags (spec 7b). */
  tags?: string[];
}

/** One spend row as the vendor reports it. */
export interface FactInput {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** The identity this spend belongs to; omitted = Unassigned. */
  identity?: { externalId: string; kind: IdentityInput["kind"] };
  model?: string;
  tokens?: number;
  amountCents: number;
  /** ISO-4217, uppercase. */
  currency: string;
  costBasis: "estimated" | "invoiced";
  /**
   * Points at the vendor record behind this number - what makes it
   * drillable. Must be unique per vendor record: (vendor, sourceRef) is the
   * upsert key, so re-pulls restate in place and never duplicate a row.
   */
  sourceRef: string;
}

/**
 * One vendor-reported usage counter that is NOT spend (Claude Code
 * sessions/commits/PRs/tool acceptances, ...). Kept out of spend_facts so
 * the ledger never double counts; rates are computed at display time from
 * the raw counters. (vendor, sourceRef, metric) is the upsert key.
 */
export interface MetricInput {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** The identity this counter belongs to; omitted = unattributed. */
  identity?: { externalId: string; kind: IdentityInput["kind"] };
  metric: string;
  /** Raw integer counter as the vendor reports it. */
  value: number;
  /** Points at the vendor record behind this counter (same rule as facts). */
  sourceRef: string;
}

/** One page of a sync. nextPageToken null = the window is complete. */
export interface ConnectorPage {
  identities: IdentityInput[];
  facts: FactInput[];
  /** Non-spend usage counters (optional - most connectors have none). */
  metrics?: MetricInput[];
  nextPageToken: string | null;
}

export interface ScopeCheck {
  /** Scopes the vendor reports for the token. Stored on the connectors row. */
  scopes: string[];
}

/** A credential field the connect screen collects (stored encrypted). */
export interface ConfigField {
  /** Key in the connector config object, e.g. "adminKey". */
  key: string;
  label: string;
  /** Render as a password input. */
  secret?: boolean;
}

export interface Connector {
  /** Stable id, e.g. "anthropic". Matches sync_runs.connector / facts.vendor. */
  vendor: string;
  displayName: string;
  /**
   * How far back the vendor lets us page (most cap report windows at ~31
   * days). First connect backfills exactly this far; the connect screen
   * shows it.
   */
  historyLimitDays: number;
  /**
   * Vendor limits stated on the connect screen, verbatim (spec 5 "Vendor
   * limits, stated on each connect screen").
   */
  connectNotes?: string[];
  /** Credential fields the connect screen collects for this vendor. */
  configFields?: ConfigField[];
  /**
   * Validate the token's scopes on connect. Throw to reject the connect -
   * the error message is shown to the user verbatim.
   */
  validateScopes(ctx: ConnectorContext): Promise<ScopeCheck>;
  /**
   * Fetch one page of the window. Called with pageToken null first, then
   * with each nextPageToken until it returns null. Must parse the vendor
   * format strictly and throw on anything unexpected - errors are stored
   * verbatim on the sync run, and recorded-fixture tests turn vendor format
   * changes into CI failures instead of silent bad numbers.
   */
  fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage>;
}

/**
 * Framework-owned cursor stored in sync_runs.cursor (JSON).
 * - watermark: last fully synced UTC day; the next incremental window
 *   starts at min(watermark, today - 7) - vendors restate data (spec 4).
 * - inProgress: present while a window is being paged (and left behind by a
 *   failed run); the next run resumes this exact window at this exact page.
 */
export interface SyncCursor {
  watermark: string | null;
  inProgress?: {
    since: string;
    until: string;
    pageToken: string | null;
  };
}
