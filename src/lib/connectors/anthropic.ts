import { estimateAnthropicUsdCents } from "./anthropic-prices";
import {
  isArr,
  isBool,
  isInt,
  isNum,
  isObj,
  isStr,
  literal,
  nonEmptyStr,
  parsePicked,
  parseStrict,
  strOrNull,
} from "./strict";
import { addDays } from "./sync";
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
 * Anthropic connector (spec 5 v1 row), built on the Admin API
 * (sk-ant-admin... key, x-api-key header).
 *
 * What one sync pulls, in phase order (the composite page token below walks
 * these phases one HTTP request per fetchPage, so every request commits and
 * resumes independently):
 *
 *   1. users      GET /v1/organizations/users          - org members ->
 *      "user" identities (email drives auto-map to people).
 *   2. api_keys   GET /v1/organizations/api_keys       - "api_key"
 *      identities. The key NAME becomes its tag (spec 7b) and the key
 *      auto-maps to the person who created it (created_by -> that user's
 *      email). There is NO key-creation API: people mint keys in the
 *      Console and this phase auto-discovers them (spec 8).
 *   3. usage      GET /v1/organizations/usage_report/messages
 *      grouped by api_key_id + workspace_id + model, 1d buckets. Anthropic
 *      reports TOKENS here, never dollars, and never groups raw spend by
 *      user - so per-key dollars are estimated from the pinned price table
 *      (cost_basis "estimated") and per-employee spend = one key per
 *      person. Rows without a key (Console usage) land in Unassigned.
 *   4. cost       GET /v1/organizations/cost_report
 *      grouped by workspace_id + description, 1d buckets. Dollars here are
 *      per workspace only. Token-cost rows are SKIPPED (the per-key
 *      estimates above already carry that money - storing both would
 *      double count); non-token rows (web search, code execution, session
 *      usage) become invoiced, unassigned facts - real billed money the
 *      token math cannot see.
 *   5. claude_code GET /v1/organizations/usage_report/claude_code
 *      per-user per-day analytics (one request per UTC day). Stored as
 *      usage_metrics (sessions, commits, PRs, lines, accepted/rejected
 *      tool actions, tokens, the vendor's estimated cost in cents) - NOT
 *      as spend facts, because API-billed Claude Code traffic already
 *      shows up under its API key in phase 3.
 *
 * Parsers are strict (unknown or missing fields throw) so a vendor format
 * change fails CI/sync with the drift verbatim instead of writing bad
 * numbers.
 */

export const ANTHROPIC_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Usage/cost report calls cap at 31 one-day buckets; backfill is pinned to
 * the same horizon so the first sync is a single paged window.
 */
export const ANTHROPIC_HISTORY_LIMIT_DAYS = 31;
const LIST_LIMIT = 1000; // users / api_keys / claude_code page size (vendor max)
const BUCKET_LIMIT = 31; // 1d buckets per usage/cost response (vendor max)

/**
 * Composite page token: which phase the sync is in, the vendor cursor
 * inside that phase, and the lookup maps later phases need. It lives in
 * sync_runs.cursor via the framework, so a resume lands on the exact phase
 * and page that failed, with the maps intact.
 */
interface AnthropicCursor {
  phase: "users" | "api_keys" | "usage" | "cost" | "claude_code";
  /** after_id for list endpoints, page token for report endpoints. */
  cursor: string | null;
  /** UTC day being fetched (claude_code serves one day per call). */
  day: string | null;
  /** user id -> email; created_by -> email is what auto-maps keys. */
  users: Record<string, string>;
  /** lower(key name) -> key id; claude_code api_actors report key NAMES. */
  keys: Record<string, string>;
}

const INITIAL_CURSOR: AnthropicCursor = {
  phase: "users",
  cursor: null,
  day: null,
  users: {},
  keys: {},
};

// ---------------------------------------------------------------------------
// Strict parsing (shared helpers in strict.ts) - drift throws, verbatim.

const UTC_MIDNIGHT_RE = /^\d{4}-\d{2}-\d{2}T00:00:00(\.\d+)?Z$/;
const DAY_OR_MIDNIGHT_RE = /^\d{4}-\d{2}-\d{2}(T00:00:00(\.\d+)?Z)?$/;
/** Cost amounts arrive in lowest currency units as a decimal string. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** 1d buckets snap to UTC midnight; anything else is drift. */
function bucketDay(label: string, value: unknown): string {
  if (typeof value !== "string" || !UTC_MIDNIGHT_RE.test(value)) {
    throw new Error(`${label}: bucket boundary is not a UTC midnight: ${JSON.stringify(value)}`);
  }
  return value.slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP

async function anthropicJson(
  ctx: ConnectorContext,
  url: string,
  init?: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      "x-api-key": ctx.config.adminKey ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    const error = isObj(body.error) ? (body.error as Record<string, unknown>) : undefined;
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : `anthropic returned HTTP ${res.status}`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// URLs (deterministic - the recorded-fixture harness matches them exactly)

export function usersUrl(afterId: string | null): string {
  return (
    `${ANTHROPIC_BASE}/v1/organizations/users?limit=${LIST_LIMIT}` +
    (afterId ? `&after_id=${encodeURIComponent(afterId)}` : "")
  );
}

export function apiKeysUrl(afterId: string | null): string {
  return (
    `${ANTHROPIC_BASE}/v1/organizations/api_keys?limit=${LIST_LIMIT}` +
    (afterId ? `&after_id=${encodeURIComponent(afterId)}` : "")
  );
}

/** Inclusive day window -> half-open RFC 3339 bucket range. */
function windowParams(window: SyncWindow): string {
  return `starting_at=${window.since}T00:00:00Z&ending_at=${addDays(window.until, 1)}T00:00:00Z`;
}

export function usageUrl(window: SyncWindow, page: string | null): string {
  return (
    `${ANTHROPIC_BASE}/v1/organizations/usage_report/messages?${windowParams(window)}` +
    `&bucket_width=1d&group_by[]=api_key_id&group_by[]=workspace_id&group_by[]=model&limit=${BUCKET_LIMIT}` +
    (page ? `&page=${encodeURIComponent(page)}` : "")
  );
}

export function costUrl(window: SyncWindow, page: string | null): string {
  return (
    `${ANTHROPIC_BASE}/v1/organizations/cost_report?${windowParams(window)}` +
    `&bucket_width=1d&group_by[]=workspace_id&group_by[]=description&limit=${BUCKET_LIMIT}` +
    (page ? `&page=${encodeURIComponent(page)}` : "")
  );
}

export function claudeCodeUrl(day: string, page: string | null): string {
  return (
    `${ANTHROPIC_BASE}/v1/organizations/usage_report/claude_code?starting_at=${day}&limit=${LIST_LIMIT}` +
    (page ? `&page=${encodeURIComponent(page)}` : "")
  );
}

// ---------------------------------------------------------------------------
// Envelopes

interface ListEnvelope {
  data: unknown[];
  hasMore: boolean;
  lastId: string | null;
}

function parseListEnvelope(label: string, body: unknown): ListEnvelope {
  const env = parseStrict(label, body, {
    data: isArr,
    first_id: strOrNull,
    has_more: isBool,
    last_id: strOrNull,
  });
  if (env.has_more === true && typeof env.last_id !== "string") {
    throw new Error(`${label}: has_more without a last_id cursor`);
  }
  return {
    data: env.data as unknown[],
    hasMore: env.has_more as boolean,
    lastId: env.last_id as string | null,
  };
}

interface ReportEnvelope {
  data: unknown[];
  hasMore: boolean;
  nextPage: string | null;
}

function parseReportEnvelope(label: string, body: unknown): ReportEnvelope {
  const env = parseStrict(label, body, {
    data: isArr,
    has_more: isBool,
    next_page: strOrNull,
  });
  if (env.has_more === true && typeof env.next_page !== "string") {
    throw new Error(`${label}: has_more without a next_page token`);
  }
  return {
    data: env.data as unknown[],
    hasMore: env.has_more as boolean,
    nextPage: env.next_page as string | null,
  };
}

// ---------------------------------------------------------------------------
// Phase: users

function parseUser(raw: unknown): { id: string; email: string; name: string | null } {
  const user = parseStrict("anthropic user", raw, {
    id: nonEmptyStr,
    added_at: nonEmptyStr,
    email: nonEmptyStr,
    name: strOrNull,
    role: nonEmptyStr,
    type: literal("user"),
  });
  return {
    id: user.id as string,
    email: user.email as string,
    name: user.name as string | null,
  };
}

// ---------------------------------------------------------------------------
// Phase: api_keys

function parseApiKey(raw: unknown): {
  id: string;
  name: string;
  createdById: string;
  workspaceId: string | null;
} {
  const key = parseStrict("anthropic api key", raw, {
    id: nonEmptyStr,
    created_at: nonEmptyStr,
    created_by: isObj,
    expires_at: strOrNull,
    name: nonEmptyStr,
    partial_key_hint: strOrNull,
    status: nonEmptyStr,
    type: literal("api_key"),
    workspace_id: strOrNull,
  });
  const createdBy = parseStrict("anthropic api key created_by", key.created_by, {
    id: nonEmptyStr,
    type: nonEmptyStr,
  });
  return {
    id: key.id as string,
    name: key.name as string,
    createdById: createdBy.id as string,
    workspaceId: key.workspace_id as string | null,
  };
}

// ---------------------------------------------------------------------------
// Phase: usage (usage_report/messages)

function parseUsageResult(raw: unknown): {
  apiKeyId: string | null;
  workspaceId: string | null;
  model: string;
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
} {
  const result = parseStrict("anthropic usage result", raw, {
    account_id: strOrNull,
    api_key_id: strOrNull,
    cache_creation: isObj,
    cache_read_input_tokens: isInt,
    context_window: strOrNull,
    inference_geo: strOrNull,
    // We group by model, so a null model means the grouping changed.
    model: nonEmptyStr,
    output_tokens: isInt,
    server_tool_use: isObj,
    service_account_id: strOrNull,
    service_tier: strOrNull,
    uncached_input_tokens: isInt,
    workspace_id: strOrNull,
  });
  const cache = parseStrict("anthropic usage cache_creation", result.cache_creation, {
    ephemeral_1h_input_tokens: isInt,
    ephemeral_5m_input_tokens: isInt,
  });
  parseStrict("anthropic usage server_tool_use", result.server_tool_use, {
    web_search_requests: isInt,
  });
  return {
    apiKeyId: result.api_key_id as string | null,
    workspaceId: result.workspace_id as string | null,
    model: result.model as string,
    uncachedInput: result.uncached_input_tokens as number,
    output: result.output_tokens as number,
    cacheRead: result.cache_read_input_tokens as number,
    cacheWrite5m: cache.ephemeral_5m_input_tokens as number,
    cacheWrite1h: cache.ephemeral_1h_input_tokens as number,
  };
}

function usageFacts(label: string, body: unknown): FactInput[] {
  const facts: FactInput[] = [];
  const env = parseReportEnvelope(label, body);
  for (const rawBucket of env.data) {
    const bucket = parseStrict("anthropic usage bucket", rawBucket, {
      starting_at: isStr,
      ending_at: isStr,
      results: isArr,
    });
    const day = bucketDay("anthropic usage bucket", bucket.starting_at);
    for (const raw of bucket.results as unknown[]) {
      const row = parseUsageResult(raw);
      const tokens =
        row.uncachedInput + row.output + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h;
      facts.push({
        day,
        // No key = Console/Workbench usage: visible Unassigned, never hidden.
        identity: row.apiKeyId ? { externalId: row.apiKeyId, kind: "api_key" } : undefined,
        model: row.model,
        tokens,
        // Anthropic reports tokens here, never dollars - priced from the
        // pinned table, marked estimated. Unknown models throw.
        amountCents: estimateAnthropicUsdCents(row.model, row),
        currency: "USD",
        costBasis: "estimated",
        sourceRef: `usage:${day}:${row.apiKeyId ?? "none"}:${row.workspaceId ?? "default"}:${row.model}`,
      });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Phase: cost (cost_report)

function costFacts(label: string, body: unknown): FactInput[] {
  const facts: FactInput[] = [];
  const env = parseReportEnvelope(label, body);
  for (const rawBucket of env.data) {
    const bucket = parseStrict("anthropic cost bucket", rawBucket, {
      starting_at: isStr,
      ending_at: isStr,
      results: isArr,
    });
    const day = bucketDay("anthropic cost bucket", bucket.starting_at);
    for (const raw of bucket.results as unknown[]) {
      const result = parseStrict("anthropic cost result", raw, {
        amount: (v) => typeof v === "string" && DECIMAL_RE.test(v),
        context_window: strOrNull,
        // We group by description, so these two must be present.
        cost_type: nonEmptyStr,
        currency: (v) => typeof v === "string" && CURRENCY_RE.test(v),
        description: nonEmptyStr,
        inference_geo: strOrNull,
        model: strOrNull,
        service_tier: strOrNull,
        token_type: strOrNull,
        workspace_id: strOrNull,
      });
      // Token costs are already on the ledger as per-key estimates (phase
      // 3); storing the workspace-level billed version too would double
      // count. Everything else (web_search, code_execution, session_usage)
      // is billed money with no token trail - keep it, invoiced, Unassigned.
      if (result.cost_type === "tokens") continue;
      const workspace = (result.workspace_id as string | null) ?? "default";
      facts.push({
        day,
        // amount is in lowest currency units (cents) as a decimal string.
        amountCents: Math.round(Number(result.amount)),
        currency: result.currency as string,
        costBasis: "invoiced",
        sourceRef: `cost:${day}:${workspace}:${result.description}`,
      });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Phase: claude_code (analytics -> usage_metrics, never spend facts)

interface ClaudeCodeOut {
  identities: IdentityInput[];
  metrics: MetricInput[];
}

function claudeCodeRows(label: string, body: unknown, state: AnthropicCursor): ClaudeCodeOut & {
  hasMore: boolean;
  nextPage: string | null;
} {
  const env = parseReportEnvelope(label, body);
  const identities: IdentityInput[] = [];
  const metrics: MetricInput[] = [];
  const emailToUserId = new Map(
    Object.entries(state.users).map(([id, email]) => [email.toLowerCase(), id]),
  );

  for (const raw of env.data) {
    const record = parseStrict("anthropic claude code record", raw, {
      actor: isObj,
      core_metrics: isObj,
      customer_type: (v) => v === "api" || v === "subscription",
      date: (v) => typeof v === "string" && DAY_OR_MIDNIGHT_RE.test(v),
      model_breakdown: isArr,
      organization_id: nonEmptyStr,
      terminal_type: strOrNull,
      tool_actions: isObj,
    }, {
      subscription_type: strOrNull,
    });
    const day = (record.date as string).slice(0, 10);

    // Actor -> identity. User actors carry an email; api actors carry the
    // KEY NAME (not id) - resolved through the api_keys phase map. Unknown
    // actors still get an identity row so auto-map/Resolve can attach them.
    const actor = record.actor as Record<string, unknown>;
    let identity: MetricInput["identity"];
    let actorKey: string;
    if (actor.type === "user_actor") {
      const { email_address: email } = parseStrict("anthropic claude code actor", actor, {
        email_address: nonEmptyStr,
        type: literal("user_actor"),
      }) as { email_address: string };
      const userId = emailToUserId.get(email.toLowerCase());
      const externalId = userId ?? email.toLowerCase();
      identity = { externalId, kind: "user" };
      actorKey = email.toLowerCase();
      // A subscription actor is a flat-seat holder - stamp the tier on the
      // identity so the seat can be detected and its usage scoped as usage
      // value. customer_type='api' rides its API key, so leave it unmarked.
      const subscriptionType =
        record.customer_type === "subscription"
          ? ((record.subscription_type as string | null) ?? "subscription")
          : undefined;
      // Emit the identity when it is new to us (so Resolve can attach it) or
      // when we learned a subscription tier to stamp on an existing one.
      if (!userId || subscriptionType !== undefined) {
        identities.push({
          externalId,
          kind: "user",
          email,
          ...(subscriptionType !== undefined ? { subscriptionType } : {}),
        });
      }
    } else {
      const { api_key_name: keyName } = parseStrict("anthropic claude code actor", actor, {
        api_key_name: nonEmptyStr,
        type: literal("api_actor"),
      }) as { api_key_name: string };
      const keyId = state.keys[keyName.toLowerCase()];
      if (keyId) {
        identity = { externalId: keyId, kind: "api_key" };
      } else {
        identity = { externalId: keyName, kind: "api_key" };
        identities.push({
          externalId: keyName,
          kind: "api_key",
          displayName: keyName,
          tags: [keyName],
        });
      }
      actorKey = `key:${keyName.toLowerCase()}`;
    }

    const core = parseStrict("anthropic claude code core_metrics", record.core_metrics, {
      commits_by_claude_code: isInt,
      lines_of_code: isObj,
      num_sessions: isInt,
      pull_requests_by_claude_code: isInt,
    });
    const lines = parseStrict("anthropic claude code lines_of_code", core.lines_of_code, {
      added: isInt,
      removed: isInt,
    });

    let accepted = 0;
    let rejected = 0;
    for (const [tool, rawAction] of Object.entries(record.tool_actions as object)) {
      const action = parseStrict(`anthropic claude code tool_actions.${tool}`, rawAction, {
        accepted: isInt,
        rejected: isInt,
      });
      accepted += action.accepted as number;
      rejected += action.rejected as number;
    }

    let tokens = 0;
    let estimatedCents = 0;
    for (const rawModel of record.model_breakdown as unknown[]) {
      const breakdown = parseStrict("anthropic claude code model_breakdown", rawModel, {
        estimated_cost: isObj,
        model: nonEmptyStr,
        tokens: isObj,
      });
      const cost = parseStrict("anthropic claude code estimated_cost", breakdown.estimated_cost, {
        // Minor currency units (cents). The docs type this "number", not
        // integer - estimates can carry fractional cents, so accept floats
        // and round once after summing.
        amount: isNum,
        currency: literal("USD"),
      });
      const counts = parseStrict("anthropic claude code tokens", breakdown.tokens, {
        cache_creation: isInt,
        cache_read: isInt,
        input: isInt,
        output: isInt,
      });
      estimatedCents += cost.amount as number;
      tokens +=
        (counts.input as number) +
        (counts.output as number) +
        (counts.cache_creation as number) +
        (counts.cache_read as number);
    }

    // terminal_type is part of the record's natural key: the same person
    // can show up once per terminal per day.
    const sourceRef = `cc:${day}:${actorKey}:${record.terminal_type ?? "unknown"}`;
    const counters: Record<string, number> = {
      sessions: core.num_sessions as number,
      commits: core.commits_by_claude_code as number,
      pull_requests: core.pull_requests_by_claude_code as number,
      lines_added: lines.added as number,
      lines_removed: lines.removed as number,
      tool_actions_accepted: accepted,
      tool_actions_rejected: rejected,
      tokens,
      estimated_cost_cents: Math.round(estimatedCents),
    };
    for (const [metric, value] of Object.entries(counters)) {
      metrics.push({ day, identity, metric, value, sourceRef });
    }
  }

  return { identities, metrics, hasMore: env.hasMore, nextPage: env.nextPage };
}

// ---------------------------------------------------------------------------
// The connector

function parseCursorToken(token: string | null): AnthropicCursor {
  if (token === null) return INITIAL_CURSOR;
  return JSON.parse(token) as AnthropicCursor;
}

function tokenFor(cursor: AnthropicCursor): string {
  return JSON.stringify(cursor);
}

export const anthropicConnector: Connector = {
  vendor: "anthropic",
  displayName: "Anthropic",
  historyLimitDays: ANTHROPIC_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Needs an Admin API key (sk-ant-admin..., created by an organization admin in the Anthropic Console).",
    "Anthropic reports raw API spend per API key and workspace only, never per user. Per-employee spend = one key per person; keys auto-map to the person who created them.",
    "There is no key-creation API. Each person creates their own key in the Anthropic Console - the next sync auto-detects it and maps it to its creator.",
    "Per-key dollars are token counts priced with the pinned model price table, marked estimated. Non-token charges (web search, code execution, session usage) come from the cost report as invoiced, unassigned spend.",
    "Claude Code analytics (sessions, commits, PRs, accept rates, cost) are stored as per-user metrics, not spend - API-billed Claude Code dollars already appear under the key that ran them.",
  ],
  configFields: [{ key: "adminKey", label: "Admin API key", secret: true }],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    // The Admin API has no scope granularity: a valid sk-ant-admin key
    // grants the whole surface. /v1/organizations/me both authenticates the
    // key and proves it is an admin key (vendor 401 surfaces verbatim).
    const body = await anthropicJson(ctx, `${ANTHROPIC_BASE}/v1/organizations/me`);
    parseStrict("anthropic /v1/organizations/me response", body, {
      id: nonEmptyStr,
      name: nonEmptyStr,
      type: literal("organization"),
    });
    return { scopes: ["admin_api"] };
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const state = parseCursorToken(pageToken);

    switch (state.phase) {
      case "users": {
        const env = parseListEnvelope(
          "anthropic /v1/organizations/users response",
          await anthropicJson(ctx, usersUrl(state.cursor)),
        );
        const users = { ...state.users };
        const identities: IdentityInput[] = env.data.map((raw) => {
          const user = parseUser(raw);
          users[user.id] = user.email;
          return {
            externalId: user.id,
            kind: "user",
            email: user.email,
            displayName: user.name ?? undefined,
          };
        });
        const next: AnthropicCursor = env.hasMore
          ? { ...state, cursor: env.lastId, users }
          : { ...state, phase: "api_keys", cursor: null, users };
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "api_keys": {
        const env = parseListEnvelope(
          "anthropic /v1/organizations/api_keys response",
          await anthropicJson(ctx, apiKeysUrl(state.cursor)),
        );
        const keys = { ...state.keys };
        const identities: IdentityInput[] = env.data.map((raw) => {
          const key = parseApiKey(raw);
          keys[key.name.toLowerCase()] = key.id;
          return {
            externalId: key.id,
            kind: "api_key",
            displayName: key.name,
            // Key names become tags (spec 7b); a rename re-tags history.
            tags: [key.name],
            // created_by -> the creator's email = the auto-map (spec 5).
            // Unknown creators (removed users) stay unmapped -> Resolve.
            email: state.users[key.createdById],
          };
        });
        const next: AnthropicCursor = env.hasMore
          ? { ...state, cursor: env.lastId, keys }
          : { ...state, phase: "usage", cursor: null, keys };
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "usage": {
        const body = await anthropicJson(ctx, usageUrl(window, state.cursor));
        const env = parseReportEnvelope("anthropic usage report response", body);
        const facts = usageFacts("anthropic usage report response", body);
        const next: AnthropicCursor = env.hasMore
          ? { ...state, cursor: env.nextPage }
          : { ...state, phase: "cost", cursor: null };
        return { identities: [], facts, nextPageToken: tokenFor(next) };
      }

      case "cost": {
        const body = await anthropicJson(ctx, costUrl(window, state.cursor));
        const env = parseReportEnvelope("anthropic cost report response", body);
        const facts = costFacts("anthropic cost report response", body);
        const next: AnthropicCursor = env.hasMore
          ? { ...state, cursor: env.nextPage }
          : { ...state, phase: "claude_code", cursor: null, day: window.since };
        return { identities: [], facts, nextPageToken: tokenFor(next) };
      }

      case "claude_code": {
        const day = state.day;
        if (!day) throw new Error("anthropic claude_code phase lost its day cursor");
        const out = claudeCodeRows(
          "anthropic claude code report response",
          await anthropicJson(ctx, claudeCodeUrl(day, state.cursor)),
          state,
        );
        let nextPageToken: string | null;
        if (out.hasMore) {
          nextPageToken = tokenFor({ ...state, cursor: out.nextPage });
        } else if (day < window.until) {
          nextPageToken = tokenFor({ ...state, cursor: null, day: addDays(day, 1) });
        } else {
          nextPageToken = null; // window complete
        }
        return {
          identities: out.identities,
          facts: [],
          metrics: out.metrics,
          nextPageToken,
        };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Write operations (spec 8 people in/out). NOT part of sync - the connector
// itself only ever reads - but they live here because they share the vendor
// auth, base URL, and verbatim-error convention. Write responses feed no
// ledger numbers, so they are parsed picked, not strict: only the fields we
// consume are checked. There is NO key-creation API (spec 5/8): people mint
// keys in the Console and the next sync auto-detects them via created_by.

export function invitesWriteUrl(): string {
  return `${ANTHROPIC_BASE}/v1/organizations/invites`;
}

export function deleteUserUrl(userId: string): string {
  return `${ANTHROPIC_BASE}/v1/organizations/users/${encodeURIComponent(userId)}`;
}

export function updateApiKeyUrl(keyId: string): string {
  return `${ANTHROPIC_BASE}/v1/organizations/api_keys/${encodeURIComponent(keyId)}`;
}

/** Invite an email into the Anthropic organization as a user. */
export async function inviteAnthropicUser(
  ctx: ConnectorContext,
  email: string,
): Promise<{ inviteId: string }> {
  const body = await anthropicJson(ctx, invitesWriteUrl(), {
    method: "POST",
    body: { email, role: "user" },
  });
  const invite = parsePicked("anthropic invite response", body, {
    type: literal("invite"),
    id: nonEmptyStr,
  });
  return { inviteId: invite.id as string };
}

/** Remove a user from the Anthropic organization (their org seat). */
export async function deleteAnthropicUser(
  ctx: ConnectorContext,
  userId: string,
): Promise<void> {
  const body = await anthropicJson(ctx, deleteUserUrl(userId), { method: "DELETE" });
  parsePicked("anthropic user delete response", body, {
    type: literal("user_deleted"),
    id: nonEmptyStr,
  });
}

/**
 * Archive an API key - Anthropic has no key-delete API; archived is the
 * vendor's terminal "disabled" state and the strongest removal it offers.
 */
export async function archiveAnthropicApiKey(
  ctx: ConnectorContext,
  keyId: string,
): Promise<void> {
  const body = await anthropicJson(ctx, updateApiKeyUrl(keyId), {
    method: "POST",
    body: { status: "archived" },
  });
  const key = parsePicked("anthropic api key update response", body, {
    type: literal("api_key"),
    id: nonEmptyStr,
    status: nonEmptyStr,
  });
  if (key.status !== "archived") {
    throw new Error(
      `anthropic did not archive API key ${keyId} (status: ${String(key.status)})`,
    );
  }
}
