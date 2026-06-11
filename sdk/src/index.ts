export {
  Pnl,
  type PnlConfig,
  type WrapOptions,
  type TrackOptions,
  type ContextOptions,
} from "./client.js";
export type {
  CallEvent,
  IngestEvent,
  IngestResult,
  OutcomeEvent,
  OutcomeTokens,
  Vendor,
} from "./types.js";

import { Pnl } from "./client.js";

/**
 * The default client. Configure once (or set AI_PNL_URL / AI_PNL_KEY):
 *
 *   import { pnl } from "@ai-pnl/sdk";
 *
 *   pnl.configure({ url: "https://pnl.internal", key: "pnl_...", roi: "support-bot" });
 *   const ai = pnl.wrap(openai, { roi: "support-bot" });
 *   pnl.track("ticket_resolved", { value: 4.5, employee: "dana@acme.com" });
 *
 * Apps with several ROIs mint one ingest key each and create one
 * `new Pnl({...})` per ROI.
 */
export const pnl = new Pnl();
