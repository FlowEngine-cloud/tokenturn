import { estimateOpenAiUsdCents } from "./openai-prices";
import { hasPinnedPrice } from "./prices";
import {
  intOrNull,
  isArr,
  isBool,
  isInt,
  isObj,
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
  ScopeCheck,
  SyncWindow,
} from "./types";

/**
 * OpenAI connector (spec 5 v1 row), built on the Admin API
 * (sk-admin... key, Authorization: Bearer).
 *
 * What one sync pulls, in phase order (the composite page token below walks
 * these phases one HTTP request per fetchPage, so every request commits and
 * resumes independently):
 *
 *   1. users     GET /v1/organization/users            - org members ->
 *      "user" identities (email drives auto-map to people).
 *   2. projects  GET /v1/organization/projects         - project ids only
 *      (archived included - their history still bills); they ride in the
 *      cursor so phase 3 can walk them.
 *   3. api_keys  GET /v1/organization/projects/{id}/api_keys per project ->
 *      "api_key" identities. The key NAME becomes its tag (spec 7b) and the
 *      key auto-maps to its owner's email. Service-account keys have no
 *      owner email and stay unmapped (Resolve can route them to a product).
 *   4. usage     GET /v1/organization/usage/completions
 *      grouped by user_id + api_key_id + model + batch, 1d buckets. OpenAI
 *      reports TOKENS here, so dollars are estimated from the pinned price
 *      table (cost_basis "estimated"; spec 5: "OpenAI costs have no user
 *      grouping. Per-user dollars = tokens x price table, marked
 *      estimated"). Attribution precedence: the user when the row has one
 *      (the human who spent), else the key (service/agent traffic - tag ->
 *      product routing), else the visible Unassigned bucket.
 *   5. costs     GET /v1/organization/costs
 *      grouped by project_id + line_item, 1d buckets - billed dollars, per
 *      project only. Token line items for pinned models ("GPT-5, input")
 *      are SKIPPED: that money is already on the ledger as per-user
 *      estimates from phase 4, and storing both would double count.
 *      Everything else (images, web search, embeddings and other usage we
 *      do not yet estimate per user) becomes invoiced, unassigned facts -
 *      real billed money the per-user token math cannot see.
 *
 * Not pulled yet: Codex per-user analytics (spec 5 - a later loop, mirrors
 * the Claude Code usage_metrics pattern) and the non-completions usage
 * endpoints (embeddings, images, audio, ...) - their dollars land per
 * project via phase 5 until a loop adds per-user estimation for them.
 *
 * Parsers are strict (unknown or missing fields throw) so a vendor format
 * change fails CI/sync with the drift verbatim instead of writing bad
 * numbers.
 */

export const OPENAI_BASE = "https://api.openai.com";
/**
 * The cost report serves at most 180 one-day buckets per request; backfill
 * is pinned to the same horizon.
 */
export const OPENAI_HISTORY_LIMIT_DAYS = 180;
const LIST_LIMIT = 100; // users / projects / api_keys page size (vendor max)
const USAGE_BUCKET_LIMIT = 31; // 1d buckets per usage response (vendor max)
const COST_BUCKET_LIMIT = 180; // 1d buckets per costs response (vendor max)
/** Fixed probe start (2024-01-01T00:00:00Z) keeps the connect-time scope check deterministic. */
const SCOPE_PROBE_START = 1_704_067_200;

/**
 * Composite page token: which phase the sync is in, the vendor cursor
 * inside that phase, and the project list phase 3 walks. It lives in
 * sync_runs.cursor via the framework, so a resume lands on the exact phase
 * and page that failed.
 */
interface OpenAiCursor {
  phase: "users" | "projects" | "api_keys" | "usage" | "costs";
  /** `after` id for list endpoints, page token for report endpoints. */
  cursor: string | null;
  /** Project ids accumulated by the projects phase, in listing order. */
  projects: string[];
  /** Index of the project whose keys the api_keys phase is listing. */
  projectIndex: number;
}

const INITIAL_CURSOR: OpenAiCursor = {
  phase: "users",
  cursor: null,
  projects: [],
  projectIndex: 0,
};

// ---------------------------------------------------------------------------
// HTTP

async function openaiJson(
  ctx: ConnectorContext,
  url: string,
  init?: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${ctx.config.adminKey ?? ""}`,
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
        : `openai returned HTTP ${res.status}`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// URLs (deterministic - the recorded-fixture harness matches them exactly)

export function usersUrl(after: string | null): string {
  return (
    `${OPENAI_BASE}/v1/organization/users?limit=${LIST_LIMIT}` +
    (after ? `&after=${encodeURIComponent(after)}` : "")
  );
}

export function projectsUrl(after: string | null): string {
  return (
    `${OPENAI_BASE}/v1/organization/projects?limit=${LIST_LIMIT}&include_archived=true` +
    (after ? `&after=${encodeURIComponent(after)}` : "")
  );
}

export function projectApiKeysUrl(projectId: string, after: string | null): string {
  return (
    `${OPENAI_BASE}/v1/organization/projects/${encodeURIComponent(projectId)}/api_keys` +
    `?limit=${LIST_LIMIT}` +
    (after ? `&after=${encodeURIComponent(after)}` : "")
  );
}

function unixSeconds(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

/** Inclusive day window -> half-open unix-seconds bucket range. */
function windowParams(window: SyncWindow): string {
  return `start_time=${unixSeconds(window.since)}&end_time=${unixSeconds(addDays(window.until, 1))}`;
}

export function usageUrl(window: SyncWindow, page: string | null): string {
  return (
    `${OPENAI_BASE}/v1/organization/usage/completions?${windowParams(window)}` +
    `&bucket_width=1d&group_by=user_id&group_by=api_key_id&group_by=model&group_by=batch` +
    `&limit=${USAGE_BUCKET_LIMIT}` +
    (page ? `&page=${encodeURIComponent(page)}` : "")
  );
}

export function costsUrl(window: SyncWindow, page: string | null): string {
  return (
    `${OPENAI_BASE}/v1/organization/costs?${windowParams(window)}` +
    `&bucket_width=1d&group_by=project_id&group_by=line_item&limit=${COST_BUCKET_LIMIT}` +
    (page ? `&page=${encodeURIComponent(page)}` : "")
  );
}

export function usersProbeUrl(): string {
  return `${OPENAI_BASE}/v1/organization/users?limit=1`;
}

export function costsProbeUrl(): string {
  return `${OPENAI_BASE}/v1/organization/costs?start_time=${SCOPE_PROBE_START}&limit=1`;
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
    object: literal("list"),
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

interface PageEnvelope {
  data: unknown[];
  hasMore: boolean;
  nextPage: string | null;
}

function parsePageEnvelope(label: string, body: unknown): PageEnvelope {
  const env = parseStrict(label, body, {
    object: literal("page"),
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

/** 1d buckets snap to UTC midnight; anything else is drift. */
function bucketDay(label: string, startTime: number): string {
  if (startTime % 86_400 !== 0) {
    throw new Error(`${label}: bucket boundary is not a UTC midnight: ${startTime}`);
  }
  return new Date(startTime * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Phase: users

function parseUser(raw: unknown): { id: string; email: string; name: string | null } {
  const user = parseStrict("openai user", raw, {
    object: literal("organization.user"),
    id: nonEmptyStr,
    name: strOrNull,
    email: nonEmptyStr,
    role: nonEmptyStr,
    added_at: isInt,
  });
  return {
    id: user.id as string,
    email: user.email as string,
    name: user.name as string | null,
  };
}

// ---------------------------------------------------------------------------
// Phase: projects

function parseProject(raw: unknown): { id: string; name: string; status: string } {
  const project = parseStrict("openai project", raw, {
    object: literal("organization.project"),
    id: nonEmptyStr,
    name: nonEmptyStr,
    created_at: isInt,
    archived_at: intOrNull,
    status: nonEmptyStr,
  });
  return {
    id: project.id as string,
    name: project.name as string,
    status: project.status as string,
  };
}

// ---------------------------------------------------------------------------
// Phase: api_keys

function parseApiKey(raw: unknown): {
  id: string;
  name: string | null;
  ownerEmail: string | undefined;
} {
  const key = parseStrict("openai api key", raw, {
    object: literal("organization.project.api_key"),
    id: nonEmptyStr,
    name: strOrNull,
    redacted_value: nonEmptyStr,
    created_at: isInt,
    last_used_at: intOrNull,
    owner: isObj,
  });
  const owner = parseStrict("openai api key owner", key.owner, {
    type: (v) => v === "user" || v === "service_account",
  }, {
    user: isObj,
    service_account: isObj,
  });
  let ownerEmail: string | undefined;
  if (owner.type === "user") {
    const user = parseStrict("openai api key owner user", owner.user, {
      object: literal("organization.project.user"),
      id: nonEmptyStr,
      name: strOrNull,
      email: nonEmptyStr,
      role: nonEmptyStr,
      added_at: isInt,
    });
    ownerEmail = user.email as string;
  } else {
    parseStrict("openai api key owner service account", owner.service_account, {
      object: literal("organization.project.service_account"),
      id: nonEmptyStr,
      name: strOrNull,
      role: nonEmptyStr,
      created_at: isInt,
    });
  }
  return {
    id: key.id as string,
    name: key.name as string | null,
    ownerEmail,
  };
}

// ---------------------------------------------------------------------------
// Phase: usage (usage/completions)

function parseUsageResult(raw: unknown): {
  userId: string | null;
  apiKeyId: string | null;
  model: string;
  input: number;
  cachedInput: number;
  output: number;
  audioInput: number;
  audioOutput: number;
  batch: boolean;
} {
  const result = parseStrict("openai usage result", raw, {
    object: literal("organization.usage.completions.result"),
    input_tokens: isInt,
    output_tokens: isInt,
    input_cached_tokens: isInt,
    input_audio_tokens: isInt,
    output_audio_tokens: isInt,
    num_model_requests: isInt,
    project_id: strOrNull,
    user_id: strOrNull,
    api_key_id: strOrNull,
    // We group by model and batch, so both must be present.
    model: nonEmptyStr,
    batch: isBool,
  }, {
    service_tier: strOrNull,
  });
  return {
    userId: result.user_id as string | null,
    apiKeyId: result.api_key_id as string | null,
    model: result.model as string,
    input: result.input_tokens as number,
    cachedInput: result.input_cached_tokens as number,
    output: result.output_tokens as number,
    audioInput: result.input_audio_tokens as number,
    audioOutput: result.output_audio_tokens as number,
    batch: result.batch as boolean,
  };
}

function usageFacts(label: string, body: unknown): FactInput[] {
  const facts: FactInput[] = [];
  const env = parsePageEnvelope(label, body);
  for (const rawBucket of env.data) {
    const bucket = parseStrict("openai usage bucket", rawBucket, {
      object: literal("bucket"),
      start_time: isInt,
      end_time: isInt,
      results: isArr,
    });
    const day = bucketDay("openai usage bucket", bucket.start_time as number);
    for (const raw of bucket.results as unknown[]) {
      const row = parseUsageResult(raw);
      // The user is the person who spent; keys cover service/agent traffic
      // (tag -> product routing); neither = visible Unassigned, never hidden.
      const identity = row.userId
        ? { externalId: row.userId, kind: "user" as const }
        : row.apiKeyId
          ? { externalId: row.apiKeyId, kind: "api_key" as const }
          : undefined;
      facts.push({
        day,
        identity,
        model: row.model,
        tokens: row.input + row.output + row.audioInput + row.audioOutput,
        // OpenAI reports tokens here, never dollars - priced from the
        // pinned table, marked estimated. Unknown models throw.
        amountCents: estimateOpenAiUsdCents(row.model, row),
        currency: "USD",
        costBasis: "estimated",
        sourceRef:
          `usage:${day}:${row.userId ?? "none"}:${row.apiKeyId ?? "none"}` +
          `:${row.model}:${row.batch ? "batch" : "live"}`,
      });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Phase: costs

/**
 * Token line items name a model plus a token type ("GPT-5, input",
 * "GPT-4o mini, cached input"). Returns the model id-ish prefix, or null
 * for non-token line items ("Image models", "Web search").
 */
const TOKEN_LINE_ITEM_RE =
  /^(.+?),\s*(cached input|audio input|audio output|input|output)(\s*\(batch\))?$/i;

function tokenLineItemModel(lineItem: string): string | null {
  const match = TOKEN_LINE_ITEM_RE.exec(lineItem);
  if (!match) return null;
  // Display names ("GPT-4o mini") -> pinned-table ids ("gpt-4o-mini").
  return match[1].trim().toLowerCase().replace(/\s+/g, "-");
}

function costFacts(label: string, body: unknown): FactInput[] {
  const facts: FactInput[] = [];
  const env = parsePageEnvelope(label, body);
  for (const rawBucket of env.data) {
    const bucket = parseStrict("openai cost bucket", rawBucket, {
      object: literal("bucket"),
      start_time: isInt,
      end_time: isInt,
      results: isArr,
    });
    const day = bucketDay("openai cost bucket", bucket.start_time as number);
    for (const raw of bucket.results as unknown[]) {
      const result = parseStrict("openai cost result", raw, {
        object: literal("organization.costs.result"),
        amount: isObj,
        line_item: strOrNull,
        project_id: strOrNull,
      }, {
        organization_id: strOrNull,
      });
      const amount = parseStrict("openai cost amount", result.amount, {
        value: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
        currency: nonEmptyStr,
      });
      const lineItem = result.line_item as string | null;
      // A pinned model's token money is already on the ledger as per-user
      // estimates (phase 4); storing the billed version too would double
      // count. Everything else is billed money with no per-user token trail
      // - keep it, invoiced, Unassigned, attributed to its project.
      if (lineItem !== null) {
        const model = tokenLineItemModel(lineItem);
        if (model !== null && hasPinnedPrice("openai", model)) continue;
      }
      const currency = (amount.currency as string).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error(`openai cost amount: invalid currency ${JSON.stringify(amount.currency)}`);
      }
      facts.push({
        day,
        // amount.value is dollars (decimal), not cents.
        amountCents: Math.round((amount.value as number) * 100),
        currency,
        costBasis: "invoiced",
        sourceRef: `cost:${day}:${(result.project_id as string | null) ?? "org"}:${lineItem ?? "total"}`,
      });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The connector

function parseCursorToken(token: string | null): OpenAiCursor {
  if (token === null) return INITIAL_CURSOR;
  return JSON.parse(token) as OpenAiCursor;
}

function tokenFor(cursor: OpenAiCursor): string {
  return JSON.stringify(cursor);
}

export const openaiConnector: Connector = {
  vendor: "openai",
  displayName: "OpenAI",
  historyLimitDays: OPENAI_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Needs an Admin API key (sk-admin-..., created by an organization owner in the OpenAI platform) with the read scopes api.management.read and api.usage.read.",
    "OpenAI's cost report groups dollars by project and line item only - it has no user grouping. Per-user dollars are token counts priced with the pinned model price table, always marked estimated.",
    "Token line items in the cost report are skipped for models we estimate - that money is already on the ledger per user; storing both would double count. Other line items (images, web search, embeddings, ...) are stored as invoiced, unassigned spend per project.",
    "API keys auto-map to their owner's email. Service-account keys have no owner email and surface in the Resolve queue, where they can be routed to a product instead of a person.",
  ],
  configFields: [{ key: "adminKey", label: "Admin API key", secret: true }],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    // Admin keys can be created with restricted read scopes. Probe the two
    // surfaces the sync needs - org management (users/projects/keys) and
    // usage/costs - so a missing scope rejects the connect with the
    // vendor's error verbatim instead of failing the first sync.
    parseListEnvelope(
      "openai /v1/organization/users response",
      await openaiJson(ctx, usersProbeUrl()),
    );
    parsePageEnvelope(
      "openai /v1/organization/costs response",
      await openaiJson(ctx, costsProbeUrl()),
    );
    return { scopes: ["api.management.read", "api.usage.read"] };
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
          "openai /v1/organization/users response",
          await openaiJson(ctx, usersUrl(state.cursor)),
        );
        const identities: IdentityInput[] = env.data.map((raw) => {
          const user = parseUser(raw);
          return {
            externalId: user.id,
            kind: "user",
            email: user.email,
            displayName: user.name ?? undefined,
          };
        });
        const next: OpenAiCursor = env.hasMore
          ? { ...state, cursor: env.lastId }
          : { ...state, phase: "projects", cursor: null };
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "projects": {
        const env = parseListEnvelope(
          "openai /v1/organization/projects response",
          await openaiJson(ctx, projectsUrl(state.cursor)),
        );
        const projects = [...state.projects, ...env.data.map((raw) => parseProject(raw).id)];
        let next: OpenAiCursor;
        if (env.hasMore) {
          next = { ...state, cursor: env.lastId, projects };
        } else if (projects.length === 0) {
          next = { ...state, phase: "usage", cursor: null, projects };
        } else {
          next = { ...state, phase: "api_keys", cursor: null, projects, projectIndex: 0 };
        }
        return { identities: [], facts: [], nextPageToken: tokenFor(next) };
      }

      case "api_keys": {
        const projectId = state.projects[state.projectIndex];
        if (!projectId) throw new Error("openai api_keys phase lost its project cursor");
        const env = parseListEnvelope(
          "openai project api_keys response",
          await openaiJson(ctx, projectApiKeysUrl(projectId, state.cursor)),
        );
        const identities: IdentityInput[] = env.data.map((raw) => {
          const key = parseApiKey(raw);
          return {
            externalId: key.id,
            kind: "api_key",
            displayName: key.name ?? undefined,
            // Key names become tags (spec 7b); a rename re-tags history.
            tags: key.name ? [key.name] : [],
            // owner email = the auto-map; service-account keys stay
            // unmapped -> Resolve.
            email: key.ownerEmail,
          };
        });
        let next: OpenAiCursor;
        if (env.hasMore) {
          next = { ...state, cursor: env.lastId };
        } else if (state.projectIndex + 1 < state.projects.length) {
          next = { ...state, cursor: null, projectIndex: state.projectIndex + 1 };
        } else {
          next = { ...state, phase: "usage", cursor: null };
        }
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "usage": {
        const body = await openaiJson(ctx, usageUrl(window, state.cursor));
        const env = parsePageEnvelope("openai usage report response", body);
        const facts = usageFacts("openai usage report response", body);
        const next: OpenAiCursor = env.hasMore
          ? { ...state, cursor: env.nextPage }
          : { ...state, phase: "costs", cursor: null };
        return { identities: [], facts, nextPageToken: tokenFor(next) };
      }

      case "costs": {
        const body = await openaiJson(ctx, costsUrl(window, state.cursor));
        const env = parsePageEnvelope("openai cost report response", body);
        const facts = costFacts("openai cost report response", body);
        return {
          identities: [],
          facts,
          nextPageToken: env.hasMore ? tokenFor({ ...state, cursor: env.nextPage }) : null,
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
// consume are checked.

export function invitesUrl(): string {
  return `${OPENAI_BASE}/v1/organization/invites`;
}

export function deleteUserUrl(userId: string): string {
  return `${OPENAI_BASE}/v1/organization/users/${encodeURIComponent(userId)}`;
}

export function serviceAccountsUrl(projectId: string): string {
  return `${OPENAI_BASE}/v1/organization/projects/${encodeURIComponent(projectId)}/service_accounts`;
}

export function deleteApiKeyUrl(projectId: string, keyId: string): string {
  return (
    `${OPENAI_BASE}/v1/organization/projects/${encodeURIComponent(projectId)}` +
    `/api_keys/${encodeURIComponent(keyId)}`
  );
}

/** Invite an email into the OpenAI organization as a reader. */
export async function inviteOpenAiUser(
  ctx: ConnectorContext,
  email: string,
): Promise<{ inviteId: string }> {
  const body = await openaiJson(ctx, invitesUrl(), {
    method: "POST",
    body: { email, role: "reader" },
  });
  const invite = parsePicked("openai invite response", body, {
    object: literal("organization.invite"),
    id: nonEmptyStr,
  });
  return { inviteId: invite.id as string };
}

/** Remove a user from the OpenAI organization (their org seat). */
export async function deleteOpenAiUser(
  ctx: ConnectorContext,
  userId: string,
): Promise<void> {
  const body = await openaiJson(ctx, deleteUserUrl(userId), { method: "DELETE" });
  const deleted = parsePicked("openai user delete response", body, {
    object: literal("organization.user.deleted"),
    id: nonEmptyStr,
    deleted: isBool,
  });
  if (deleted.deleted !== true) {
    throw new Error(`openai did not confirm deleting user ${userId}`);
  }
}

/** Active (non-archived) projects - the mint flow's project picker. */
export async function listOpenAiProjects(
  ctx: ConnectorContext,
): Promise<{ id: string; name: string }[]> {
  const projects: { id: string; name: string }[] = [];
  let after: string | null = null;
  do {
    const env = parseListEnvelope(
      "openai /v1/organization/projects response",
      await openaiJson(ctx, projectsUrl(after)),
    );
    for (const raw of env.data) {
      const project = parseProject(raw);
      if (project.status === "active") {
        projects.push({ id: project.id, name: project.name });
      }
    }
    after = env.hasMore ? env.lastId : null;
  } while (after !== null);
  return projects;
}

export interface MintedOpenAiKey {
  /** The plaintext API key - shown once, never saved (spec 8). */
  apiKey: string;
  /** The key's vendor id - what usage rows attribute to. */
  keyId: string;
  serviceAccountId: string;
  projectId: string;
  name: string;
}

/**
 * Mint an API key (spec 8: "OpenAI minted via API and shown once, never
 * saved"). OpenAI's Admin API creates keys through project service
 * accounts: the create response carries the key's plaintext value exactly
 * once. The caller maps the key to its person and shows the value once -
 * nothing here stores or logs it.
 */
export async function mintOpenAiKey(
  ctx: ConnectorContext,
  projectId: string,
  name: string,
): Promise<MintedOpenAiKey> {
  const body = await openaiJson(ctx, serviceAccountsUrl(projectId), {
    method: "POST",
    body: { name },
  });
  const account = parsePicked("openai service account response", body, {
    object: literal("organization.project.service_account"),
    id: nonEmptyStr,
    name: nonEmptyStr,
    api_key: isObj,
  });
  const key = parsePicked("openai service account api key", account.api_key, {
    object: literal("organization.project.service_account.api_key"),
    id: nonEmptyStr,
    value: nonEmptyStr,
  });
  return {
    apiKey: key.value as string,
    keyId: key.id as string,
    serviceAccountId: account.id as string,
    projectId,
    name: account.name as string,
  };
}

/**
 * Delete an API key. The delete endpoint is project-scoped but identities
 * only carry the key id, so this walks the org's projects (archived
 * included - their keys can still bill) to locate the key first.
 */
export async function deleteOpenAiApiKey(
  ctx: ConnectorContext,
  keyId: string,
): Promise<void> {
  let projectAfter: string | null = null;
  do {
    const projectEnv = parseListEnvelope(
      "openai /v1/organization/projects response",
      await openaiJson(ctx, projectsUrl(projectAfter)),
    );
    for (const rawProject of projectEnv.data) {
      const project = parseProject(rawProject);
      let keyAfter: string | null = null;
      do {
        const keyEnv = parseListEnvelope(
          "openai project api_keys response",
          await openaiJson(ctx, projectApiKeysUrl(project.id, keyAfter)),
        );
        for (const rawKey of keyEnv.data) {
          if (parseApiKey(rawKey).id !== keyId) continue;
          const body = await openaiJson(ctx, deleteApiKeyUrl(project.id, keyId), {
            method: "DELETE",
          });
          const deleted = parsePicked("openai api key delete response", body, {
            object: literal("organization.project.api_key.deleted"),
            id: nonEmptyStr,
            deleted: isBool,
          });
          if (deleted.deleted !== true) {
            throw new Error(`openai did not confirm deleting API key ${keyId}`);
          }
          return;
        }
        keyAfter = keyEnv.hasMore ? keyEnv.lastId : null;
      } while (keyAfter !== null);
    }
    projectAfter = projectEnv.hasMore ? projectEnv.lastId : null;
  } while (projectAfter !== null);
  throw new Error(
    `API key ${keyId} was not found in any OpenAI project - it may already be deleted`,
  );
}
