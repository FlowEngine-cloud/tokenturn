/** Wire types shared with the AI P&L ingest API (POST /api/ingest). */

export type Vendor = "openai" | "anthropic";

/** One wrapped vendor call - token counts from the response usage fields. */
export interface CallEvent {
  /** Client-side UUID: the server upserts on it, so retries are safe. */
  id: string;
  kind: "call";
  /** ISO timestamp of the call. */
  ts: string;
  vendor: Vendor;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Must match the ingest key's ROI when set. */
  roi?: string;
  /** @deprecated Older SDKs sent `product`; the server still accepts it. */
  product?: string;
  /** Employee email - attributes the spend to a person. */
  employee?: string;
}

/** Tokens spent in the request context a track() call happened in. */
export interface OutcomeTokens {
  inputTokens: number;
  outputTokens: number;
  /** Client UUIDs of the calls counted in the context. */
  calls: string[];
}

/** One tracked success (ticket resolved, coupon issued, ...). */
export interface OutcomeEvent {
  id: string;
  kind: "outcome";
  ts: string;
  /** The outcome kind, e.g. "ticket_resolved". */
  outcome: string;
  /** Per-outcome value in cents; currency accompanies it. */
  valueCents?: number;
  currency?: string;
  /** The real record behind the outcome (ticket id, coupon id) - becomes
   * source_ref, the thing every displayed number drills down to. */
  ref?: string;
  /** Must match the ingest key's ROI when set. */
  roi?: string;
  /** @deprecated Older SDKs sent `product`; the server still accepts it. */
  product?: string;
  employee?: string;
  tokens?: OutcomeTokens;
}

export type IngestEvent = CallEvent | OutcomeEvent;

/** Per-event verdict from the ingest API, in batch order. */
export interface IngestResult {
  id: string | null;
  status: "accepted" | "duplicate" | "rejected";
  error?: string;
}
