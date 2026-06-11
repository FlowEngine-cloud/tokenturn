import {
  agentTag,
  distillTransitions,
  type IssueStateConfig,
  type StatusBucket,
  type StatusTransition,
} from "./issues";
import { isArr, isBool, isObj, nonEmptyStr, parseStrict, strOrNull } from "./strict";
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
 * Linear success integration (spec 7): same sync contract as the vendor
 * connectors but it writes OUTCOMES ONLY - never spend. Each issue's state
 * timeline is rebuilt from its HISTORY (state changes with from/to states),
 * so the success state machine (lib/connectors/issues.ts) counts after the
 * fact, never from the state a sync happens to observe.
 *
 * Attribution (spec 7): Linear agents are first-class actors - app users
 * (User.app = true) that create issues like any user; an agent put on an
 * issue is its DELEGATE, not its assignee ("humans maintain ownership while
 * agents act on their behalf" - linear.app/developers/agents). An agent
 * gets the credit when it is the delegate, assignee or creator; its display
 * name becomes a tag, so pointing that tag at an ROI routes its successes
 * there. Human creators auto-match by email (User.email is non-null in the
 * schema, so app users carry one too - never used for person matching).
 * Unmatched actors land in Resolve. One shared app creating everything
 * routes by the team -> ROI mapping chosen at connect (listProjects =
 * Linear teams).
 *
 * Paging: one GraphQL issues() query per fetchPage, filtered on updatedAt,
 * walked with Linear's own endCursor - it rides in sync_runs.cursor via the
 * framework, so a failed run resumes at the exact page. Linear serves full
 * history; backfill is pinned to 365 days.
 */

export const LINEAR_HISTORY_LIMIT_DAYS = 365;
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Issues per page - each carries its history, so pages stay small. */
const PAGE_SIZE = 50;
/** State changes read per issue - the machine's decisive events are early. */
const HISTORY_SIZE = 50;

const VIEWER_QUERY = "{ viewer { id email } }";
const ACTOR_FIELDS = "{ id displayName email app }";
const ISSUES_QUERY =
  "query Issues($from: DateTimeOrDuration!, $to: DateTimeOrDuration!, $after: String) { " +
  `issues(first: ${PAGE_SIZE}, after: $after, filter: { updatedAt: { gte: $from, lt: $to } }) { ` +
  "nodes { identifier title url createdAt team { key } state { name type } " +
  `creator ${ACTOR_FIELDS} assignee ${ACTOR_FIELDS} delegate ${ACTOR_FIELDS} ` +
  `history(first: ${HISTORY_SIZE}) { nodes { createdAt fromState { name type } toState { name type } } } } ` +
  "pageInfo { hasNextPage endCursor } } }";
const TEAMS_QUERY =
  "query Teams($after: String) { teams(first: 100, after: $after) { " +
  "nodes { key name } pageInfo { hasNextPage endCursor } } }";

export interface LinearRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export function viewerRequest(): LinearRequest {
  return { query: VIEWER_QUERY };
}

export function teamsRequest(after: string | null = null): LinearRequest {
  return { query: TEAMS_QUERY, variables: { after } };
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
    const first = parseStrict(
      "linear error",
      (body.errors as unknown[])[0],
      { message: nonEmptyStr },
      { extensions: isObj, locations: isArr, path: isArr },
    );
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

/** Linear's closed workflow-state enum -> board bucket (WorkflowState.type:
 * triage, backlog, unstarted, started, completed, canceled, duplicate).
 * Anything new is format drift and throws (recorded fixtures turn that into
 * CI). */
const STATE_BUCKETS: Record<string, StatusBucket> = {
  triage: "todo",
  backlog: "todo",
  unstarted: "todo",
  started: "doing",
  completed: "done",
  canceled: "todo",
  // Closed as a duplicate of another issue - not this issue's success.
  duplicate: "todo",
};

function bucketOf(label: string, type: string): StatusBucket {
  const bucket = STATE_BUCKETS[type];
  if (bucket === undefined) {
    throw new Error(`${label}: unknown workflow state type ${JSON.stringify(type)}`);
  }
  return bucket;
}

interface LinearActor {
  id: string;
  /** User.app - true for agent/app actors (Linear agents are app users). */
  agent: boolean;
  email: string | null;
  displayName: string | null;
}

function parseActor(label: string, raw: unknown): LinearActor | null {
  if (raw === null || raw === undefined) return null;
  const actor = parseStrict(label, raw, {
    id: nonEmptyStr,
    displayName: strOrNull,
    email: strOrNull,
    app: isBool,
  });
  return {
    id: actor.id as string,
    agent: actor.app as boolean,
    email: actor.email as string | null,
    displayName: actor.displayName as string | null,
  };
}

function parseState(label: string, raw: unknown): { name: string; type: string } {
  const state = parseStrict(label, raw, { name: nonEmptyStr, type: nonEmptyStr });
  return { name: state.name as string, type: state.type as string };
}

function utcIso(label: string, ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}: unreadable timestamp ${JSON.stringify(ts)}`);
  }
  return new Date(parsed).toISOString();
}

interface ParsedIssue {
  identifier: string;
  title: string | null;
  url: string;
  team: string;
  creator: LinearActor | null;
  assignee: LinearActor | null;
  /** The agent user working the issue (Issue.delegate) - agents put on an
   * issue land here, not in assignee. */
  delegate: LinearActor | null;
  transitions: StatusTransition[];
}

function parseIssue(raw: unknown): ParsedIssue {
  const issue = parseStrict("linear issue", raw, {
    identifier: nonEmptyStr,
    title: strOrNull,
    url: nonEmptyStr,
    createdAt: nonEmptyStr,
    team: isObj,
    state: isObj,
    creator: (v) => v === null || isObj(v),
    assignee: (v) => v === null || isObj(v),
    delegate: (v) => v === null || isObj(v),
    history: isObj,
  });
  const label = `linear issue ${String(issue.identifier)}`;
  const team = parseStrict(`${label} team`, issue.team, { key: nonEmptyStr });
  const state = parseState(`${label} state`, issue.state);
  const history = parseStrict(`${label} history`, issue.history, { nodes: isArr });

  // Rebuild the state timeline: history nodes with a toState are the state
  // changes (other history entries carry null from/to states).
  const moves: (StatusTransition & { fromState: { name: string; type: string } | null })[] =
    [];
  for (const rawNode of history.nodes as unknown[]) {
    const node = parseStrict(`${label} history node`, rawNode, {
      createdAt: nonEmptyStr,
      fromState: (v) => v === null || isObj(v),
      toState: (v) => v === null || isObj(v),
    });
    if (node.toState === null) continue;
    const to = parseState(`${label} toState`, node.toState);
    moves.push({
      ts: utcIso(label, node.createdAt as string),
      name: to.name,
      bucket: bucketOf(`${label} toState`, to.type),
      fromState:
        node.fromState === null ? null : parseState(`${label} fromState`, node.fromState),
    });
  }
  moves.sort((a, b) => a.ts.localeCompare(b.ts));
  const transitions: StatusTransition[] = moves.map(({ ts, name, bucket }) => ({
    ts,
    name,
    bucket,
  }));
  // The issue was born in its FIRST state - history only records moves out
  // of it. An untouched issue sits in its current state.
  const initial = moves.length > 0 ? moves[0].fromState : state;
  if (initial !== null) {
    transitions.unshift({
      ts: utcIso(label, issue.createdAt as string),
      name: initial.name,
      bucket: bucketOf(`${label} initial state`, initial.type),
    });
  }

  return {
    identifier: issue.identifier as string,
    title: issue.title as string | null,
    url: issue.url as string,
    team: team.key as string,
    creator: parseActor(`${label} creator`, issue.creator),
    assignee: parseActor(`${label} assignee`, issue.assignee),
    delegate: parseActor(`${label} delegate`, issue.delegate),
    transitions,
  };
}

function describeActor(actor: LinearActor): IdentityInput {
  return {
    externalId: actor.id,
    kind: "user",
    // App users carry a synthetic email - never feed it to person matching.
    email: actor.agent ? undefined : (actor.email ?? undefined),
    displayName: actor.displayName ?? undefined,
    tags: actor.agent && actor.displayName ? [agentTag(actor.displayName)] : [],
  };
}

/** Credit (spec 7): the agent when it is on the issue - the delegate did the
 * work (Linear puts a working agent in delegate, not assignee), else an
 * agent assignee or creator - otherwise the human creator, by email. */
function creditedActor(issue: ParsedIssue): LinearActor | null {
  if (issue.delegate?.agent) return issue.delegate;
  if (issue.assignee?.agent) return issue.assignee;
  if (issue.creator?.agent) return issue.creator;
  return issue.creator ?? issue.assignee;
}

export const linearConnector: Connector = {
  vendor: "linear",
  displayName: "Linear",
  successOnly: true,
  outcomeKinds: ["issue_done"],
  historyLimitDays: LINEAR_HISTORY_LIMIT_DAYS,
  connectNotes: [
    "Success-only: counts issues, writes no spend. An issue that hits the submitted state goes pending; it succeeds when the window passes without regressing (or it reaches Done sooner) and fails if it regresses inside the window - all read from the issue history.",
    "Defaults: submitted = any started state, fail = back to backlog/unstarted/canceled, window 30 days - override below per connection.",
    "Credit: an agent working the issue (its delegate) or an agent creator, by name (agents are first-class app users; the name becomes a tag - point it at an ROI); otherwise the issue creator, matched by email. Map teams to ROIs on this card once connected.",
    "Needs a personal or workspace API key with read access.",
  ],
  configFields: [
    { key: "apiKey", label: "API key", secret: true },
    {
      key: "submittedStatus",
      label: "Submitted state",
      optional: true,
      placeholder: "any started state",
    },
    {
      key: "failStatus",
      label: "Fail state",
      optional: true,
      placeholder: "backlog / unstarted / canceled",
    },
    { key: "windowDays", label: "Window (days)", optional: true, placeholder: "30" },
  ],

  async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
    const data = await linearJson(ctx, viewerRequest());
    parseStrict("linear viewer", data.viewer, { id: nonEmptyStr, email: strOrNull });
    return { scopes: ["read"] };
  },

  async listProjects(ctx: ConnectorContext): Promise<{ key: string; name: string }[]> {
    const all: { key: string; name: string }[] = [];
    let after: string | null = null;
    do {
      const data = await linearJson(ctx, teamsRequest(after));
      const teams = parseStrict("linear teams", data.teams, {
        nodes: isArr,
        pageInfo: isObj,
      });
      for (const raw of teams.nodes as unknown[]) {
        const team = parseStrict("linear team", raw, {
          key: nonEmptyStr,
          name: nonEmptyStr,
        });
        all.push({ key: team.key as string, name: team.name as string });
      }
      const pageInfo = parseStrict("linear teams pageInfo", teams.pageInfo, {
        hasNextPage: isBool,
        endCursor: strOrNull,
      });
      after = pageInfo.hasNextPage ? (pageInfo.endCursor as string | null) : null;
      if (pageInfo.hasNextPage && after === null) {
        throw new Error("linear teams pageInfo says hasNextPage with no endCursor");
      }
    } while (after !== null);
    return all;
  },

  async fetchPage(
    ctx: ConnectorContext,
    window: SyncWindow,
    pageToken: string | null,
  ): Promise<ConnectorPage> {
    const data = await linearJson(ctx, issuesRequest(window, pageToken));
    const issuesEnv = parseStrict("linear issues", data.issues, {
      nodes: isArr,
      pageInfo: isObj,
    });
    const pageInfo = parseStrict("linear pageInfo", issuesEnv.pageInfo, {
      hasNextPage: isBool,
      endCursor: strOrNull,
    });

    const stateConfig: IssueStateConfig = {
      submittedStatus: ctx.config.submittedStatus,
      failStatus: ctx.config.failStatus,
    };
    const identities = new Map<string, IdentityInput>();
    const issues: IssueInput[] = [];
    for (const raw of issuesEnv.nodes as unknown[]) {
      const issue = parseIssue(raw);
      for (const actor of [issue.creator, issue.assignee, issue.delegate]) {
        if (actor !== null) identities.set(actor.id, describeActor(actor));
      }
      const credited = creditedActor(issue);
      const events = distillTransitions(issue.transitions, stateConfig);
      issues.push({
        sourceRef: issue.url,
        key: issue.identifier,
        title: issue.title ?? undefined,
        project: issue.team,
        identity: credited ? { externalId: credited.id, kind: "user" } : undefined,
        submittedAt: events.submittedAt ?? undefined,
        doneAt: events.doneAt ?? undefined,
        regressedAt: events.regressedAt ?? undefined,
      });
    }

    const hasNext = pageInfo.hasNextPage as boolean;
    const endCursor = pageInfo.endCursor as string | null;
    if (hasNext && endCursor === null) {
      throw new Error("linear pageInfo says hasNextPage with no endCursor");
    }
    return {
      identities: [...identities.values()],
      facts: [],
      issues,
      nextPageToken: hasNext ? endCursor : null,
    };
  },
};
