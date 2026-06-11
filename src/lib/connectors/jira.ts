import {
  agentTag,
  distillTransitions,
  type IssueStateConfig,
  type StatusBucket,
  type StatusTransition,
} from "./issues";
import { isArr, isObj, nonEmptyStr, parsePicked, strOrNull } from "./strict";
import { addDays } from "./sync";
import type {
  Connector,
  ConnectorContext,
  ConnectorPage,
  IdentityInput,
  IssueInput,
  ScopeCheck,
  SyncWindow,
} from "./types";

/**
 * Jira success integration (spec 7): same sync contract as the vendor
 * connectors but it writes OUTCOMES ONLY - never spend. Each issue's status
 * timeline is rebuilt from its CHANGELOG (expand=changelog on the search),
 * so the success state machine (lib/connectors/issues.ts) counts after the
 * fact, never from the status a sync happens to observe. The framework owns
 * the machine; this connector only fetches, parses strictly, and distills.
 *
 * Attribution (spec 7, two layers, no guessing): an app/agent actor
 * (accountType "app" - bot accounts, Atlassian apps) gets the credit when
 * it is the issue's ASSIGNEE or CREATOR; its display name becomes a tag, so
 * pointing that tag at an ROI routes its successes there. Otherwise the
 * human creator is credited and auto-matches by email; unmatched actors
 * land in Resolve. One shared app creating everything routes by the
 * project -> ROI mapping chosen at connect (listProjects).
 *
 * Paging: one POST /rest/api/3/search/jql per fetchPage, ordered by update
 * time, walked with the vendor's own nextPageToken - it rides in
 * sync_runs.cursor via the framework, so a failed run resumes at the exact
 * page. Each page also reads /rest/api/3/status once: changelog entries
 * carry status NAMES only, and the default submitted/fail matching needs
 * each status's category. Jira serves full history; backfill is pinned to
 * 365 days.
 */

export const JIRA_HISTORY_LIMIT_DAYS = 365;
const PAGE_SIZE = 100;
/** The issue fields the search asks for - nothing else leaves Jira. */
const FIELDS = ["creator", "assignee", "status", "summary", "project", "created"];

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

async function jiraJson(ctx: ConnectorContext, req: JiraRequest): Promise<unknown> {
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
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error pages fall through to the status error below.
  }
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    const messages =
      isObj(body) && isArr((body as Record<string, unknown>).errorMessages)
        ? ((body as Record<string, unknown>).errorMessages as unknown[]).filter(
            (m) => typeof m === "string",
          )
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

/** Every status the site defines, with its category - buckets the changelog. */
export function statusesRequest(site: string): JiraRequest {
  return { method: "GET", url: `${site}/rest/api/3/status` };
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
      expand: "changelog",
      ...(pageToken !== null ? { nextPageToken: pageToken } : {}),
    },
  };
}

export function projectsRequest(site: string, startAt: number): JiraRequest {
  return {
    method: "GET",
    url: `${site}/rest/api/3/project/search?startAt=${startAt}&maxResults=100`,
  };
}

const CATEGORY_BUCKETS: Record<string, StatusBucket> = {
  new: "todo",
  indeterminate: "doing",
  done: "done",
};

/** Status name (lowercased) -> bucket, from /rest/api/3/status. A status
 * deleted since a transition went through it has no bucket - it can still
 * match a configured name, never a category default. */
function parseStatusBuckets(raw: unknown): Map<string, StatusBucket> {
  if (!isArr(raw)) throw new Error("jira /status response is not an array");
  const buckets = new Map<string, StatusBucket>();
  for (const entry of raw as unknown[]) {
    const status = parsePicked("jira status", entry, {
      name: nonEmptyStr,
      statusCategory: isObj,
    });
    const category = parsePicked(
      `jira status ${String(status.name)} category`,
      status.statusCategory,
      { key: nonEmptyStr },
    );
    buckets.set(
      (status.name as string).toLowerCase(),
      CATEGORY_BUCKETS[category.key as string] ?? null,
    );
  }
  return buckets;
}

interface JiraActor {
  accountId: string;
  app: boolean;
  email: string | null;
  displayName: string | null;
}

function parseActor(label: string, raw: unknown): JiraActor | null {
  if (raw === null || raw === undefined) return null;
  const actor = parsePicked(
    label,
    raw,
    { accountId: nonEmptyStr },
    { accountType: strOrNull, emailAddress: strOrNull, displayName: strOrNull },
  );
  return {
    accountId: actor.accountId as string,
    app: actor.accountType === "app",
    email: (actor.emailAddress as string | null | undefined) ?? null,
    displayName: (actor.displayName as string | null | undefined) ?? null,
  };
}

function utcIso(label: string, ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}: unreadable timestamp ${JSON.stringify(ts)}`);
  }
  return new Date(parsed).toISOString();
}

interface ParsedIssue {
  key: string;
  title: string | null;
  project: string;
  creator: JiraActor | null;
  assignee: JiraActor | null;
  transitions: StatusTransition[];
}

function parseIssue(raw: unknown, buckets: Map<string, StatusBucket>): ParsedIssue {
  const issue = parsePicked("jira issue", raw, { key: nonEmptyStr, fields: isObj }, {
    changelog: isObj,
  });
  const label = `jira issue ${String(issue.key)}`;
  const fields = parsePicked(
    `${label} fields`,
    issue.fields,
    { status: isObj, project: isObj, created: nonEmptyStr },
    {
      creator: (v) => v === null || isObj(v),
      assignee: (v) => v === null || isObj(v),
      summary: strOrNull,
    },
  );
  const status = parsePicked(`${label} status`, fields.status, {
    name: nonEmptyStr,
    statusCategory: isObj,
  });
  const category = parsePicked(`${label} statusCategory`, status.statusCategory, {
    key: nonEmptyStr,
  });
  const project = parsePicked(`${label} project`, fields.project, { key: nonEmptyStr });

  // Rebuild the status timeline from the changelog: each status item is one
  // transition at its history's timestamp.
  const moves: (StatusTransition & { fromName: string | null })[] = [];
  if (issue.changelog !== undefined) {
    const changelog = parsePicked(`${label} changelog`, issue.changelog, {
      histories: isArr,
    });
    for (const rawHistory of changelog.histories as unknown[]) {
      const history = parsePicked(`${label} history`, rawHistory, {
        created: nonEmptyStr,
        items: isArr,
      });
      for (const rawItem of history.items as unknown[]) {
        const item = parsePicked(`${label} history item`, rawItem, { field: nonEmptyStr }, {
          fromString: strOrNull,
          toString: strOrNull,
        });
        if (item.field !== "status") continue;
        // Indexed access: "toString" would otherwise resolve to the method.
        const toName = (item["toString"] as string | null | undefined) ?? null;
        if (toName === null) continue;
        moves.push({
          ts: utcIso(label, history.created as string),
          name: toName,
          bucket: buckets.get(toName.toLowerCase()) ?? null,
          fromName: (item.fromString as string | null | undefined) ?? null,
        });
      }
    }
  }
  moves.sort((a, b) => a.ts.localeCompare(b.ts));
  const transitions: StatusTransition[] = moves.map(({ ts, name, bucket }) => ({
    ts,
    name,
    bucket,
  }));
  // The issue entered its FIRST status at creation - the changelog only
  // records moves out of it. An untouched issue sits in its current status.
  const initialName = moves.length > 0 ? moves[0].fromName : (status.name as string);
  if (initialName !== null) {
    const initialBucket =
      moves.length === 0
        ? (CATEGORY_BUCKETS[category.key as string] ?? null)
        : (buckets.get(initialName.toLowerCase()) ?? null);
    transitions.unshift({
      ts: utcIso(label, fields.created as string),
      name: initialName,
      bucket: initialBucket,
    });
  }

  return {
    key: issue.key as string,
    title: (fields.summary as string | null | undefined) ?? null,
    project: project.key as string,
    creator: parseActor(`${label} creator`, fields.creator ?? null),
    assignee: parseActor(`${label} assignee`, fields.assignee ?? null),
    transitions,
  };
}

function describeActor(actor: JiraActor): IdentityInput {
  return {
    externalId: actor.accountId,
    kind: "user",
    email: actor.email ?? undefined,
    displayName: actor.displayName ?? undefined,
    tags: actor.app && actor.displayName ? [agentTag(actor.displayName)] : [],
  };
}

/** Credit (spec 7): the agent when it is assignee or creator - the assignee
 * did the work when both exist - else the human creator, by email. */
function creditedActor(issue: ParsedIssue): JiraActor | null {
  if (issue.assignee?.app) return issue.assignee;
  if (issue.creator?.app) return issue.creator;
  return issue.creator ?? issue.assignee;
}

export const jiraConnector: Connector = {
  vendor: "jira",
  displayName: "Jira",
  successOnly: true,
  outcomeKinds: ["issue_done"],
  historyLimitDays: JIRA_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Success-only: counts issues, writes no spend. An issue that hits the submitted status goes pending; it succeeds when the window passes without regressing (or it reaches Done sooner) and fails if it regresses inside the window - all read from the issue changelog.",
    "Defaults: submitted = any in-progress status, fail = back to any To Do status, window 30 days - override below per connection.",
    "Credit: an app/agent creator or assignee by name (the name becomes a tag - point it at an ROI); otherwise the issue creator, matched by email. Map projects to ROIs on this card once connected.",
    "Needs the site URL plus an Atlassian account email and API token; the account's browse permission decides which projects are read.",
  ],
  configFields: [
    { key: "siteUrl", label: "Site URL" },
    { key: "email", label: "Account email" },
    { key: "apiToken", label: "API token", secret: true },
    {
      key: "submittedStatus",
      label: "Submitted status",
      optional: true,
      placeholder: "any in-progress status",
    },
    {
      key: "failStatus",
      label: "Fail status",
      optional: true,
      placeholder: "any To Do status",
    },
    { key: "windowDays", label: "Window (days)", optional: true, placeholder: "30" },
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

  async listProjects(ctx: ConnectorContext): Promise<{ key: string; name: string }[]> {
    const site = siteUrl(ctx);
    const projects: { key: string; name: string }[] = [];
    for (let startAt = 0; ; ) {
      const body = await jiraJson(ctx, projectsRequest(site, startAt));
      const page = parsePicked("jira project search", body, {
        values: isArr,
        isLast: (v) => typeof v === "boolean",
      });
      for (const raw of page.values as unknown[]) {
        const project = parsePicked("jira project", raw, {
          key: nonEmptyStr,
          name: nonEmptyStr,
        });
        projects.push({ key: project.key as string, name: project.name as string });
      }
      if (page.isLast as boolean) return projects;
      startAt += (page.values as unknown[]).length;
    }
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const site = siteUrl(ctx);
    const buckets = parseStatusBuckets(await jiraJson(ctx, statusesRequest(site)));
    const body = await jiraJson(ctx, searchRequest(site, window, pageToken));
    const env = parsePicked("jira search response", body, { issues: isArr }, {
      nextPageToken: nonEmptyStr,
      isLast: (v) => typeof v === "boolean",
    });

    const stateConfig: IssueStateConfig = {
      submittedStatus: ctx.config.submittedStatus,
      failStatus: ctx.config.failStatus,
    };
    const identities = new Map<string, IdentityInput>();
    const issues: IssueInput[] = [];
    for (const raw of env.issues as unknown[]) {
      const issue = parseIssue(raw, buckets);
      for (const actor of [issue.creator, issue.assignee]) {
        if (actor !== null) identities.set(actor.accountId, describeActor(actor));
      }
      const credited = creditedActor(issue);
      const events = distillTransitions(issue.transitions, stateConfig);
      issues.push({
        sourceRef: `${site}/browse/${issue.key}`,
        key: issue.key,
        title: issue.title ?? undefined,
        project: issue.project,
        identity: credited ? { externalId: credited.accountId, kind: "user" } : undefined,
        submittedAt: events.submittedAt ?? undefined,
        doneAt: events.doneAt ?? undefined,
        regressedAt: events.regressedAt ?? undefined,
      });
    }

    const next = (env.nextPageToken as string | undefined) ?? null;
    return {
      identities: [...identities.values()],
      facts: [],
      issues,
      nextPageToken: next,
    };
  },
};
