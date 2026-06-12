import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CallEvent, IngestEvent, IngestResult, OutcomeEvent } from "./types.js";
import { detectVendor, wrapClient, type RecordedCall } from "./wrap.js";

/**
 * The Tokenturn client (spec 6). Fail-open always: nothing in here ever
 * throws into the host app - bad input is logged and dropped, an
 * unreachable server buffers and retries, a full buffer drops the oldest
 * events. Events carry client-side UUIDs and the server upserts on them,
 * so retrying after a lost response can never double-count.
 */

export const MAX_BUFFER = 10_000;
export const FLUSH_INTERVAL_MS = 5_000;
export const FLUSH_BATCH = 100;
const LOG_THROTTLE_MS = 60_000;

export interface PnlConfig {
  /** Your Tokenturn server, e.g. "https://pnl.internal.example.com".
   * Falls back to the AI_PNL_URL environment variable. */
  url?: string;
  /** Ingest key minted in Settings (shown once, scoped to one ROI).
   * Falls back to the AI_PNL_KEY environment variable. */
  key?: string;
  /** ROI name for events that don't set one - must match the key's. */
  roi?: string;
  /** @deprecated Use `roi`. Accepted silently as an alias. */
  product?: string;
  /** Test injection points. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface WrapOptions {
  /** The ROI the wrapped client's calls count toward - must match the key's. */
  roi?: string;
  /** @deprecated Use `roi`. Accepted silently as an alias. */
  product?: string;
  /** Attribute every call from this wrapped client to one employee.
   * Per-request attribution belongs in context() instead. */
  employee?: string;
}

export interface TrackOptions {
  /** Value of the outcome in currency units (4.5 = $4.50). */
  value?: number;
  /** ISO-4217; default USD when a value is set. */
  currency?: string;
  /** The real record behind the outcome (ticket id, coupon id). */
  ref?: string;
  employee?: string;
  /** The ROI the success counts toward - must match the key's. */
  roi?: string;
  /** @deprecated Use `roi`. Accepted silently as an alias. */
  product?: string;
}

export interface ContextOptions {
  /** Employee for everything recorded inside this context. */
  employee?: string;
}

interface RequestContext {
  employee?: string;
  inputTokens: number;
  outputTokens: number;
  calls: string[];
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

export class Pnl {
  private config: PnlConfig;
  private buffer: IngestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private storage = new AsyncLocalStorage<RequestContext>();
  private lastLog = new Map<string, number>();

  constructor(config: PnlConfig = {}) {
    this.config = config;
  }

  /** Merge configuration; chainable. */
  configure(config: PnlConfig): this {
    this.config = { ...this.config, ...config };
    return this;
  }

  /**
   * Wrap an OpenAI or Anthropic client so every call is counted - token
   * counts from the response usage fields, streaming included. The client
   * is recognized structurally; an unrecognized one is returned unwrapped
   * (logged, never thrown).
   */
  wrap<T extends object>(client: T, opts: WrapOptions = {}): T {
    try {
      const vendor = detectVendor(client);
      if (!vendor) {
        this.log(
          "wrap",
          "client not recognized as an OpenAI or Anthropic SDK instance - returning it unwrapped",
        );
        return client;
      }
      return wrapClient(client, vendor, (call) => this.recordCall(call, opts));
    } catch (err) {
      this.log("wrap", `wrap() failed (${String(err)}) - returning the client unwrapped`);
      return client;
    }
  }

  /**
   * Record a success and its value. `ref` becomes the outcome's source_ref
   * (the ticket id / coupon id every displayed number drills down to);
   * tokens spent in the current request context attach automatically.
   */
  track(kind: string, opts: TrackOptions = {}): void {
    try {
      if (typeof kind !== "string" || kind.trim().length === 0) {
        this.log("track", "track() needs a non-empty outcome kind - event dropped");
        return;
      }
      const event: OutcomeEvent = {
        id: randomUUID(),
        kind: "outcome",
        ts: this.now().toISOString(),
        outcome: kind.trim(),
      };
      if (opts.value !== undefined) {
        if (typeof opts.value !== "number" || !Number.isFinite(opts.value) || opts.value < 0) {
          this.log("track", `track("${kind}") value must be a non-negative number - event dropped`);
          return;
        }
        event.valueCents = Math.round(opts.value * 100);
        event.currency = (opts.currency ?? "USD").toUpperCase();
      }
      if (opts.ref !== undefined) event.ref = String(opts.ref);
      const store = this.storage.getStore();
      const employee = opts.employee ?? store?.employee;
      if (employee) event.employee = employee;
      const roi = this.resolveRoi(opts);
      if (roi) event.roi = roi;
      if (store && store.calls.length > 0) {
        event.tokens = {
          inputTokens: store.inputTokens,
          outputTokens: store.outputTokens,
          calls: [...store.calls],
        };
      }
      this.push(event);
    } catch (err) {
      this.log("track", `track() failed (${String(err)}) - event dropped`);
    }
  }

  /**
   * Run a function inside a request context: wrapped calls made within it
   * accumulate tokens that attach to any track() in the same context, and
   * an `employee` set here attributes everything recorded inside.
   */
  context<T>(fn: () => T): T;
  context<T>(opts: ContextOptions, fn: () => T): T;
  context<T>(a: ContextOptions | (() => T), b?: () => T): T {
    const opts = typeof a === "function" ? {} : a;
    const fn = typeof a === "function" ? a : (b as () => T);
    return this.storage.run(
      { employee: opts.employee, inputTokens: 0, outputTokens: 0, calls: [] },
      fn,
    );
  }

  /** Express-style middleware: opens a request context (optionally with the
   * employee read off the request) for the rest of the request. */
  middleware<Req, Res>(
    getOptions?: (req: Req) => ContextOptions | undefined,
  ): (req: Req, res: Res, next: () => void) => void {
    return (req, _res, next) => {
      let opts: ContextOptions = {};
      if (getOptions) {
        try {
          opts = getOptions(req) ?? {};
        } catch (err) {
          this.log("middleware", `employee lookup failed (${String(err)}) - continuing without`);
        }
      }
      this.context(opts, next);
    };
  }

  /**
   * Send everything buffered, now. Flushes also happen on their own every
   * 5 seconds and whenever 100 events are waiting; call this at the end of
   * short-lived scripts. Never rejects.
   */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush()).catch(() => {});
    return this.flushChain;
  }

  /** Test-only: a copy of the not-yet-flushed events. */
  pending(): IngestEvent[] {
    return [...this.buffer];
  }

  private recordCall(call: RecordedCall, opts: WrapOptions): void {
    const id = randomUUID();
    const event: CallEvent = {
      id,
      kind: "call",
      ts: this.now().toISOString(),
      vendor: call.vendor,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
    };
    const store = this.storage.getStore();
    const employee = opts.employee ?? store?.employee;
    if (employee) event.employee = employee;
    const roi = this.resolveRoi(opts);
    if (roi) event.roi = roi;
    if (store) {
      store.inputTokens += call.inputTokens;
      store.outputTokens += call.outputTokens;
      store.calls.push(id);
    }
    this.push(event);
  }

  /** `roi` everywhere new; the old `product` key is a silent alias. */
  private resolveRoi(opts: { roi?: string; product?: string }): string | undefined {
    return opts.roi ?? opts.product ?? this.config.roi ?? this.config.product;
  }

  private push(event: IngestEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      const dropped = this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, dropped);
      this.log("buffer", `buffer full (${MAX_BUFFER}) - dropped the ${dropped} oldest event(s)`);
    }
    this.ensureTimer();
    if (this.buffer.length >= FLUSH_BATCH) void this.flush();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Never hold the process open - short scripts call flush() themselves.
    this.timer.unref?.();
  }

  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const url = this.config.url ?? env("AI_PNL_URL");
    const key = this.config.key ?? env("AI_PNL_KEY");
    if (!url || !key) {
      this.log("config", "Tokenturn url/key not configured (AI_PNL_URL / AI_PNL_KEY) - buffering");
      return;
    }
    const doFetch = this.config.fetch ?? fetch;
    const endpoint = `${url.replace(/\/+$/, "")}/api/ingest`;

    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, FLUSH_BATCH);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ events: batch }),
        });
      } catch (err) {
        this.requeue(batch);
        this.log("flush", `ingest unreachable (${String(err)}) - will retry`);
        return;
      }
      if (res.status === 429 || res.status >= 500) {
        this.requeue(batch);
        this.log("flush", `ingest returned ${res.status} - will retry`);
        return;
      }
      if (!res.ok) {
        // 4xx: retrying cannot help - drop the batch, say why.
        let detail = "";
        try {
          detail = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          // body unreadable - the status is all we have
        }
        this.log("flush", `ingest returned ${res.status} (${detail}) - dropped ${batch.length} event(s)`);
        continue;
      }
      try {
        const body = (await res.json()) as { results?: IngestResult[] };
        const rejected = (body.results ?? []).filter((r) => r.status === "rejected");
        if (rejected.length > 0) {
          this.log(
            "rejected",
            `${rejected.length} event(s) rejected, e.g.: ${rejected[0].error ?? "no reason given"}`,
          );
        }
      } catch {
        // verdicts unreadable - the events were accepted, nothing to do
      }
    }
  }

  /** Put a failed batch back at the FRONT (it holds the oldest events);
   * when that overflows the cap, the oldest still drop first. */
  private requeue(batch: IngestEvent[]): void {
    const merged = [...batch, ...this.buffer];
    this.buffer = merged.slice(Math.max(0, merged.length - MAX_BUFFER));
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  /** console.error, throttled per scope - never spams a hot path. */
  private log(scope: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastLog.get(scope) ?? 0) < LOG_THROTTLE_MS) return;
    this.lastLog.set(scope, now);
    console.error(`[tokenturn] ${message}`);
  }
}
