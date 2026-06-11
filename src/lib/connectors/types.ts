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

/**
 * One success as the vendor reports it (a merged PR, ...). Routed to the
 * product whose outcome_kind matches `kind`; (kind, sourceRef) is the
 * idempotent upsert key, so re-pulls restate in place.
 */
export interface OutcomeInput {
  /** ISO-8601 timestamp. A merged PR counts on merge (spec 5). */
  ts: string;
  /** Outcome kind, e.g. "github_pr". Matches products.outcome_kind. */
  kind: string;
  /** The identity credited; omitted = unattributed (e.g. a bot author). */
  identity?: { externalId: string; kind: IdentityInput["kind"] };
  valueCents?: number;
  /** ISO-4217, required iff valueCents is set. */
  currency?: string;
  /** AI tools detected on the record (bot author / co-author trailers). */
  tools?: string[];
  /**
   * Vendor record keys a later revert may reference (the PR's merge + head
   * commit shas). Stored on the outcome so a revert synced weeks later can
   * still find its target.
   */
  shas?: string[];
  /** The vendor record behind the outcome (PR ref) - what drills. */
  sourceRef: string;
}

/**
 * A revert the vendor reports. The framework flips the referenced outcome
 * (sets reverted_at) when the revert lands within revert_window_days
 * (Settings, default 30) of the outcome's ts; after the window the outcome
 * is final (spec 5). Flips apply against the whole ledger, not just this
 * sync's window, so a revert synced weeks after its target still lands.
 */
export interface RevertInput {
  /** ISO-8601 timestamp the revert took effect (its merge). */
  ts: string;
  /** Outcome kind this revert can flip. */
  kind: string;
  /** The reverting record itself - drills from the flipped outcome. */
  sourceRef: string;
  /** The reverted outcome's sourceRef ("Reverts owner/repo#N"). */
  targetRef?: string;
  /** Or a commit sha the outcome registered ("This reverts commit X"). */
  targetSha?: string;
}

/**
 * One tracked issue from a success integration (spec 7: Jira, Linear),
 * distilled from its status-transition history (Jira changelog / Linear
 * history) against the connection's configured statuses. The framework runs
 * the success state machine on these (lib/connectors/issues.ts): submitted
 * -> pending; success when the window passes without regression or Done
 * arrives sooner; fail when it regresses inside the window. Success emits
 * one 'issue_done' outcome; the issue is counted from history, never from
 * the status the sync happens to observe.
 */
export interface IssueInput {
  /** The issue's web URL - the outcome's source_ref (drills, and keeps the
   * two issue vendors from colliding on a shared "ENG-1" key). */
  sourceRef: string;
  /** The human key ("ENG-12") - what the ticket drill shows. */
  key: string;
  title?: string;
  /** Jira project key / Linear team key - the project -> ROI mapping unit. */
  project: string;
  /** The credited identity (spec 7: agent assignee, agent creator, else the
   * human creator by email); omitted = unattributed. */
  identity?: { externalId: string; kind: IdentityInput["kind"] };
  /** First transition into the connection's "submitted" status, ISO ts. */
  submittedAt?: string;
  /** First transition into Done at/after the anchor, ISO ts. */
  doneAt?: string;
  /** First regression into the fail status after the anchor, ISO ts. */
  regressedAt?: string;
}

/** One page of a sync. nextPageToken null = the window is complete. */
export interface ConnectorPage {
  identities: IdentityInput[];
  facts: FactInput[];
  /** Non-spend usage counters (optional - most connectors have none). */
  metrics?: MetricInput[];
  /** Successes (merged PRs, ...) - the outcome source (spec 5 GitHub row). */
  outcomes?: OutcomeInput[];
  /** Reverts to apply against previously synced outcomes. */
  reverts?: RevertInput[];
  /** Tracked issues (success integrations) - the framework runs the success
   * state machine and owns the outcomes they emit. */
  issues?: IssueInput[];
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
  /** May be left empty (the connector applies its default). */
  optional?: boolean;
  /** Shown in the empty input - states the default. */
  placeholder?: string;
}

export interface Connector {
  /** Stable id, e.g. "anthropic". Matches sync_runs.connector / facts.vendor. */
  vendor: string;
  displayName: string;
  /**
   * Success integrations (spec 7: Jira, Linear) write outcomes only - never
   * spend. The Connections card says so.
   */
  successOnly?: boolean;
  /** Outcome kinds this connector writes - health counts its outcomes by them. */
  outcomeKinds?: string[];
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
   * Success integrations only: the vendor's projects (Jira projects, Linear
   * teams) - the project -> ROI mapping screen at connect lists these.
   */
  listProjects?(ctx: ConnectorContext): Promise<{ key: string; name: string }[]>;
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
