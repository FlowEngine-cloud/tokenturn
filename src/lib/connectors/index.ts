/**
 * Connector framework entry point. Vendor connectors (Anthropic, OpenAI,
 * Cursor, GitHub - spec 5) register here as they land, in this one place:
 *
 *   registerConnector(anthropicConnector);
 *
 * Routes and the scheduler import from this module so importing it is what
 * populates the registry.
 */

import { anthropicConnector } from "./anthropic";
import { cursorConnector } from "./cursor";
import { githubConnector } from "./github";
import { jiraConnector } from "./jira";
import { linearConnector } from "./linear";
import { openaiConnector } from "./openai";
import { registerConnector } from "./registry";

export {
  clearConnectors,
  getConnector,
  listConnectors,
  registerConnector,
} from "./registry";
export {
  connectConnector,
  disconnectConnector,
  getConnectorConfig,
  listConnectedRows,
  type ConnectedRow,
} from "./connect";
export { runSync, REPULL_DAYS, type SyncOpts, type SyncResult } from "./sync";
export {
  checkSilentConnectors,
  schedulerTick,
  startScheduler,
  SYNC_INTERVAL_MS,
} from "./scheduler";
export {
  allConnectorHealth,
  connectorHealth,
  type ConnectorHealth,
} from "./health";
export {
  DEFAULT_ISSUE_WINDOW_DAYS,
  distillTransitions,
  evaluateIssue,
  ISSUE_OUTCOME_KIND,
  listIssueProjectRoutes,
  listTrackedIssues,
  setIssueProjectRoute,
  windowDaysFrom,
  type IssueProjectRoute,
  type IssueStateConfig,
  type StatusBucket,
  type StatusTransition,
  type TrackedIssueRow,
} from "./issues";
export type {
  ConfigField,
  Connector,
  ConnectorContext,
  ConnectorPage,
  FactInput,
  IdentityInput,
  IssueInput,
  MetricInput,
  OutcomeInput,
  RevertInput,
  ScopeCheck,
  SyncCursor,
  SyncWindow,
} from "./types";
export { anthropicConnector } from "./anthropic";
export { cursorConnector } from "./cursor";
export { githubConnector } from "./github";
export { jiraConnector } from "./jira";
export { linearConnector } from "./linear";
export { openaiConnector } from "./openai";

registerConnector(anthropicConnector);
registerConnector(cursorConnector);
registerConnector(githubConnector);
registerConnector(jiraConnector);
registerConnector(linearConnector);
registerConnector(openaiConnector);
