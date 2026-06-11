import {
  isArr,
  isBool,
  isInt,
  isNum,
  isObj,
  isStr,
  nonEmptyStr,
  parsePicked,
  parseStrict,
  strOrNull,
} from "./strict";
import { addDays, chunkWindows } from "./sync";
import type {
  Connector,
  ConnectorContext,
  ConnectorPage,
  FactInput,
  IdentityInput,
  MetricInput,
  OutcomeInput,
  RevertInput,
  ScopeCheck,
  SyncWindow,
} from "./types";

/**
 * GitHub connector (spec 5 v1 row): Copilot per-user usage + AI Credits
 * billing, and merged PRs with AI authorship + revert detection - the
 * outcome source. Classic PAT, Bearer auth, API version pinned via the
 * X-GitHub-Api-Version header. Enterprise-owned orgs read billing through
 * the enterprise API and need an enterprise owner's classic PAT with
 * admin:enterprise (spec 5 vendor limits - stated on the connect screen).
 *
 * What one sync pulls, in phase order (one composite page token, one HTTP
 * request per fetchPage, so every request commits and resumes
 * independently):
 *
 *   1. seats    GET /orgs/{org}/copilot/billing/seats - the Copilot roster.
 *      Each assignee becomes a "user" identity (numeric GitHub id; public
 *      email, when set, drives auto-map) plus a "seat" identity (the thing
 *      offboarding removes). The login->id map rides in the cursor for the
 *      billing phase.
 *   2. credits  GET .../settings/billing/ai_credit/usage - the money.
 *      GitHub reports AI-credit dollars per (sku, model) aggregate, with a
 *      `user` filter but NO per-user breakdown in one call - so per-user
 *      dollars cost one request per seat holder per calendar month. Facts
 *      land on the month's first day (cost_basis "invoiced", the vendor's
 *      netAmount): GitHub's finest per-user grain is the month, and money
 *      is never spread across days it wasn't reported for. The running
 *      month restates in place every sync; past months keep final values.
 *      Per month, the unfiltered org report is fetched first: its total is
 *      stored as the ai_credit_month_total_cents metric (invoice truth for
 *      drift display), months with a zero total skip the per-user walk, and
 *      whatever the per-user walk cannot attribute (spend by users no
 *      longer holding a seat) lands as a visible Unassigned remainder fact
 *      - never dropped (spec 4).
 *   3. daily    GET /orgs/{org}/copilot/metrics/reports/users-1-day - the
 *      per-user per-day usage counters (interactions, code generations /
 *      acceptances, lines, agent-mode use) -> usage_metrics, the Tools-page
 *      accept-rate inputs for Copilot. One report per day, served as
 *      signed NDJSON download links (fetched unauthenticated). A day with
 *      no processed report answers 404 - notably today's, generated only
 *      after the day closes - and is skipped; the trailing re-pull picks it
 *      up once it exists. Capped to the trailing METRICS_REPORT_DAYS (28)
 *      of the window - the span of GitHub's own aggregate reporting;
 *      counters are not money.
 *   4. prs      GET /search/issues q=org is:pr is:merged merged:a..b - the
 *      merged-PR list, in 30-day chunks (the search result cap is per
 *      query; >1000 hits in one chunk throws rather than silently dropping
 *      outcomes). Items only enqueue refs - the detail phase is the record
 *      of truth.
 *   5. pr       GET /repos/{o}/{r}/pulls/{n} + /pulls/{n}/commits - two
 *      requests per merged PR. Each merged PR becomes one outcome (kind
 *      "github_pr", counts on merge - spec 5): the human author is
 *      credited via their "user" identity; AI authorship is detected from
 *      bot authors (Copilot agent, Devin, ...) and commit co-author
 *      trailers (Claude, Copilot, Cursor, Devin, Codex) into tools[]. Bot
 *      authors are never people: their outcomes stay unattributed, and
 *      unknown bots (dependabot) are never claimed as AI. The PR's merge +
 *      head commit shas are stored on the outcome so later reverts can find
 *      it. Reverts are read from the same records: "Reverts owner/repo#N"
 *      in a merged PR's body, and "This reverts commit <sha>" in its commit
 *      messages (full 40-char shas only - what git revert writes; short
 *      shas cannot be matched exactly and are skipped). The framework flips
 *      the target when the revert lands within revert_window_days
 *      (Settings, default 30); after the window the outcome is final.
 *      Detection is revert commits/PRs only, never line-level survival.
 *
 * Vendor-truth notes:
 * - Copilot seat FEES are not reported per user by any API and are never
 *   invented or amortized (spec 5); what lands on people is AI-credit
 *   spend. The monthly invoice import trues the rest.
 * - GitHub objects are huge and contractually additive within a pinned API
 *   version, so parsing here picks the consumed fields strictly
 *   (parsePicked) instead of pinning whole shapes; the small, new billing
 *   and report payloads are pinned in full (parseStrict), and every
 *   cross-checkable echo (timePeriod, report_day, PR number) is verified.
 * - The billing report serves 24 months, but backfill is pinned to 90 days
 *   to keep a first sync bounded; PR search has no depth limit and uses
 *   the same window.
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_HISTORY_LIMIT_DAYS = 90;
/** Per-user daily usage reports: trailing days pulled (GitHub's own
 * aggregate reporting spans 28 days; older 1-day reports are not relied on). */
export const METRICS_REPORT_DAYS = 28;
/** Search chunk size; one chunk must stay under the 1000-result search cap. */
export const SEARCH_CHUNK_DAYS = 30;
const SEATS_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 100;
const COMMITS_PAGE_SIZE = 100;
const SEARCH_RESULT_CAP = 1000;
/** Fixed probe period keeps the connect-time scope check deterministic. */
const PROBE_YEAR = 2026;
const PROBE_MONTH = 1;

const TOTAL_METRIC = "ai_credit_month_total_cents";
const OUTCOME_KIND = "github_pr";

/**
 * AI authorship detection (spec 5: bot authors, co-author trailers). The
 * tool names line up with the spend connectors so the Tools page can put
 * $/merge, accept rate, and revert rate side by side per tool.
 */
export const AI_BOT_AUTHORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^copilot(-swe-agent)?(\[bot\])?$/i, "copilot"],
  [/^devin-ai-integration\[bot\]$/i, "devin"],
  [/^cursor(-agent)?\[bot\]$/i, "cursor"],
  [/^claude(\[bot\])?$/i, "claude_code"],
  [/^(openai-)?codex(\[bot\])?$/i, "codex"],
];

/** Match a "Co-authored-by: Name <email>" trailer to a tool, or null (human). */
export function coAuthorTool(name: string, email: string): string | null {
  const e = email.toLowerCase();
  const n = name.toLowerCase();
  if (e.endsWith("@anthropic.com") || n.startsWith("claude")) return "claude_code";
  if (n === "copilot" || e.includes("copilot@users.noreply.github.com")) return "copilot";
  if (e.endsWith("@cursor.com") || n === "cursor agent") return "cursor";
  if (e.includes("devin-ai-integration") || n.startsWith("devin")) return "devin";
  if (e.endsWith("@openai.com") || n === "codex" || n === "chatgpt") return "codex";
  return null;
}

const REVERTS_REF_RE = /\breverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
const REVERTS_SHA_RE = /\bthis reverts commit ([0-9a-f]{40})\b/gi;
const CO_AUTHOR_RE = /^co-authored-by:\s*([^<]*?)\s*<([^>]*)>\s*$/gim;

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** A PR mid-detail: pulls/{n} parsed, commits pages being walked. */
interface PrProgress {
  /** merged_at - the outcome's ts (a PR counts on merge). */
  ts: string;
  /** Human author (numeric id as string + login); null for bot authors. */
  author: { id: string; login: string } | null;
  /** Tools detected so far (bot author + co-author trailers). */
  tools: string[];
  /** Merge commit sha + head commit shas seen so far. */
  shas: string[];
  /** Revert targets named in the PR body ("Reverts owner/repo#N"). */
  revertRefs: string[];
  /** Full shas named in commit messages ("This reverts commit <sha>"). */
  revertShas: string[];
  /** Commits page being fetched (1-based). */
  page: number;
}

/**
 * Composite page token: the phase, the vendor page inside it, and the
 * walk state of each phase. It lives in sync_runs.cursor via the
 * framework, so a resume lands on the exact phase, request, and PR that
 * failed.
 */
interface GithubCursor {
  phase: "seats" | "credits" | "daily" | "prs" | "pr";
  /** Vendor page within the phase (seats / search / commits). */
  page: number;
  /** 30-day search chunk index. */
  chunk: number;
  /** login -> numeric GitHub user id (as a string), from the seats roster. */
  users: Record<string, string>;
  /** credits walk: month index, user index (-1 = org total), running sums. */
  credits?: { month: number; user: number; orgCents: number; attributedCents: number };
  /** daily walk: the day being fetched + report links still to download. */
  daily?: { day: string; links: string[] };
  /** merged PRs ("owner/repo#n") awaiting their detail + commits requests. */
  queue?: string[];
  current?: PrProgress;
}

const INITIAL_CURSOR: GithubCursor = { phase: "seats", page: 1, chunk: 0, users: {} };

// ---------------------------------------------------------------------------
// HTTP

type GhConfig = Record<string, string>;

/** A GitHub error carrying its HTTP status, so callers (the survival job)
 * can tell gone-forever (404) from try-again-later. Message stays the
 * vendor's, verbatim (spec 5). */
export class GhHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GhHttpError";
  }
}

export async function ghJson(
  ctx: ConnectorContext,
  url: string,
  init?: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${ctx.config.token ?? ""}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    const message =
      isObj(body) && typeof (body as Record<string, unknown>).message === "string"
        ? ((body as Record<string, unknown>).message as string)
        : `github returned HTTP ${res.status}`;
    throw new GhHttpError(message, res.status);
  }
  return body;
}

/** A file's raw text at a ref; null when it no longer exists there (404 -
 * for survival that means the lines are dead, not an error). */
export async function ghFileTextOrNull(
  ctx: ConnectorContext,
  url: string,
): Promise<string | null> {
  const res = await ctx.fetch(url, {
    headers: {
      authorization: `Bearer ${ctx.config.token ?? ""}`,
      accept: "application/vnd.github.raw+json",
      "x-github-api-version": GITHUB_API_VERSION,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GhHttpError(`github contents returned HTTP ${res.status}`, res.status);
  }
  return res.text();
}

/** Report blobs are presigned URLs - fetched without auth, as raw NDJSON. */
async function ghText(ctx: ConnectorContext, url: string): Promise<string> {
  const res = await ctx.fetch(url);
  if (!res.ok) {
    throw new Error(`github usage report download returned HTTP ${res.status}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Requests (deterministic - the recorded-fixture harness matches the full
// URL, so window/month/page math is pinned by recordings)

export function seatsRequest(org: string, page: number): string {
  return `${GITHUB_API}/orgs/${org}/copilot/billing/seats?page=${page}&per_page=${SEATS_PAGE_SIZE}`;
}

export function seatsProbeRequest(org: string): string {
  return `${GITHUB_API}/orgs/${org}/copilot/billing/seats?page=1&per_page=1`;
}

/**
 * The AI-credit usage report for one calendar month, optionally filtered to
 * one user. Enterprise-owned orgs read it through the enterprise API
 * (admin:enterprise classic PAT), filtered to the org.
 */
export function creditsRequest(config: GhConfig, month: string, user: string | null): string {
  const [year, m] = month.split("-");
  const base = config.enterprise
    ? `${GITHUB_API}/enterprises/${config.enterprise}/settings/billing/ai_credit/usage` +
      `?year=${year}&month=${Number(m)}&organization=${config.org}`
    : `${GITHUB_API}/organizations/${config.org}/settings/billing/ai_credit/usage` +
      `?year=${year}&month=${Number(m)}`;
  return user === null ? base : `${base}&user=${encodeURIComponent(user)}`;
}

export function creditsProbeRequest(config: GhConfig): string {
  return creditsRequest(config, `${PROBE_YEAR}-${String(PROBE_MONTH).padStart(2, "0")}`, null);
}

export function dailyReportRequest(org: string, day: string): string {
  return `${GITHUB_API}/orgs/${org}/copilot/metrics/reports/users-1-day?day=${day}`;
}

export function searchRequest(org: string, chunk: SyncWindow, page: number): string {
  const q = encodeURIComponent(
    `org:${org} is:pr is:merged merged:${chunk.since}..${chunk.until}`,
  );
  return `${GITHUB_API}/search/issues?q=${q}&sort=created&order=asc&per_page=${SEARCH_PAGE_SIZE}&page=${page}`;
}

export function searchProbeRequest(org: string): string {
  const q = encodeURIComponent(`org:${org} is:pr is:merged`);
  return `${GITHUB_API}/search/issues?q=${q}&per_page=1`;
}

export function prRequest(ref: string): string {
  const { owner, repo, number } = refParts(ref);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
}

export function prCommitsRequest(ref: string, page: number): string {
  const { owner, repo, number } = refParts(ref);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/commits?per_page=${COMMITS_PAGE_SIZE}&page=${page}`;
}

// Survival-job requests (src/lib/survival.ts) - kept here with the other
// URL builders so the fixture harness pins them the same way.

export const FILES_PAGE_SIZE = 100;

export function prFilesRequest(ref: string, page: number): string {
  const { owner, repo, number } = refParts(ref);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`;
}

/** The last commit on a branch at or before an instant - the repo as it
 * stood at the survival horizon. */
export function commitAtRequest(ref: string, branch: string, until: string): string {
  const { owner, repo } = refParts(ref);
  return (
    `${GITHUB_API}/repos/${owner}/${repo}/commits` +
    `?sha=${encodeURIComponent(branch)}&until=${encodeURIComponent(until)}&per_page=1`
  );
}

export function contentsRequest(ref: string, filePath: string, sha: string): string {
  const { owner, repo } = refParts(ref);
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API}/repos/${owner}/${repo}/contents/${encoded}?ref=${sha}`;
}

function refParts(ref: string): PrRef {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!match) throw new Error(`bad PR ref ${JSON.stringify(ref)}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Calendar months ("YYYY-MM") the window overlaps, ascending. */
export function monthsBetween(window: SyncWindow): string[] {
  const out: string[] = [];
  let m = window.since.slice(0, 7);
  const last = window.until.slice(0, 7);
  while (m <= last) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  return out;
}

function monthDay(month: string): string {
  return `${month}-01`;
}

/** The trailing METRICS_REPORT_DAYS slice of the window, ascending. */
export function dailyDays(window: SyncWindow): string[] {
  const floor = addDays(window.until, -(METRICS_REPORT_DAYS - 1));
  let day = floor > window.since ? floor : window.since;
  const out: string[] = [];
  while (day <= window.until) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase: seats (Copilot roster -> user + seat identities)

function seatsPage(body: unknown): {
  identities: IdentityInput[];
  map: Record<string, string>;
  totalSeats: number;
} {
  const env = parsePicked("github copilot seats response", body, {
    total_seats: isInt,
    seats: isArr,
  });
  const identities: IdentityInput[] = [];
  const map: Record<string, string> = {};
  for (const raw of env.seats as unknown[]) {
    const seat = parsePicked("github copilot seat", raw, { assignee: isObj });
    const assignee = parsePicked("github copilot seat assignee", seat.assignee, {
      id: isInt,
      login: nonEmptyStr,
    }, {
      email: strOrNull,
      name: strOrNull,
      type: isStr,
    });
    const id = String(assignee.id);
    const login = assignee.login as string;
    const email = (assignee.email as string | null | undefined) ?? undefined;
    // The person, keyed on GitHub's stable numeric id (logins can change);
    // a public email auto-maps, the rest goes to Resolve.
    identities.push({ externalId: id, kind: "user", email, displayName: login });
    // The Copilot seat itself - what offboarding removes (spec 8).
    identities.push({
      externalId: id,
      kind: "seat",
      email,
      displayName: login,
      tags: ["copilot"],
    });
    map[login] = id;
  }
  return { identities, map, totalSeats: env.total_seats as number };
}

// ---------------------------------------------------------------------------
// Phase: credits (AI-credit dollars: org month total + per-user facts)

/**
 * Parse one AI-credit usage report. Items are (product, sku, model)
 * aggregates; netAmount is what GitHub bills after discounts, in dollars.
 */
function creditItems(
  body: unknown,
  month: string,
  userId?: string,
): { cents: number; facts: FactInput[] } {
  const env = parsePicked("github ai-credit usage response", body, {
    timePeriod: isObj,
    usageItems: isArr,
  });
  const period = parseStrict("github ai-credit usage timePeriod", env.timePeriod, {
    year: isInt,
  }, {
    month: isInt,
    day: isInt,
  });
  const [year, m] = month.split("-").map(Number);
  if (period.year !== year || period.month !== m) {
    throw new Error(
      `github ai-credit usage: timePeriod ${period.year}-${period.month} is not the requested month ${month}`,
    );
  }

  const day = monthDay(month);
  const seen = new Set<string>();
  const facts: FactInput[] = [];
  let cents = 0;
  for (const raw of env.usageItems as unknown[]) {
    const item = parseStrict("github ai-credit usage item", raw, {
      product: nonEmptyStr,
      sku: nonEmptyStr,
      model: nonEmptyStr,
      unitType: nonEmptyStr,
      pricePerUnit: isNum,
      grossQuantity: isNum,
      grossAmount: isNum,
      discountQuantity: isNum,
      discountAmount: isNum,
      netQuantity: isNum,
      netAmount: isNum,
    });
    // What GitHub bills (post-discount), rounded to cents per item.
    const amountCents = Math.round((item.netAmount as number) * 100);
    cents += amountCents;
    if (userId === undefined) continue; // org total: metric only, never facts

    const sourceRef = `ai_credit:${month}:${userId}:${item.sku}:${item.model}`;
    if (seen.has(sourceRef)) {
      // The report aggregates by (sku, model); a duplicate means that
      // assumption broke - failing beats silently overwriting money.
      throw new Error(`github ai-credit usage: duplicate item ${sourceRef}`);
    }
    seen.add(sourceRef);
    facts.push({
      day,
      identity: { externalId: userId, kind: "user" },
      model: item.model as string,
      amountCents,
      currency: "USD",
      costBasis: "invoiced",
      sourceRef,
    });
  }
  return { cents, facts };
}

/** The month's unattributed remainder - visible Unassigned, never dropped. */
function remainderFact(month: string, cents: number): FactInput {
  return {
    day: monthDay(month),
    amountCents: cents,
    currency: "USD",
    costBasis: "invoiced",
    sourceRef: `ai_credit:${month}:unassigned`,
  };
}

// ---------------------------------------------------------------------------
// Phase: daily (per-user Copilot usage counters -> usage_metrics)

/** NDJSON field -> stored metric name. All integer counters, never money. */
const DAILY_METRIC_FIELDS: Record<string, string> = {
  user_initiated_interaction_count: "interactions",
  code_generation_activity_count: "code_generations",
  code_acceptance_activity_count: "code_acceptances",
  loc_suggested_to_add_sum: "loc_suggested_to_add",
  loc_added_sum: "loc_added",
  chat_panel_agent_mode: "agent_mode_interactions",
};

function reportLinks(body: unknown, day: string): string[] {
  const env = parseStrict("github copilot usage report", body, {
    download_links: isArr,
    report_day: nonEmptyStr,
  });
  if (env.report_day !== day) {
    throw new Error(
      `github copilot usage report: report_day ${env.report_day} is not the requested day ${day}`,
    );
  }
  const links = env.download_links as unknown[];
  for (const link of links) {
    if (typeof link !== "string" || link.length === 0) {
      throw new Error("github copilot usage report: invalid download link");
    }
  }
  return links as string[];
}

function usageRows(text: string, day: string): {
  identities: IdentityInput[];
  metrics: MetricInput[];
} {
  const identities = new Map<string, IdentityInput>();
  const metrics: MetricInput[] = [];
  const counterChecks = Object.fromEntries(
    Object.keys(DAILY_METRIC_FIELDS).map((field) => [field, isInt]),
  );
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`github copilot usage report line is not JSON: ${line.slice(0, 120)}`);
    }
    const row = parsePicked("github copilot usage row", raw, {
      user_id: isInt,
      user_login: nonEmptyStr,
      day: nonEmptyStr,
    }, counterChecks);
    if (row.day !== day) {
      throw new Error(
        `github copilot usage row: day ${row.day} is not the report day ${day}`,
      );
    }
    const id = String(row.user_id);
    identities.set(id, {
      externalId: id,
      kind: "user",
      displayName: row.user_login as string,
    });
    const sourceRef = `cp:${day}:${id}`;
    for (const [field, metric] of Object.entries(DAILY_METRIC_FIELDS)) {
      if (field in row) {
        metrics.push({
          day,
          identity: { externalId: id, kind: "user" },
          metric,
          value: row[field] as number,
          sourceRef,
        });
      }
    }
  }
  return { identities: [...identities.values()], metrics };
}

// ---------------------------------------------------------------------------
// Phase: prs (merged-PR search -> the detail queue)

function searchPage(body: unknown, label: string): { total: number; refs: string[] } {
  const env = parsePicked("github search response", body, {
    total_count: isInt,
    incomplete_results: isBool,
    items: isArr,
  });
  if (env.incomplete_results === true) {
    // A timed-out search silently misses PRs - that's dropped outcomes.
    throw new Error(`github search returned incomplete results for ${label}`);
  }
  const refs: string[] = [];
  for (const raw of env.items as unknown[]) {
    const item = parsePicked("github search item", raw, {
      number: isInt,
      repository_url: nonEmptyStr,
      pull_request: isObj,
    });
    // is:merged guarantees a merge timestamp; its absence is drift.
    parsePicked("github search item pull_request", item.pull_request, {
      merged_at: nonEmptyStr,
    });
    const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url as string);
    if (!match) {
      throw new Error(
        `github search item: unparseable repository_url ${item.repository_url}`,
      );
    }
    refs.push(`${match[1]}/${match[2]}#${item.number}`);
  }
  return { total: env.total_count as number, refs };
}

// ---------------------------------------------------------------------------
// Phase: pr (detail + commits -> outcomes, AI authorship, reverts)

function botAuthorTool(login: string): string | null {
  for (const [re, tool] of AI_BOT_AUTHORS) {
    if (re.test(login)) return tool;
  }
  return null;
}

function bodyRevertRefs(body: string | null, owner: string, repo: string): string[] {
  if (!body) return [];
  const refs = new Set<string>();
  for (const match of body.matchAll(REVERTS_REF_RE)) {
    const target = match[1] ?? `${owner}/${repo}`;
    refs.add(`pr:${target}#${match[2]}`);
  }
  return [...refs];
}

/** Parse pulls/{n}. Returns null when the PR is not actually merged. */
function prDetail(body: unknown, ref: string): PrProgress | null {
  const { owner, repo, number } = refParts(ref);
  const pr = parsePicked(`github pull request ${ref}`, body, {
    number: isInt,
    user: isObj,
  }, {
    body: strOrNull,
    merged_at: strOrNull,
    merge_commit_sha: strOrNull,
  });
  if (pr.number !== number) {
    throw new Error(`github pull request ${ref}: response is PR #${pr.number}`);
  }
  const user = parsePicked(`github pull request ${ref} user`, pr.user, {
    id: isInt,
    login: nonEmptyStr,
    type: nonEmptyStr,
  });
  const mergedAt = (pr.merged_at as string | null | undefined) ?? null;
  if (mergedAt === null) return null;

  const login = user.login as string;
  const human = user.type === "User";
  // Unknown bots (dependabot, CI) are bot-authored but never claimed as AI.
  const botTool = human ? null : botAuthorTool(login);
  const mergeSha = (pr.merge_commit_sha as string | null | undefined) ?? null;
  return {
    ts: mergedAt,
    author: human ? { id: String(user.id), login } : null,
    tools: botTool ? [botTool] : [],
    shas: mergeSha ? [mergeSha] : [],
    revertRefs: bodyRevertRefs((pr.body as string | null | undefined) ?? null, owner, repo),
    revertShas: [],
    page: 1,
  };
}

function commitsPage(body: unknown): {
  shas: string[];
  tools: string[];
  revertShas: string[];
  count: number;
} {
  if (!isArr(body)) {
    throw new Error("github pull request commits response is not an array");
  }
  const shas: string[] = [];
  const tools = new Set<string>();
  const revertShas = new Set<string>();
  for (const raw of body as unknown[]) {
    const entry = parsePicked("github pull request commit", raw, {
      sha: nonEmptyStr,
      commit: isObj,
    });
    const commit = parsePicked("github pull request commit detail", entry.commit, {
      message: isStr,
    });
    shas.push(entry.sha as string);
    const message = commit.message as string;
    for (const match of message.matchAll(CO_AUTHOR_RE)) {
      const tool = coAuthorTool(match[1], match[2]);
      if (tool) tools.add(tool);
    }
    for (const match of message.matchAll(REVERTS_SHA_RE)) {
      revertShas.add(match[1]);
    }
  }
  return {
    shas,
    tools: [...tools],
    revertShas: [...revertShas],
    count: (body as unknown[]).length,
  };
}

function finalizePr(ref: string, pr: PrProgress): {
  identities: IdentityInput[];
  outcomes: OutcomeInput[];
  reverts: RevertInput[];
} {
  const sourceRef = `pr:${ref}`;
  const identities: IdentityInput[] = pr.author
    ? [{ externalId: pr.author.id, kind: "user", displayName: pr.author.login }]
    : [];
  const outcome: OutcomeInput = {
    ts: pr.ts,
    kind: OUTCOME_KIND,
    identity: pr.author ? { externalId: pr.author.id, kind: "user" } : undefined,
    tools: [...pr.tools].sort(),
    shas: pr.shas,
    sourceRef,
  };
  const reverts: RevertInput[] = [
    ...pr.revertRefs.map((targetRef) => ({
      ts: pr.ts,
      kind: OUTCOME_KIND,
      sourceRef,
      targetRef,
    })),
    ...pr.revertShas.map((targetSha) => ({
      ts: pr.ts,
      kind: OUTCOME_KIND,
      sourceRef,
      targetSha,
    })),
  ];
  return { identities, outcomes: [outcome], reverts };
}

// ---------------------------------------------------------------------------
// The connector

function parseToken(token: string | null): GithubCursor {
  if (token === null) return INITIAL_CURSOR;
  return JSON.parse(token) as GithubCursor;
}

function tokenFor(cursor: GithubCursor): string {
  return JSON.stringify(cursor);
}

/** Advance past a finished month: next month, or on to the daily phase. */
function afterMonth(state: GithubCursor, months: string[], window: SyncWindow): GithubCursor {
  const next = state.credits!.month + 1;
  if (next < months.length) {
    return {
      ...state,
      credits: { month: next, user: -1, orgCents: 0, attributedCents: 0 },
    };
  }
  return {
    ...state,
    phase: "daily",
    credits: undefined,
    daily: { day: dailyDays(window)[0], links: [] },
  };
}

/** Advance past a finished day: next day, or on to the PR search phase. */
function afterDay(state: GithubCursor, days: string[]): GithubCursor {
  const index = days.indexOf(state.daily!.day);
  if (index + 1 < days.length) {
    return { ...state, daily: { day: days[index + 1], links: [] } };
  }
  return { ...state, phase: "prs", daily: undefined, chunk: 0, page: 1 };
}

export const githubConnector: Connector = {
  vendor: "github",
  displayName: "GitHub",
  outcomeKinds: ["github_pr"],
  historyLimitDays: GITHUB_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Needs a classic PAT from an org owner: read:org and manage_billing:copilot for the Copilot roster, repo for merged pull requests on private repositories, and billing access for AI-credit dollars.",
    "Enterprise-owned orgs need an enterprise owner's classic PAT with admin:enterprise for per-user Copilot dollars - set the Enterprise slug field and billing is read through the enterprise API.",
    "GitHub reports AI-credit dollars per user per calendar month: spend lands on the month bucket, never spread across days. Credit spend the report cannot attribute to a current seat holder stays visible as Unassigned.",
    "A merged PR counts on merge. A revert referencing it within the revert window (Settings, default 30 days) flips it and recomputes; after the window it is final. Detection is revert commits/PRs only, never line-level code survival.",
    "AI authorship is read from bot authors and commit co-author trailers (Claude, Copilot, Cursor, Devin, Codex). A human pasting AI output by hand is invisible and counts as human.",
    "Copilot seat fees are not reported per user by any API and are never invented or amortized; the monthly invoice import trues them.",
  ],
  configFields: [
    { key: "org", label: "Organization slug" },
    { key: "token", label: "Personal access token (classic)", secret: true },
    { key: "enterprise", label: "Enterprise slug (enterprise-owned orgs only)" },
  ],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    if (!ctx.config.org) throw new Error("organization slug is required");
    // One probe per surface the sync needs - Copilot roster, AI-credit
    // billing (the enterprise API when enterprise-owned), merged-PR search -
    // so a token missing any scope rejects the connect with the vendor's
    // error verbatim instead of failing the first sync.
    seatsPage(await ghJson(ctx, seatsProbeRequest(ctx.config.org)));
    creditItems(
      await ghJson(ctx, creditsProbeRequest(ctx.config)),
      `${PROBE_YEAR}-${String(PROBE_MONTH).padStart(2, "0")}`,
    );
    searchPage(await ghJson(ctx, searchProbeRequest(ctx.config.org)), "the scope probe");
    return { scopes: ["copilot", "billing", "repo"] };
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const state = parseToken(pageToken);

    switch (state.phase) {
      case "seats": {
        const body = await ghJson(ctx, seatsRequest(ctx.config.org, state.page));
        const { identities, map, totalSeats } = seatsPage(body);
        const users = { ...state.users, ...map };
        const next: GithubCursor =
          state.page * SEATS_PAGE_SIZE < totalSeats
            ? { ...state, page: state.page + 1, users }
            : {
                ...state,
                phase: "credits",
                page: 1,
                users,
                credits: { month: 0, user: -1, orgCents: 0, attributedCents: 0 },
              };
        return { identities, facts: [], nextPageToken: tokenFor(next) };
      }

      case "credits": {
        const months = monthsBetween(window);
        const logins = Object.keys(state.users).sort();
        const c = state.credits!;
        const month = months[c.month];

        if (c.user === -1) {
          // The unfiltered org report: the month's total (invoice truth).
          const { cents } = creditItems(await ghJson(ctx, creditsRequest(ctx.config, month, null)), month);
          const metrics: MetricInput[] = [
            { day: monthDay(month), metric: TOTAL_METRIC, value: cents, sourceRef: `ai_credit:${month}:org` },
          ];
          const facts: FactInput[] = [];
          let next: GithubCursor;
          if (cents === 0) {
            next = afterMonth(state, months, window); // nothing to attribute
          } else if (logins.length === 0) {
            facts.push(remainderFact(month, cents)); // no roster: all Unassigned
            next = afterMonth(state, months, window);
          } else {
            next = { ...state, credits: { ...c, user: 0, orgCents: cents, attributedCents: 0 } };
          }
          return { identities: [], facts, metrics, nextPageToken: tokenFor(next) };
        }

        const login = logins[c.user];
        const { cents, facts } = creditItems(
          await ghJson(ctx, creditsRequest(ctx.config, month, login)),
          month,
          state.users[login],
        );
        const attributed = c.attributedCents + cents;
        let next: GithubCursor;
        if (c.user + 1 < logins.length) {
          next = { ...state, credits: { ...c, user: c.user + 1, attributedCents: attributed } };
        } else {
          // Spend the per-user walk could not attribute (users no longer
          // holding a seat): the visible Unassigned remainder. Clamped at
          // zero - per-user restatements mid-walk can briefly overshoot.
          facts.push(remainderFact(month, Math.max(0, c.orgCents - attributed)));
          next = afterMonth(state, months, window);
        }
        return { identities: [], facts, nextPageToken: tokenFor(next) };
      }

      case "daily": {
        const days = dailyDays(window);
        const d = state.daily!;
        if (d.links.length > 0) {
          const [link, ...rest] = d.links;
          const { identities, metrics } = usageRows(await ghText(ctx, link), d.day);
          const next =
            rest.length > 0 ? { ...state, daily: { day: d.day, links: rest } } : afterDay(state, days);
          return { identities, facts: [], metrics, nextPageToken: tokenFor(next) };
        }
        let links: string[];
        try {
          links = reportLinks(
            await ghJson(ctx, dailyReportRequest(ctx.config.org, d.day)),
            d.day,
          );
        } catch (err) {
          // A day with no processed report is a documented 404 - notably
          // window.until (today), whose report GitHub has not generated
          // yet. Absence, not an error: the day is skipped, and the
          // trailing re-pull picks it up once the report exists.
          if (!(err instanceof GhHttpError && err.status === 404)) throw err;
          links = [];
        }
        const next =
          links.length > 0 ? { ...state, daily: { day: d.day, links } } : afterDay(state, days);
        return { identities: [], facts: [], nextPageToken: tokenFor(next) };
      }

      case "prs": {
        const chunks = chunkWindows(window, SEARCH_CHUNK_DAYS);
        const chunk = chunks[state.chunk];
        const label = `${chunk.since}..${chunk.until}`;
        const { total, refs } = searchPage(
          await ghJson(ctx, searchRequest(ctx.config.org, chunk, state.page)),
          label,
        );
        if (total > SEARCH_RESULT_CAP) {
          // The search API serves at most 1000 results per query; walking on
          // would silently drop merged PRs. Surfaced instead of guessed.
          throw new Error(
            `github search window ${label} has ${total} merged PRs - over the ${SEARCH_RESULT_CAP}-result search cap`,
          );
        }
        const queue = [...(state.queue ?? []), ...refs];
        let next: GithubCursor | null;
        if (state.page * SEARCH_PAGE_SIZE < total) {
          next = { ...state, page: state.page + 1, queue };
        } else if (state.chunk + 1 < chunks.length) {
          next = { ...state, chunk: state.chunk + 1, page: 1, queue };
        } else if (queue.length > 0) {
          next = { ...state, phase: "pr", queue, current: undefined };
        } else {
          next = null;
        }
        return { identities: [], facts: [], nextPageToken: next ? tokenFor(next) : null };
      }

      case "pr": {
        const queue = state.queue ?? [];
        const ref = queue[0];
        if (!state.current) {
          const detail = prDetail(await ghJson(ctx, prRequest(ref)), ref);
          if (detail === null) {
            // The search index said merged but the record disagrees (index
            // lag): no outcome is invented; the re-pull catches it merged.
            ctx.log.warn("merged PR from search is not merged, skipped", { ref });
            const rest = queue.slice(1);
            const next: GithubCursor | null =
              rest.length > 0 ? { ...state, queue: rest, current: undefined } : null;
            return { identities: [], facts: [], nextPageToken: next ? tokenFor(next) : null };
          }
          return {
            identities: [],
            facts: [],
            nextPageToken: tokenFor({ ...state, current: detail }),
          };
        }

        const cur = state.current;
        const { shas, tools, revertShas, count } = commitsPage(
          await ghJson(ctx, prCommitsRequest(ref, cur.page)),
        );
        const merged: PrProgress = {
          ...cur,
          shas: [...cur.shas, ...shas],
          tools: [...new Set([...cur.tools, ...tools])],
          revertShas: [...new Set([...cur.revertShas, ...revertShas])],
        };
        if (count === COMMITS_PAGE_SIZE) {
          return {
            identities: [],
            facts: [],
            nextPageToken: tokenFor({ ...state, current: { ...merged, page: cur.page + 1 } }),
          };
        }
        const { identities, outcomes, reverts } = finalizePr(ref, merged);
        const rest = queue.slice(1);
        const next: GithubCursor | null =
          rest.length > 0 ? { ...state, queue: rest, current: undefined } : null;
        return {
          identities,
          facts: [],
          outcomes,
          reverts,
          nextPageToken: next ? tokenFor(next) : null,
        };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Write operations (spec 8 people in/out): Copilot seats. NOT part of sync -
// the connector itself only ever reads - but they live here because they
// share the vendor auth, base URL, and verbatim-error convention. Copilot's
// seat APIs are username-keyed, never email-keyed: callers pass the login
// of an already-mapped GitHub user identity.

export function selectedUsersRequest(org: string): string {
  return `${GITHUB_API}/orgs/${org}/copilot/billing/selected_users`;
}

/** Assign a Copilot seat to a username. */
export async function addCopilotSeat(
  ctx: ConnectorContext,
  org: string,
  login: string,
): Promise<void> {
  const body = await ghJson(ctx, selectedUsersRequest(org), {
    method: "POST",
    body: { selected_usernames: [login] },
  });
  const result = parsePicked("github copilot seat add response", body, {
    seats_created: isInt,
  });
  if ((result.seats_created as number) < 1) {
    throw new Error(`github created no Copilot seat for ${login} - they may already hold one`);
  }
}

/** Cancel a username's Copilot seat. */
export async function removeCopilotSeat(
  ctx: ConnectorContext,
  org: string,
  login: string,
): Promise<void> {
  const body = await ghJson(ctx, selectedUsersRequest(org), {
    method: "DELETE",
    body: { selected_usernames: [login] },
  });
  const result = parsePicked("github copilot seat cancel response", body, {
    seats_cancelled: isInt,
  });
  if ((result.seats_cancelled as number) < 1) {
    throw new Error(
      `github cancelled no Copilot seat for ${login} - they may not hold one anymore`,
    );
  }
}
