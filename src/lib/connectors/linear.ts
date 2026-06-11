import { isArr, isBool, isObj, nonEmptyStr, parsePicked, parseStrict, strOrNull } from "./strict";
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
 * Linear success integration (spec 7): same sync contract as the vendor
 * connectors but it writes OUTCOMES ONLY - never spend. An issue whose
 * workflow state reaches completed counts as one "linear_issue" success on
 * its completedAt; an issue seen back out of completed emits a revert, and
 * the framework flips the counted outcome when it lands inside
 * revert_window_days (Settings, default 30). Re-pulls restate in place on
 * (kind, source_ref) = the issue identifier.
 *
 * Attribution: the issue CREATOR (spec 7 routing) - humans auto-match by
 * email; Linear agents are first-class actors (creator with no email, or no
 * creator at all) and land as their own identity, visible in Resolve.
 *
 * Paging: one GraphQL issues() query per fetchPage, filtered on updatedAt,
 * walked with Linear's own endCursor - it rides in sync_runs.cursor via the
 * framework, so a failed run resumes at the exact page. Linear serves full
 * history; backfill is pinned to 365 days.
 */

export const LINEAR_HISTORY_LIMIT_DAYS = 365;
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;

const VIEWER_QUERY = "{ viewer { id email } }";
const ISSUES_QUERY =
  "query Issues($from: DateTimeOrDuration!, $to: DateTimeOrDuration!, $after: String) { " +
  `issues(first: ${PAGE_SIZE}, after: $after, filter: { updatedAt: { gte: $from, lt: $to } }) { ` +
  "nodes { identifier updatedAt completedAt state { type } creator { id displayName email } } " +
  "pageInfo { hasNextPage endCursor } } }";

export interface LinearRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export function viewerRequest(): LinearRequest {
  return { query: VIEWER_QUERY };
}

export function issuesRequest(window: SyncWindow, after: string | null): LinearRequest {
  return {
    query: ISSUES_QUERY,
    variables: {
      from: `${window.since}T00:00:00.000Z`,
      to: `${addDays(window.until, 1)}T00:00:00.000Z`,
      after,
    },
  };
}

async function linearJson(
  ctx: ConnectorContext,
  req: LinearRequest,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: ctx.config.apiKey ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify(req),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // GraphQL rejections arrive as an errors array, sometimes on a 200 - the
  // first vendor message comes back verbatim (spec 5).
  if (isArr(body.errors) && (body.errors as unknown[]).length > 0) {
    const first = parsePicked("linear error", (body.errors as unknown[])[0], {
      message: nonEmptyStr,
    });
    throw new Error(first.message as string);
  }
  if (!res.ok) {
    throw new Error(`linear returned HTTP ${res.status}`);
  }
  if (!isObj(body.data)) {
    throw new Error("linear response carries no data");
  }
  return body.data as Record<string, unknown>;
}

interface ParsedIssue {
  identifier: string;
  creator: { id: string; email: string | null; displayName: string | null } | null;
  done: boolean;
  ts: string;
}

function parseIssue(raw: unknown): ParsedIssue {
  const issue = parseStrict("linear issue", raw, {
    identifier: nonEmptyStr,
    updatedAt: nonEmptyStr,
    completedAt: strOrNull,
    state: isObj,
    creator: (v) => v === null || isObj(v),
  });
  const state = parseStrict(
    `linear issue ${String(issue.identifier)} state`,
    issue.state,
    { type: nonEmptyStr },
  );
  let creator: ParsedIssue["creator"] = null;
  if (issue.creator !== null) {
    const raw = parseStrict(`linear issue ${String(issue.identifier)} creator`, issue.creator, {
      id: nonEmptyStr,
      displayName: strOrNull,
      email: strOrNull,
    });
    creator = {
      id: raw.id as string,
      email: raw.email as string | null,
      displayName: raw.displayName as string | null,
    };
  }
  const done = (state.type as string) === "completed" && issue.completedAt !== null;
  const ts = done ? (issue.completedAt as string) : (issue.updatedAt as string);
  if (!Number.isFinite(Date.parse(ts))) {
    throw new Error(
      `linear issue ${String(issue.identifier)}: unreadable timestamp ${JSON.stringify(ts)}`,
    );
  }
  return { identifier: issue.identifier as string, creator, done, ts };
}

export const linearConnector: Connector = {
  vendor: "linear",
  displayName: "Linear",
  successOnly: true,
  outcomeKinds: ["linear_issue"],
  historyLimitDays: LINEAR_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Success-only: counts issues, writes no spend. An issue counts when its workflow state reaches completed; leaving completed within the revert window (Settings, default 30 days) un-counts it.",
    "Attributed to the issue's creator - humans match by email, agents land as their own identity in Resolve.",
    "Needs a personal or workspace API key with read access.",
  ],
  configFields: [{ key: "apiKey", label: "API key", secret: true }],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    const data = await linearJson(ctx, viewerRequest());
    const viewer = parseStrict("linear viewer", data.viewer, {
      id: nonEmptyStr,
      email: strOrNull,
    });
    void viewer;
    return { scopes: ["read"] };
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const data = await linearJson(ctx, issuesRequest(window, pageToken));
    const issues = parseStrict("linear issues", data.issues, {
      nodes: isArr,
      pageInfo: isObj,
    });
    const pageInfo = parseStrict("linear pageInfo", issues.pageInfo, {
      hasNextPage: isBool,
      endCursor: strOrNull,
    });

    const identities = new Map<string, IdentityInput>();
    const outcomes: OutcomeInput[] = [];
    const reverts: RevertInput[] = [];
    for (const raw of issues.nodes as unknown[]) {
      const issue = parseIssue(raw);
      if (issue.creator !== null) {
        identities.set(issue.creator.id, {
          externalId: issue.creator.id,
          kind: "user",
          email: issue.creator.email ?? undefined,
          displayName: issue.creator.displayName ?? undefined,
        });
      }
      if (issue.done) {
        outcomes.push({
          ts: issue.ts,
          kind: "linear_issue",
          identity: issue.creator ? { externalId: issue.creator.id, kind: "user" } : undefined,
          sourceRef: issue.identifier,
        });
      } else {
        // Seen outside completed: flips a previously counted success inside
        // the revert window; a no-op for issues that never counted.
        reverts.push({
          ts: issue.ts,
          kind: "linear_issue",
          sourceRef: `${issue.identifier}@reopen`,
          targetRef: issue.identifier,
        });
      }
    }

    const hasNext = pageInfo.hasNextPage as boolean;
    const endCursor = pageInfo.endCursor as string | null;
    if (hasNext && endCursor === null) {
      throw new Error("linear pageInfo says hasNextPage with no endCursor");
    }
    return {
      identities: [...identities.values()],
      facts: [],
      outcomes,
      reverts,
      nextPageToken: hasNext ? endCursor : null,
    };
  },
};
