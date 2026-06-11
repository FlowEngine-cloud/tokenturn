import { randomBytes, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { isArr, isObj, nonEmptyStr, parsePicked, strOrNull } from "@/lib/connectors/strict";
import type { ConnectorContext } from "@/lib/connectors/types";
import { getPool, type Db } from "@/lib/db";
import { eeFeatureEnabled } from "@/lib/license";
import { logger } from "@/lib/logger";
import { INVITE_VENDORS, inviteFanout, runOffboard, type InviteResult } from "@/lib/provision";
import { ResolveError } from "@/lib/resolve";
import { deleteSetting, getSecretSetting, setSecretSetting } from "@/lib/settings";
import {
  directorySyncDue,
  finishDirectoryRun,
  lastDirectoryRun,
  startDirectoryRun,
  upsertRoster,
  type DirectoryRunSummary,
} from "./directory";

/**
 * Okta sync (spec 11, enterprise): auto-invite on hire, auto-offboard on
 * leave. Part of ee/ - commercial license (see ee/LICENSE).
 *
 * Two paths fire the leaver sweep, both idempotent (the offboard plan is
 * keyed per identity, so a re-sweep retries failures instead of stacking
 * duplicates):
 *
 *   1. The Okta event hook (POST /api/ee/okta/events) - Okta calls us the
 *      moment a user is deactivated or suspended.
 *   2. The hourly System Log poll - the backstop for hooks Okta dropped or
 *      that arrived while we were down. Its cursor (last `published` seen)
 *      rides in sync_runs like every connector cursor.
 *
 * The roster sync runs hourly through the people-import path (upsert by
 * email, names never regress, nobody removed); people Okta creates are
 * auto-invited to every connected email-keyed vendor. Copilot is excluded
 * on purpose: its seat API is username-keyed and a new hire has no mapped
 * GitHub login yet - inviting them there would only manufacture failures.
 */

export const OKTA_CONFIG_SETTING = "directory:okta:config";
export const OKTA_CONNECTOR = "okta_directory";
const PAGE_LIMIT = 200; // Okta's maximum for /users
const LOG_LIMIT = 100;

/** Deactivation + suspension both end access (spec 11: "on leave"). */
export const LEAVER_EVENT_TYPES = [
  "user.lifecycle.deactivate",
  "user.lifecycle.suspend",
] as const;

export interface OktaConfig {
  /** Org base URL, e.g. https://acme.okta.com */
  domain: string;
  /** SSWS API token (read users + system log). */
  token: string;
  /** Shared secret Okta sends back in the event hook's Authorization header. */
  hookSecret: string;
}

export interface OktaOpts {
  db?: Db;
  fetch?: typeof fetch;
  dataDir?: string;
  now?: Date;
  /** Sync-now: skip the hourly cadence check. */
  force?: boolean;
}

const DOMAIN_RE = /^https:\/\/[a-z0-9.-]+$/i;

export function validateOktaInput(raw: unknown): { domain: string; token: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ResolveError("body must be { domain, token }", 400);
  }
  const r = raw as Record<string, unknown>;
  const domain = typeof r.domain === "string" ? r.domain.trim().replace(/\/+$/, "") : "";
  const token = typeof r.token === "string" ? r.token.trim() : "";
  if (!DOMAIN_RE.test(domain) || !domain.includes(".")) {
    throw new ResolveError("domain must be the org base URL, like https://acme.okta.com", 400);
  }
  if (token === "") throw new ResolveError("token is required (an Okta SSWS API token)", 400);
  return { domain, token };
}

export async function getOktaConfig(opts: OktaOpts = {}): Promise<OktaConfig | null> {
  const db = opts.db ?? getPool();
  const raw = await getSecretSetting(OKTA_CONFIG_SETTING, db, opts.dataDir);
  return raw === null ? null : (JSON.parse(raw) as OktaConfig);
}

// ---------------------------------------------------------------------------
// HTTP - SSWS auth, vendor errors verbatim (same convention as connectors)

function oktaContext(config: OktaConfig, fetchImpl: typeof fetch = fetch): ConnectorContext {
  return {
    config: { domain: config.domain, token: config.token },
    fetch: fetchImpl,
    log: logger.child({ connector: OKTA_CONNECTOR }),
  };
}

interface OktaPage {
  body: unknown;
  /** The `after` cursor from the Link rel="next" header, if any. */
  nextAfter: string | null;
}

async function oktaGet(ctx: ConnectorContext, path: string): Promise<OktaPage> {
  const res = await ctx.fetch(`${ctx.config.domain}${path}`, {
    headers: {
      authorization: `SSWS ${ctx.config.token ?? ""}`,
      accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Okta's error verbatim - errorSummary when shaped, raw body otherwise.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { errorSummary?: string };
      if (typeof parsed.errorSummary === "string") detail = parsed.errorSummary;
    } catch {
      // keep the raw body
    }
    throw new Error(`okta ${res.status} on ${path}: ${detail}`);
  }
  let nextAfter: string | null = null;
  const link = res.headers.get("link") ?? "";
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) nextAfter = new URL(m[1]).searchParams.get("after");
  }
  return { body: JSON.parse(text), nextAfter };
}

// ---------------------------------------------------------------------------
// Parsing (strict on the fields we consume; Okta objects are huge)

interface OktaUser {
  email: string;
  name: string | null;
}

export function parseOktaUsers(body: unknown): OktaUser[] {
  if (!isArr(body)) throw new Error(`okta /users response is not an array: ${JSON.stringify(body)}`);
  return (body as unknown[]).map((raw) => {
    const user = parsePicked("okta user", raw, { id: nonEmptyStr, status: nonEmptyStr, profile: isObj });
    const profile = parsePicked("okta user profile", user.profile, { email: nonEmptyStr }, {
      firstName: strOrNull,
      lastName: strOrNull,
      displayName: strOrNull,
    });
    const name =
      (typeof profile.displayName === "string" && profile.displayName.trim()) ||
      [profile.firstName, profile.lastName]
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .join(" ")
        .trim() ||
      null;
    return { email: profile.email as string, name };
  });
}

export interface LeaverEvent {
  /** The deactivated user's login email. */
  email: string;
  eventType: string;
  /** ISO timestamp Okta published the event. */
  published: string;
}

/** Parse System Log entries (poll) or event-hook payloads into leaver events. */
export function parseLeaverEvents(items: unknown[]): LeaverEvent[] {
  const leavers: LeaverEvent[] = [];
  for (const raw of items) {
    const entry = parsePicked("okta log event", raw, {
      eventType: nonEmptyStr,
      published: nonEmptyStr,
      target: isArr,
    });
    if (!(LEAVER_EVENT_TYPES as readonly string[]).includes(entry.eventType as string)) continue;
    for (const t of entry.target as unknown[]) {
      const target = parsePicked("okta event target", t, { type: nonEmptyStr }, { alternateId: strOrNull });
      if (target.type === "User" && typeof target.alternateId === "string") {
        leavers.push({
          email: target.alternateId,
          eventType: entry.eventType as string,
          published: entry.published as string,
        });
        break;
      }
    }
  }
  return leavers;
}

// ---------------------------------------------------------------------------
// Connect / disconnect

/**
 * Validate the token (one-user probe + a System Log probe, so a token
 * missing log access rejects at connect, not at the first poll), then store
 * the config encrypted with a freshly minted hook secret.
 */
export async function connectOkta(
  input: { domain: string; token: string },
  opts: OktaOpts = {},
): Promise<OktaConfig> {
  const db = opts.db ?? getPool();
  const probeCtx = oktaContext({ ...input, hookSecret: "" }, opts.fetch);
  parseOktaUsers((await oktaGet(probeCtx, `/api/v1/users?limit=1`)).body);
  await oktaGet(probeCtx, `/api/v1/logs?limit=1`);

  // Reconnecting keeps the existing hook secret - the hook registered in
  // Okta keeps working across token rotations.
  const existing = await getOktaConfig({ ...opts, db });
  const config: OktaConfig = {
    ...input,
    hookSecret: existing?.hookSecret ?? randomBytes(24).toString("base64url"),
  };
  await setSecretSetting(OKTA_CONFIG_SETTING, JSON.stringify(config), db, opts.dataDir);
  logger.info("okta directory connected", { domain: input.domain });
  return config;
}

export async function disconnectOkta(opts: OktaOpts = {}): Promise<boolean> {
  const db = opts.db ?? getPool();
  const had = (await getOktaConfig(opts)) !== null;
  await deleteSetting(OKTA_CONFIG_SETTING, db);
  if (had) logger.info("okta directory disconnected", {});
  return had;
}

/** Constant-time check of the event hook's Authorization header. */
export function hookAuthorized(config: OktaConfig, header: string | null): boolean {
  if (header === null) return false;
  const want = Buffer.from(config.hookSecret, "utf8");
  const got = Buffer.from(header.replace(/^Bearer\s+/i, ""), "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------------------
// The leaver sweep (shared by the event hook and the poll backstop)

export interface LeaverSweepResult {
  email: string;
  /** offboarded | already_offboarded | unknown_person | error */
  outcome: string;
  error: string | null;
}

export async function sweepLeaver(
  event: LeaverEvent,
  opts: OktaOpts = {},
): Promise<LeaverSweepResult> {
  const db = opts.db ?? getPool();
  const { rows } = await db.query(
    `SELECT id, status FROM people
     WHERE lower(email) = lower($1) AND merged_into IS NULL`,
    [event.email],
  );
  if (rows.length === 0) {
    // Not on the roster: nothing to sweep, surfaced honestly in the audit.
    await audit("system", "okta.leaver", { email: event.email, eventType: event.eventType, outcome: "unknown_person" }, db);
    return { email: event.email, outcome: "unknown_person", error: null };
  }
  const already = rows[0].status === "offboarded";
  try {
    // runOffboard is idempotent: a repeat sweep re-executes only items that
    // are not yet removed, and writes its own audit entry.
    const overview = await runOffboard(rows[0].id as string, { db, fetch: opts.fetch, dataDir: opts.dataDir });
    const failed = overview.items.filter((i) => i.status === "failed").length;
    const outcome = already ? "already_offboarded" : "offboarded";
    await audit("system", "okta.leaver", { email: event.email, eventType: event.eventType, outcome, failedItems: failed }, db);
    return { email: event.email, outcome, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit("system", "okta.leaver", { email: event.email, eventType: event.eventType, outcome: "error", error: message }, db);
    return { email: event.email, outcome: "error", error: message };
  }
}

// ---------------------------------------------------------------------------
// The hourly tick: roster sync + auto-invite + System Log poll backstop

export interface OktaTickResult {
  ran: boolean;
  created: number;
  updated: number;
  autoInvited: InviteResult[];
  leavers: LeaverSweepResult[];
  error: string | null;
}

const SKIPPED: OktaTickResult = {
  ran: false,
  created: 0,
  updated: 0,
  autoInvited: [],
  leavers: [],
  error: null,
};

/** Vendors a brand-new hire can be invited to by email (Copilot is login-keyed). */
async function autoInviteVendors(db: Db): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT vendor FROM connectors WHERE vendor = ANY ($1) AND vendor <> 'github' ORDER BY vendor`,
    [[...INVITE_VENDORS]],
  );
  return rows.map((r) => r.vendor as string);
}

export async function oktaTick(opts: OktaOpts = {}): Promise<OktaTickResult> {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  if (!(await eeFeatureEnabled("okta_sync", db, now))) return SKIPPED;
  const config = await getOktaConfig(opts);
  if (config === null) return SKIPPED;
  if (!opts.force && !(await directorySyncDue(OKTA_CONNECTOR, now, db))) return SKIPPED;

  const ctx = oktaContext(config, opts.fetch);
  const { runId, cursor } = await startDirectoryRun(OKTA_CONNECTOR, db);
  try {
    // 1. Roster: every ACTIVE user, paged.
    const users: OktaUser[] = [];
    let after: string | null = null;
    do {
      const path: string =
        `/api/v1/users?limit=${PAGE_LIMIT}` +
        `&filter=${encodeURIComponent('status eq "ACTIVE"')}` +
        (after !== null ? `&after=${encodeURIComponent(after)}` : "");
      const page: OktaPage = await oktaGet(ctx, path);
      users.push(...parseOktaUsers(page.body));
      after = page.nextAfter;
    } while (after !== null);
    const roster = await upsertRoster(users, "okta", db);

    // 2. Auto-invite on hire: people this sync just created.
    let autoInvited: InviteResult[] = [];
    if (roster.created.length > 0) {
      const vendors = await autoInviteVendors(db);
      if (vendors.length > 0) {
        autoInvited = await inviteFanout(roster.created.map((p) => p.id), vendors, {
          db,
          fetch: opts.fetch,
          dataDir: opts.dataDir,
        });
        await audit(
          "system",
          "okta.auto_invite",
          {
            people: roster.created.map((p) => p.email),
            vendors,
            ok: autoInvited.filter((r) => r.ok).length,
            failed: autoInvited.filter((r) => !r.ok).length,
          },
          db,
        );
      }
    }

    // 3. System Log poll - the backstop for missed event hooks. First tick
    // starts at "now" (history before Okta was connected is not ours to
    // replay); after that the cursor is the last published timestamp seen.
    const leavers: LeaverSweepResult[] = [];
    const since = cursor.logsSince ?? now.toISOString();
    let newest = since;
    let logAfter: string | null = null;
    do {
      const path: string =
        `/api/v1/logs?limit=${LOG_LIMIT}&sortOrder=ASCENDING` +
        `&since=${encodeURIComponent(since)}` +
        `&filter=${encodeURIComponent(LEAVER_EVENT_TYPES.map((t) => `eventType eq "${t}"`).join(" or "))}` +
        (logAfter !== null ? `&after=${encodeURIComponent(logAfter)}` : "");
      const page: OktaPage = await oktaGet(ctx, path);
      if (!isArr(page.body)) {
        throw new Error(`okta /logs response is not an array: ${JSON.stringify(page.body)}`);
      }
      const events = parseLeaverEvents(page.body as unknown[]);
      for (const event of events) {
        leavers.push(await sweepLeaver(event, { ...opts, db }));
        if (event.published > newest) newest = event.published;
      }
      // Okta pages an empty tail; stop when a page comes back empty.
      logAfter = (page.body as unknown[]).length > 0 ? page.nextAfter : null;
    } while (logAfter !== null);

    await finishDirectoryRun(
      runId,
      { status: "success", cursor: { ...cursor, logsSince: newest }, rowsSynced: users.length },
      db,
    );
    logger.info("okta tick finished", {
      users: users.length,
      created: roster.created.length,
      leavers: leavers.length,
    });
    return {
      ran: true,
      created: roster.created.length,
      updated: roster.updated,
      autoInvited,
      leavers,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDirectoryRun(runId, { status: "error", error: message }, db);
    logger.error("okta tick failed", { error: message });
    return { ...SKIPPED, ran: true, error: message };
  }
}

/** The Settings health line. */
export async function oktaStatus(
  opts: OktaOpts = {},
): Promise<{ connected: boolean; domain: string | null; hookSecret: string | null; lastRun: DirectoryRunSummary | null }> {
  const db = opts.db ?? getPool();
  const config = await getOktaConfig(opts);
  return {
    connected: config !== null,
    domain: config?.domain ?? null,
    // Our own minted hook credential (never the Okta token): the admin
    // needs it verbatim to register the event hook in Okta.
    hookSecret: config?.hookSecret ?? null,
    lastRun: await lastDirectoryRun(OKTA_CONNECTOR, db),
  };
}
