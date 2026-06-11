import {
  isArr,
  isBool,
  isInt,
  isNum,
  isObj,
  nonEmptyStr,
  parseStrict,
  strOrNull,
} from "./strict";
import { addDays, chunkWindows, utcDay } from "./sync";
import type {
  Connector,
  ConnectorContext,
  ConnectorPage,
  FactInput,
  IdentityInput,
  MetricInput,
  ScopeCheck,
  SyncWindow,
} from "./types";

/**
 * Cursor connector (spec 5 v1 row), built on the team Admin API
 * (https://api.cursor.com, Basic auth: API key as username, empty
 * password). The Admin API requires a Business or Enterprise plan; writing
 * per-user spend limits (POST /teams/user-spend-limit) is Enterprise only -
 * both stated on the connect screen, and this connector only ever reads.
 *
 * What one sync pulls, in phase order (one composite page token walks the
 * phases one HTTP request per fetchPage, so every request commits and
 * resumes independently). /teams/daily-usage-data caps a request's window
 * at 30 days ("Date range cannot exceed 30 days"); the events phase uses
 * the same <=30-day chunks - the vendor documents no cap there, so the
 * conservative window always stays valid:
 *
 *   1. members  GET  /teams/members          - team roster (removed members
 *      included) -> "user" identities keyed on Cursor's numeric user id;
 *      email drives auto-map to people. The email->id map rides in the
 *      cursor so later phases can attach email-keyed vendor rows to the
 *      same identity.
 *   2. spend    POST /teams/spend            - per-member CYCLE-TO-DATE
 *      dollars for the current billing cycle, walked by totalPages. Stored
 *      as usage_metrics (cycle_spend_cents / cycle_overall_spend_cents /
 *      spend_limit_dollars), never spend_facts: the same dollars arrive
 *      per event in phase 4, and a cycle aggregate on the ledger would
 *      double count. One row per member per cycle, restated in place every
 *      sync; past cycles keep their final value.
 *   3. daily    POST /teams/daily-usage-data - per-user per-day activity
 *      counters (lines, tabs, applies/accepts/rejects, request counts) ->
 *      usage_metrics, the Tools-page accept-rate source. Counters are not
 *      money. Rows the vendor marks inactive (all-zero placeholders for
 *      members with no activity that day) are skipped.
 *   4. events   POST /teams/filtered-usage-events - the money. Every
 *      CHARGEABLE event becomes one spend fact: the vendor's chargedCents
 *      (what Cursor actually bills, after discounts, including Cursor's
 *      token fee), cost_basis "invoiced", attributed to the member who
 *      spent it - or to the service account (kind api_key, name = tag ->
 *      product routing) when the event carries one; service-account events
 *      are never pinned on the pseudo-user email. Events with
 *      isChargeable=false ("Included in Business", errored-not-charged)
 *      are consumption already covered by the seat fee, not billed money -
 *      they never become spend, so the ledger sums to what Cursor bills.
 *      Seat fees themselves are not served by the Admin API and are never
 *      invented or amortized (spec 5).
 *
 * Vendor-truth notes:
 * - Cursor reports FRACTIONAL cents (chargedCents 21.36232). Facts round
 *   per event (at most half a cent each); the untouched vendor cycle totals
 *   live in the cycle_spend_cents metrics, so drift is always visible
 *   against Cursor's own number.
 * - Events carry no vendor id; the natural key is
 *   (timestamp ms, spender, model). Same-millisecond duplicates get a
 *   deterministic #2/#3... suffix - vendor order within a timestamp is
 *   stable, and the counter state rides in the cursor across page
 *   boundaries, so re-pulls restate the same sourceRefs in place.
 * - fastPremiumRequests / hardLimitOverrideDollars (spend) and the
 *   mostUsedModel/extension/clientVersion strings (daily) are parsed
 *   strictly but not stored: the former is a legacy request-pricing
 *   counter, the latter reports 0 for "no override" and so cannot be told
 *   apart from a real $0 limit. monthlyLimitDollars is the per-user limit
 *   the spec-9 limits loop shows next to ours.
 *
 * Parsers are strict (unknown or missing fields throw) so a vendor format
 * change fails CI/sync with the drift verbatim instead of writing bad
 * numbers.
 */

export const CURSOR_BASE = "https://api.cursor.com";
/**
 * /teams/daily-usage-data caps its window at 30 days (vendor limit); total
 * history depth is undocumented, so backfill is pinned to 90 days of
 * <=30-day chunks.
 */
export const CURSOR_HISTORY_LIMIT_DAYS = 90;
/**
 * Window per daily/events request. The 30-day cap is the documented
 * /teams/daily-usage-data limit; events are chunked the same way.
 */
export const CHUNK_DAYS = 30;
const SPEND_PAGE_SIZE = 100;
const DAILY_PAGE_SIZE = 500;
const EVENTS_PAGE_SIZE = 100;
/** Fixed probe day (2024-01-01 UTC) keeps the connect-time scope check deterministic. */
const SCOPE_PROBE_START_MS = 1_704_067_200_000;

export interface CursorRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Composite page token: the phase, the 1-based vendor page inside it, the
 * <=30-day chunk the daily/events phases are walking, the members
 * email->id map, and the same-millisecond dedupe state of the events
 * phase. It lives in sync_runs.cursor via the framework, so a resume lands
 * on the exact phase, chunk, and page that failed.
 */
interface CursorCursor {
  phase: "members" | "spend" | "daily" | "events";
  page: number;
  chunk: number;
  /** lowercased member email -> Cursor numeric user id (as a string). */
  members: Record<string, string>;
  /** Events emitted for the in-flight millisecond, by base sourceRef. */
  tsCounts?: { ts: string; counts: Record<string, number> };
}

const INITIAL_CURSOR: CursorCursor = {
  phase: "members",
  page: 1,
  chunk: 0,
  members: {},
};

// ---------------------------------------------------------------------------
// HTTP

function basicAuth(ctx: ConnectorContext): string {
  return `Basic ${Buffer.from(`${ctx.config.apiKey ?? ""}:`).toString("base64")}`;
}

async function cursorJson(
  ctx: ConnectorContext,
  req: CursorRequest,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(req.url, {
    method: req.method,
    headers: {
      authorization: basicAuth(ctx),
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    throw new Error(
      typeof body.error === "string" ? body.error : `cursor returned HTTP ${res.status}`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Requests (deterministic - the recorded-fixture harness matches method,
// URL, and JSON body exactly, so window/page math is pinned by recordings)

function unixMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function membersRequest(): CursorRequest {
  return { method: "GET", url: `${CURSOR_BASE}/teams/members` };
}

export function spendRequest(page: number): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/spend`,
    body: { page, pageSize: SPEND_PAGE_SIZE },
  };
}

/** startDate/endDate are the UTC midnights of the chunk's day buckets. */
export function dailyUsageRequest(chunk: SyncWindow, page: number): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/daily-usage-data`,
    body: {
      startDate: unixMs(chunk.since),
      endDate: unixMs(chunk.until),
      page,
      pageSize: DAILY_PAGE_SIZE,
    },
  };
}

/** Both bounds inclusive epoch ms - the end lands on the last ms of `until`. */
export function usageEventsRequest(chunk: SyncWindow, page: number): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/filtered-usage-events`,
    body: {
      startDate: unixMs(chunk.since),
      endDate: unixMs(addDays(chunk.until, 1)) - 1,
      page,
      pageSize: EVENTS_PAGE_SIZE,
    },
  };
}

/**
 * Per-user spend-limit write (spec 9) - the one vendor-side limit we can
 * actually set, and only on Cursor's Enterprise plan. NOT part of sync
 * (the connector itself only ever reads); it lives here because it shares
 * the vendor auth, base URL, and error convention.
 */
export function setUserSpendLimitRequest(
  userEmail: string,
  spendLimitDollars: number,
): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/user-spend-limit`,
    body: { userEmail, spendLimitDollars },
  };
}

/**
 * One vendor write. On any rejection the vendor's error is thrown verbatim.
 * The write endpoints answer two documented envelopes: errors as
 * `{ error }` (/teams/remove-member) or `{ outcome: "error", message }`
 * (/teams/user-spend-limit) - the latter can ride a 2xx, so a 2xx body is
 * still checked before it counts as success. Nothing from a success body is
 * stored.
 */
async function cursorWrite(ctx: ConnectorContext, req: CursorRequest): Promise<void> {
  const res = await ctx.fetch(req.url, {
    method: req.method,
    headers: {
      authorization: basicAuth(ctx),
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON body - the status decides below.
  }
  if (res.ok && body.outcome !== "error") return;
  let message = `cursor returned HTTP ${res.status}`;
  if (typeof body.error === "string") message = body.error;
  else if (typeof body.message === "string") message = body.message;
  else if (text.trim() !== "" && Object.keys(body).length === 0) message = text.trim();
  throw new Error(message);
}

/**
 * Push a per-user monthly limit to Cursor. The vendor accepts whole dollars
 * only ("integer only, no decimals") - refused here before the call rather
 * than silently rounding someone's limit. On Business (or any rejection)
 * the vendor's error is thrown verbatim - never pretend the hard stop
 * happened (spec 9: limit writes are Enterprise only).
 */
export async function setCursorUserSpendLimit(
  ctx: ConnectorContext,
  userEmail: string,
  spendLimitDollars: number,
): Promise<void> {
  if (!Number.isInteger(spendLimitDollars)) {
    throw new Error(
      `Cursor accepts whole-dollar limits only - $${spendLimitDollars} can't be pushed`,
    );
  }
  await cursorWrite(ctx, setUserSpendLimitRequest(userEmail, spendLimitDollars));
}

// ---------------------------------------------------------------------------
// Write operations (spec 8 people out) - same auth, base URL, and
// verbatim-error convention as the limit write above. The Admin API has NO
// invite endpoint - members are added from the Cursor dashboard - so this
// vendor never appears in the invite fan-out.

/**
 * POST /teams/remove-member takes exactly one of `email` or `userId`, and
 * the userId variant wants Cursor's encoded `user_...` id - NOT the numeric
 * id /teams/members reports - so removal is keyed on the member's email.
 * Enterprise only.
 */
export function removeMemberRequest(email: string): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/remove-member`,
    body: { email },
  };
}

/** Remove a member from the Cursor team (their seat) by email. */
export async function removeCursorMember(
  ctx: ConnectorContext,
  email: string,
): Promise<void> {
  await cursorWrite(ctx, removeMemberRequest(email));
}

export function usageEventsProbeRequest(): CursorRequest {
  return {
    method: "POST",
    url: `${CURSOR_BASE}/teams/filtered-usage-events`,
    body: {
      startDate: SCOPE_PROBE_START_MS,
      endDate: SCOPE_PROBE_START_MS + 86_400_000 - 1,
      page: 1,
      pageSize: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase: members

function parseMember(raw: unknown): { id: string; email: string; name: string | null } {
  const member = parseStrict(
    "cursor team member",
    raw,
    {
      id: isInt,
      name: strOrNull,
      email: nonEmptyStr,
      role: nonEmptyStr,
    },
    {
      // Removed members stay listed - their history still belongs to them.
      isRemoved: isBool,
    },
  );
  return {
    id: String(member.id),
    email: member.email as string,
    name: member.name as string | null,
  };
}

function membersPage(body: unknown): { identities: IdentityInput[]; map: Record<string, string> } {
  const env = parseStrict("cursor /teams/members response", body, {
    teamMembers: isArr,
  });
  const identities: IdentityInput[] = [];
  const map: Record<string, string> = {};
  for (const raw of env.teamMembers as unknown[]) {
    const member = parseMember(raw);
    identities.push({
      externalId: member.id,
      kind: "user",
      email: member.email,
      displayName: member.name ?? undefined,
    });
    map[member.email.toLowerCase()] = member.id;
  }
  return { identities, map };
}

// ---------------------------------------------------------------------------
// Phase: spend (current billing cycle -> usage_metrics, never spend facts)

function spendMetrics(
  body: unknown,
): { identities: IdentityInput[]; metrics: MetricInput[]; totalPages: number } {
  const env = parseStrict("cursor /teams/spend response", body, {
    teamMemberSpend: isArr,
    subscriptionCycleStart: isInt,
    totalMembers: isInt,
    totalPages: isInt,
  });
  // The cycle's UTC day keys the row: every sync restates the running
  // cycle in place, past cycles keep their final value.
  const cycleDay = utcDay(new Date(env.subscriptionCycleStart as number));
  const identities: IdentityInput[] = [];
  const metrics: MetricInput[] = [];
  for (const raw of env.teamMemberSpend as unknown[]) {
    const row = parseStrict(
      "cursor spend row",
      raw,
      {
        userId: isInt,
        name: strOrNull,
        email: nonEmptyStr,
        role: nonEmptyStr,
        spendCents: isNum,
        fastPremiumRequests: isInt,
      },
      {
        overallSpendCents: isNum,
        hardLimitOverrideDollars: isNum,
        monthlyLimitDollars: (v) => v === null || isNum(v),
      },
    );
    const identity = { externalId: String(row.userId), kind: "user" as const };
    identities.push({
      ...identity,
      email: row.email as string,
      displayName: (row.name as string | null) ?? undefined,
    });
    const sourceRef = `spend:${cycleDay}:${identity.externalId}`;
    const counters: Record<string, number> = {
      // On-demand (usage-based) cents this cycle - what Cursor bills on
      // top of seats. Fractional cents rounded; the vendor's number.
      cycle_spend_cents: Math.round(row.spendCents as number),
    };
    if (typeof row.overallSpendCents === "number") {
      // Including the consumption covered by the plan's included usage.
      counters.cycle_overall_spend_cents = Math.round(row.overallSpendCents);
    }
    if (typeof row.monthlyLimitDollars === "number") {
      // The vendor-side per-user limit (spec 9 shows it next to ours).
      counters.spend_limit_dollars = Math.round(row.monthlyLimitDollars);
    }
    for (const [metric, value] of Object.entries(counters)) {
      metrics.push({ day: cycleDay, identity, metric, value, sourceRef });
    }
  }
  return { identities, metrics, totalPages: env.totalPages as number };
}

// ---------------------------------------------------------------------------
// Phase: daily (activity counters -> usage_metrics, never spend facts)

/** Vendor field -> stored metric name, all integer counters. */
const DAILY_COUNTERS: Record<string, string> = {
  totalLinesAdded: "lines_added",
  totalLinesDeleted: "lines_deleted",
  acceptedLinesAdded: "accepted_lines_added",
  acceptedLinesDeleted: "accepted_lines_deleted",
  totalApplies: "applies",
  totalAccepts: "accepts",
  totalRejects: "rejects",
  totalTabsShown: "tabs_shown",
  totalTabsAccepted: "tabs_accepted",
  composerRequests: "composer_requests",
  chatRequests: "chat_requests",
  agentRequests: "agent_requests",
  cmdkUsages: "cmdk_usages",
  subscriptionIncludedReqs: "subscription_included_requests",
  apiKeyReqs: "api_key_requests",
  usageBasedReqs: "usage_based_requests",
  bugbotUsages: "bugbot_usages",
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dailyMetrics(
  body: unknown,
): { identities: IdentityInput[]; metrics: MetricInput[]; hasNextPage: boolean } {
  const env = parseStrict("cursor /teams/daily-usage-data response", body, {
    data: isArr,
    period: isObj,
    pagination: isObj,
  });
  parseStrict("cursor daily usage period", env.period, {
    startDate: isInt,
    endDate: isInt,
  });
  const pagination = parseStrict("cursor daily usage pagination", env.pagination, {
    page: isInt,
    pageSize: isInt,
    totalUsers: isInt,
    totalPages: isInt,
    hasNextPage: isBool,
    hasPreviousPage: isBool,
  });

  const identities: IdentityInput[] = [];
  const metrics: MetricInput[] = [];
  for (const raw of env.data as unknown[]) {
    const counterChecks = Object.fromEntries(
      Object.keys(DAILY_COUNTERS).map((field) => [field, isInt]),
    );
    const row = parseStrict("cursor daily usage row", raw, {
      userId: isInt,
      day: (v) => typeof v === "string" && DAY_RE.test(v),
      date: isInt,
      email: nonEmptyStr,
      isActive: isBool,
      ...counterChecks,
      mostUsedModel: strOrNull,
      applyMostUsedExtension: strOrNull,
      tabMostUsedExtension: strOrNull,
      clientVersion: strOrNull,
    });
    const day = row.day as string;
    if (utcDay(new Date(row.date as number)) !== day) {
      throw new Error(
        `cursor daily usage row: date ${row.date} is not UTC midnight of day ${day}`,
      );
    }
    // Inactive rows are the paginated endpoint's all-zero placeholders for
    // members with no activity that day - no data, not a restatement.
    if (row.isActive !== true) continue;

    const identity = { externalId: String(row.userId), kind: "user" as const };
    identities.push({ ...identity, email: row.email as string });
    const sourceRef = `daily:${day}:${identity.externalId}`;
    for (const [field, metric] of Object.entries(DAILY_COUNTERS)) {
      metrics.push({ day, identity, metric, value: row[field] as number, sourceRef });
    }
  }
  return { identities, metrics, hasNextPage: pagination.hasNextPage as boolean };
}

// ---------------------------------------------------------------------------
// Phase: events (per-request charged cents -> spend facts)

interface ParsedEvent {
  ts: string;
  userEmail: string;
  serviceAccountId: string | null;
  serviceAccountName: string | null;
  model: string;
  chargeable: boolean;
  chargedCents: number;
  tokens: number | null;
}

function parseEvent(raw: unknown): ParsedEvent {
  const event = parseStrict(
    "cursor usage event",
    raw,
    {
      timestamp: (v) => typeof v === "string" && /^\d+$/.test(v),
      userEmail: nonEmptyStr,
      model: nonEmptyStr,
      kind: nonEmptyStr,
      maxMode: isBool,
      requestsCosts: isNum,
      isTokenBasedCall: isBool,
      isChargeable: isBool,
      isHeadless: isBool,
      chargedCents: isNum,
    },
    {
      serviceAccountId: nonEmptyStr,
      serviceAccountName: nonEmptyStr,
      tokenUsage: isObj,
      cursorTokenFee: isNum,
    },
  );
  let tokens: number | null = null;
  if (event.tokenUsage !== undefined) {
    const usage = parseStrict(
      "cursor usage event tokenUsage",
      event.tokenUsage,
      {
        inputTokens: isInt,
        outputTokens: isInt,
        cacheWriteTokens: isInt,
        cacheReadTokens: isInt,
        totalCents: isNum,
      },
      {
        discountPercentOff: isNum,
      },
    );
    tokens =
      (usage.inputTokens as number) +
      (usage.outputTokens as number) +
      (usage.cacheWriteTokens as number) +
      (usage.cacheReadTokens as number);
  }
  return {
    ts: event.timestamp as string,
    userEmail: event.userEmail as string,
    serviceAccountId: (event.serviceAccountId as string | undefined) ?? null,
    serviceAccountName: (event.serviceAccountName as string | undefined) ?? null,
    model: event.model as string,
    chargeable: event.isChargeable as boolean,
    chargedCents: event.chargedCents as number,
    tokens,
  };
}

interface EventsOut {
  identities: IdentityInput[];
  facts: FactInput[];
  hasNextPage: boolean;
  tsCounts: NonNullable<CursorCursor["tsCounts"]>;
}

function eventFacts(body: unknown, state: CursorCursor): EventsOut {
  const env = parseStrict("cursor /teams/filtered-usage-events response", body, {
    totalUsageEventsCount: isInt,
    pagination: isObj,
    usageEvents: isArr,
    period: isObj,
  });
  const pagination = parseStrict("cursor usage events pagination", env.pagination, {
    numPages: isInt,
    currentPage: isInt,
    pageSize: isInt,
    hasNextPage: isBool,
    hasPreviousPage: isBool,
  });
  parseStrict("cursor usage events period", env.period, {
    startDate: isInt,
    endDate: isInt,
  });

  const identities = new Map<string, IdentityInput>();
  const facts: FactInput[] = [];
  // Same-millisecond dedupe state, carried across page boundaries: events
  // have no vendor id, so the n-th event of one (ts, spender, model) gets a
  // deterministic #n suffix - stable across re-pulls because vendor order
  // within a timestamp is stable.
  let tsCounts = state.tsCounts ?? { ts: "", counts: {} };

  for (const raw of env.usageEvents as unknown[]) {
    const event = parseEvent(raw);
    // Not billed (covered by the seat's included usage, or errored and not
    // charged): consumption, not money - never spend (the ledger must sum
    // to what Cursor bills). The cycle_overall_spend_cents metric keeps the
    // covered consumption visible per member.
    if (!event.chargeable) continue;

    let identity: FactInput["identity"];
    let spender: string;
    if (event.serviceAccountId !== null) {
      // Agent/CI traffic: the service account is the spender, never the
      // pseudo-user email. Its name is its tag -> product routing (spec 7b).
      identity = { externalId: event.serviceAccountId, kind: "api_key" };
      identities.set(`api_key:${event.serviceAccountId}`, {
        externalId: event.serviceAccountId,
        kind: "api_key",
        displayName: event.serviceAccountName ?? undefined,
        tags: event.serviceAccountName ? [event.serviceAccountName] : [],
      });
      spender = `sa:${event.serviceAccountId}`;
    } else {
      const email = event.userEmail.toLowerCase();
      const memberId = state.members[email];
      if (memberId) {
        identity = { externalId: memberId, kind: "user" };
      } else {
        // An email the roster does not know - still that person's spend;
        // an email-keyed identity feeds auto-match/Resolve (never dropped).
        identity = { externalId: email, kind: "user" };
        identities.set(`user:${email}`, {
          externalId: email,
          kind: "user",
          email: event.userEmail,
        });
      }
      spender = email;
    }

    if (event.ts !== tsCounts.ts) tsCounts = { ts: event.ts, counts: {} };
    const baseRef = `event:${event.ts}:${spender}:${event.model}`;
    const n = (tsCounts.counts[baseRef] ?? 0) + 1;
    tsCounts.counts[baseRef] = n;

    facts.push({
      day: utcDay(new Date(Number(event.ts))),
      identity,
      model: event.model,
      tokens: event.tokens ?? undefined,
      // What Cursor actually bills for the event (post-discount, including
      // Cursor's token fee). Fractional cents rounded per event; drift
      // stays visible against the vendor's own cycle_spend_cents metric.
      amountCents: Math.round(event.chargedCents),
      currency: "USD",
      costBasis: "invoiced",
      sourceRef: n > 1 ? `${baseRef}#${n}` : baseRef,
    });
  }

  return {
    identities: [...identities.values()],
    facts,
    hasNextPage: pagination.hasNextPage as boolean,
    tsCounts,
  };
}

// ---------------------------------------------------------------------------
// The connector

function parseCursorToken(token: string | null): CursorCursor {
  if (token === null) return INITIAL_CURSOR;
  return JSON.parse(token) as CursorCursor;
}

function tokenFor(cursor: CursorCursor): string {
  return JSON.stringify(cursor);
}

/** Advance from a finished chunk: next chunk of the phase, or the next phase. */
function afterChunk(state: CursorCursor, chunkCount: number): CursorCursor {
  if (state.chunk + 1 < chunkCount) {
    return { ...state, chunk: state.chunk + 1, page: 1, tsCounts: undefined };
  }
  if (state.phase === "daily") {
    return { ...state, phase: "events", chunk: 0, page: 1 };
  }
  return state; // events phase done - caller emits the null token
}

export const cursorConnector: Connector = {
  vendor: "cursor",
  displayName: "Cursor",
  historyLimitDays: CURSOR_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Needs an Admin API key, created by a team admin in the Cursor dashboard. The Admin API requires a Business or Enterprise plan.",
    "Spend is per member, per request: every chargeable usage event's charged cents land on the person (or service account) that spent them. Events covered by the plan's included usage are not billed by Cursor and never become spend.",
    "Setting per-user spend limits through the API is Enterprise only, and Cursor accepts whole dollars only. On Business, Cursor's limits are read and shown next to ours, never set - and this connector never writes either way.",
    "Offboarding removes the member's seat via the API (Enterprise only, by email). Cursor has no API for adding members - they are added from the Cursor dashboard.",
    "Service-account traffic is attributed to the service account, not a person - route it to an ROI in the Resolve queue.",
    "Seat fees are not reported by the Admin API and are never invented or amortized.",
  ],
  configFields: [{ key: "apiKey", label: "Admin API key", secret: true }],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    // One admin key grants the whole read surface, but only on Business+.
    // Probe both surfaces the sync needs - the roster and the usage-events
    // report - so a free/legacy team or a revoked key rejects the connect
    // with the vendor's error verbatim instead of failing the first sync.
    membersPage(await cursorJson(ctx, membersRequest()));
    const probe = await cursorJson(ctx, usageEventsProbeRequest());
    parseStrict("cursor /teams/filtered-usage-events response", probe, {
      totalUsageEventsCount: isInt,
      pagination: isObj,
      usageEvents: isArr,
      period: isObj,
    });
    return { scopes: ["admin_api"] };
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const state = parseCursorToken(pageToken);
    const chunks = chunkWindows(window, CHUNK_DAYS);

    switch (state.phase) {
      case "members": {
        const { identities, map } = membersPage(await cursorJson(ctx, membersRequest()));
        const next: CursorCursor = { ...state, phase: "spend", page: 1, members: map };
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "spend": {
        const out = spendMetrics(await cursorJson(ctx, spendRequest(state.page)));
        const next: CursorCursor =
          state.page < out.totalPages
            ? { ...state, page: state.page + 1 }
            : { ...state, phase: "daily", chunk: 0, page: 1 };
        return {
          identities: out.identities,
          facts: [],
          metrics: out.metrics,
          nextPageToken: tokenFor(next),
        };
      }

      case "daily": {
        const out = dailyMetrics(
          await cursorJson(ctx, dailyUsageRequest(chunks[state.chunk], state.page)),
        );
        const next: CursorCursor = out.hasNextPage
          ? { ...state, page: state.page + 1 }
          : afterChunk(state, chunks.length);
        return {
          identities: out.identities,
          facts: [],
          metrics: out.metrics,
          nextPageToken: tokenFor(next),
        };
      }

      case "events": {
        const out = eventFacts(
          await cursorJson(ctx, usageEventsRequest(chunks[state.chunk], state.page)),
          state,
        );
        if (out.hasNextPage) {
          // The dedupe state rides along: a same-ms run can span pages.
          const next: CursorCursor = { ...state, page: state.page + 1, tsCounts: out.tsCounts };
          return { identities: out.identities, facts: out.facts, nextPageToken: tokenFor(next) };
        }
        const done = state.chunk + 1 >= chunks.length;
        return {
          identities: out.identities,
          facts: out.facts,
          nextPageToken: done ? null : tokenFor(afterChunk(state, chunks.length)),
        };
      }
    }
  },
};
