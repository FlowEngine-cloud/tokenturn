import { isArr, isObj, nonEmptyStr, parsePicked, strOrNull } from "./strict";
import { addDays } from "./sync";
import type {
  Connector,
  ConnectorContext,
  ConnectorPage,
  IdentityInput,
  OutcomeInput,
  RevertInput,
  ScopeCheck,
  SyncWindow,
} from "./types";

/**
 * Jira success integration (spec 7): same sync contract as the vendor
 * connectors but it writes OUTCOMES ONLY - never spend. An issue whose
 * status category reaches Done counts as one "jira_issue" success on its
 * resolution timestamp; an issue seen back out of Done emits a revert, and
 * the framework flips the counted outcome when the reopen lands inside
 * revert_window_days (Settings, default 30) - after the window the success
 * is final. Re-pulls restate in place on (kind, source_ref) = the issue key.
 *
 * Attribution: the issue CREATOR (spec 7 routing) - a human creator
 * auto-matches by email like any vendor identity; an app/agent creator has
 * no email and lands as its own identity, visible in Resolve. The issue key
 * is the source_ref, so every counted success drills to the Jira record.
 *
 * Paging: one POST /rest/api/3/search/jql per fetchPage, ordered by update
 * time, walked with the vendor's own nextPageToken - it rides in
 * sync_runs.cursor via the framework, so a failed run resumes at the exact
 * page. Jira serves full history; backfill is pinned to 365 days.
 */

export const JIRA_HISTORY_LIMIT_DAYS = 365;
const PAGE_SIZE = 100;
/** The issue fields the search asks for - nothing else leaves Jira. */
const FIELDS = ["creator", "status", "resolutiondate", "statuscategorychangedate"];

export interface JiraRequest {
  method: "GET" | "POST";
  url: string;
  body?: Record<string, unknown>;
}

function siteUrl(ctx: ConnectorContext): string {
  return (ctx.config.siteUrl ?? "").replace(/\/+$/, "");
}

function basicAuth(ctx: ConnectorContext): string {
  return `Basic ${Buffer.from(
    `${ctx.config.email ?? ""}:${ctx.config.apiToken ?? ""}`,
  ).toString("base64")}`;
}

async function jiraJson(
  ctx: ConnectorContext,
  req: JiraRequest,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(req.url, {
    method: req.method,
    headers: {
      authorization: basicAuth(ctx),
      accept: "application/json",
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON error pages fall through to the status error below.
  }
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    const messages = isArr(body.errorMessages)
      ? (body.errorMessages as unknown[]).filter((m) => typeof m === "string")
      : [];
    throw new Error(
      messages.length > 0 ? messages.join("; ") : `jira returned HTTP ${res.status}`,
    );
  }
  return body;
}

export function myselfRequest(site: string): JiraRequest {
  return { method: "GET", url: `${site}/rest/api/3/myself` };
}

/** Issues updated inside the window, oldest first - deterministic paging. */
export function searchRequest(
  site: string,
  window: SyncWindow,
  pageToken: string | null,
): JiraRequest {
  return {
    method: "POST",
    url: `${site}/rest/api/3/search/jql`,
    body: {
      jql: `updated >= "${window.since}" AND updated < "${addDays(window.until, 1)}" ORDER BY updated ASC`,
      maxResults: PAGE_SIZE,
      fields: FIELDS,
      ...(pageToken !== null ? { nextPageToken: pageToken } : {}),
    },
  };
}

interface ParsedIssue {
  key: string;
  creator: { accountId: string; email: string | null; displayName: string | null } | null;
  done: boolean;
  /** Resolution timestamp for done issues; status-change timestamp otherwise. */
  ts: string;
}

function parseIssue(raw: unknown): ParsedIssue {
  const issue = parsePicked("jira issue", raw, { key: nonEmptyStr, fields: isObj });
  const fields = parsePicked(
    `jira issue ${String(issue.key)} fields`,
    issue.fields,
    { status: isObj, statuscategorychangedate: nonEmptyStr },
    { creator: (v) => v === null || isObj(v), resolutiondate: strOrNull },
  );
  const status = parsePicked(`jira issue ${String(issue.key)} status`, fields.status, {
    statusCategory: isObj,
  });
  const category = parsePicked(
    `jira issue ${String(issue.key)} statusCategory`,
    status.statusCategory,
    { key: nonEmptyStr },
  );

  let creator: ParsedIssue["creator"] = null;
  if (fields.creator !== null && fields.creator !== undefined) {
    const raw = parsePicked(
      `jira issue ${String(issue.key)} creator`,
      fields.creator,
      { accountId: nonEmptyStr },
      { emailAddress: strOrNull, displayName: strOrNull },
    );
    creator = {
      accountId: raw.accountId as string,
      email: (raw.emailAddress as string | null | undefined) ?? null,
      displayName: (raw.displayName as string | null | undefined) ?? null,
    };
  }

  const done = (category.key as string) === "done";
  const resolution = (fields.resolutiondate as string | null | undefined) ?? null;
  const ts = done && resolution !== null ? resolution : (fields.statuscategorychangedate as string);
  if (!Number.isFinite(Date.parse(ts))) {
    throw new Error(`jira issue ${String(issue.key)}: unreadable timestamp ${JSON.stringify(ts)}`);
  }
  return { key: issue.key as string, creator, done, ts };
}

export const jiraConnector: Connector = {
  vendor: "jira",
  displayName: "Jira",
  successOnly: true,
  outcomeKinds: ["jira_issue"],
  historyLimitDays: JIRA_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Success-only: counts issues, writes no spend. An issue counts when its status category reaches Done; leaving Done within the revert window (Settings, default 30 days) un-counts it.",
    "Attributed to the issue's creator - humans match by email, app/agent creators land as their own identity in Resolve.",
    "Needs the site URL plus an Atlassian account email and API token; the account's browse permission decides which projects are read.",
  ],
  configFields: [
    { key: "siteUrl", label: "Site URL" },
    { key: "email", label: "Account email" },
    { key: "apiToken", label: "API token", secret: true },
  ],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    const site = siteUrl(ctx);
    if (!/^https:\/\//.test(site)) {
      throw new Error("site URL must start with https://");
    }
    const me = await jiraJson(ctx, myselfRequest(site));
    parsePicked("jira /myself response", me, { accountId: nonEmptyStr });
    return { scopes: ["read"] };
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const body = await jiraJson(ctx, searchRequest(siteUrl(ctx), window, pageToken));
    const env = parsePicked("jira search response", body, { issues: isArr }, {
      nextPageToken: nonEmptyStr,
      isLast: (v) => typeof v === "boolean",
    });

    const identities = new Map<string, IdentityInput>();
    const outcomes: OutcomeInput[] = [];
    const reverts: RevertInput[] = [];
    for (const raw of env.issues as unknown[]) {
      const issue = parseIssue(raw);
      if (issue.creator !== null) {
        identities.set(issue.creator.accountId, {
          externalId: issue.creator.accountId,
          kind: "user",
          email: issue.creator.email ?? undefined,
          displayName: issue.creator.displayName ?? undefined,
        });
      }
      if (issue.done) {
        outcomes.push({
          ts: issue.ts,
          kind: "jira_issue",
          identity: issue.creator
            ? { externalId: issue.creator.accountId, kind: "user" }
            : undefined,
          sourceRef: issue.key,
        });
      } else {
        // Seen outside Done: flips a previously counted success when the
        // reopen lands inside the revert window; a no-op for issues that
        // never counted - emitting it unconditionally keeps re-pulls
        // idempotent.
        reverts.push({
          ts: issue.ts,
          kind: "jira_issue",
          sourceRef: `${issue.key}@reopen`,
          targetRef: issue.key,
        });
      }
    }

    const next = (env.nextPageToken as string | undefined) ?? null;
    return {
      identities: [...identities.values()],
      facts: [],
      outcomes,
      reverts,
      nextPageToken: next,
    };
  },
};
