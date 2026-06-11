import type { Vendor } from "./types.js";

/**
 * wrap() internals: intercept OpenAI / Anthropic client calls and read
 * token counts from the response usage fields - streaming included.
 *
 * Structural typing only (zero runtime dependencies): a client is
 * recognized by the methods it carries, never by instanceof. Everything
 * not intercepted passes straight through a Proxy, and every observation
 * is wrapped in try/catch - an SDK bug must never break the host app.
 */

export interface RecordedCall {
  vendor: Vendor;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type RecordCall = (call: RecordedCall) => void;

type AnyObject = Record<PropertyKey, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

const isObject = (v: unknown): v is AnyObject => typeof v === "object" && v !== null;
const isFn = (v: unknown): v is AnyFn => typeof v === "function";

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // fail open - observation errors never reach the host app
  }
}

function methodAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function detectVendor(client: unknown): Vendor | null {
  if (isFn(methodAt(client, ["messages", "create"]))) return "anthropic";
  if (
    isFn(methodAt(client, ["chat", "completions", "create"])) ||
    isFn(methodAt(client, ["responses", "create"])) ||
    isFn(methodAt(client, ["embeddings", "create"]))
  ) {
    return "openai";
  }
  return null;
}

/** Read token counts out of a usage object, whichever dialect it speaks:
 * OpenAI chat (prompt/completion_tokens), OpenAI responses + Anthropic
 * (input/output_tokens), embeddings (prompt_tokens only). */
function tokensFromUsage(usage: unknown): { input: number; output: number } | null {
  if (!isObject(usage)) return null;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const input = num(usage.input_tokens) ?? num(usage.prompt_tokens);
  const output = num(usage.output_tokens) ?? num(usage.completion_tokens);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

function modelOf(value: unknown): string | null {
  return isObject(value) && typeof value.model === "string" && value.model.length > 0
    ? value.model
    : null;
}

function recordFromResponse(
  vendor: Vendor,
  res: unknown,
  params: unknown,
  record: RecordCall,
): void {
  if (!isObject(res)) return;
  const tokens = tokensFromUsage(res.usage);
  const model = modelOf(res) ?? modelOf(params);
  if (!tokens || !model) return; // no usage reported = nothing to count
  record({ vendor, model, inputTokens: tokens.input, outputTokens: tokens.output });
}

interface StreamObserver {
  onChunk: (chunk: unknown) => void;
  onEnd: () => void;
}

/**
 * Accumulate usage across stream events. Counters are cumulative on both
 * vendors (Anthropic message_start carries input, message_delta the running
 * output; OpenAI's final chunk carries the whole usage), so max() per side
 * is exact. Records once, when the consumer finishes (or abandons) the
 * stream - and only if usage was actually observed: no fake numbers.
 */
function makeStreamObserver(
  vendor: Vendor,
  params: unknown,
  record: RecordCall,
): StreamObserver {
  let model = modelOf(params);
  let input: number | null = null;
  let output: number | null = null;
  let done = false;

  const onChunk = (chunk: unknown) => {
    if (!isObject(chunk)) return;
    let usage: unknown;
    if (vendor === "anthropic") {
      if (chunk.type === "message_start" && isObject(chunk.message)) {
        model = modelOf(chunk.message) ?? model;
        usage = chunk.message.usage;
      } else if (chunk.type === "message_delta") {
        usage = chunk.usage;
      }
    } else {
      model = modelOf(chunk) ?? model;
      usage = chunk.usage;
      if (chunk.type === "response.completed" && isObject(chunk.response)) {
        model = modelOf(chunk.response) ?? model;
        usage = chunk.response.usage;
      }
    }
    const tokens = tokensFromUsage(usage);
    if (tokens) {
      input = Math.max(input ?? 0, tokens.input);
      output = Math.max(output ?? 0, tokens.output);
    }
  };

  const onEnd = () => {
    if (done) return;
    done = true;
    if (model && (input !== null || output !== null)) {
      record({ vendor, model, inputTokens: input ?? 0, outputTokens: output ?? 0 });
    }
  };

  return { onChunk, onEnd };
}

/** Proxy a stream object: observe chunks through its async iterator, keep
 * every other property working against the original. */
function wrapStream<T extends object>(stream: T, observer: StreamObserver): T {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const inner = (target as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          const iterator: AsyncIterator<unknown> = {
            async next(...args) {
              const result = await inner.next(...args);
              if (result.done) safe(observer.onEnd);
              else safe(() => observer.onChunk(result.value));
              return result;
            },
            async return(value?: unknown) {
              safe(observer.onEnd);
              return inner.return
                ? inner.return(value)
                : { done: true as const, value: undefined };
            },
            async throw(err?: unknown) {
              safe(observer.onEnd);
              if (inner.throw) return inner.throw(err);
              throw err;
            },
          };
          return iterator;
        };
      }
      const value = Reflect.get(target, prop, target);
      // Bind methods to the real object: vendor SDK classes use #private
      // fields, which break when `this` is the proxy.
      return isFn(value) ? value.bind(target) : value;
    },
  });
}

function wrapCreate(
  orig: AnyFn,
  owner: object,
  vendor: Vendor,
  isChatCompletions: boolean,
  record: RecordCall,
): AnyFn {
  return function wrappedCreate(...args: unknown[]): unknown {
    let params = args[0];
    const streaming = isObject(params) && params.stream === true;

    // OpenAI chat streams only report usage when asked: inject
    // stream_options.include_usage so streamed calls still count.
    if (streaming && vendor === "openai" && isChatCompletions && isObject(params)) {
      const streamOptions = isObject(params.stream_options) ? params.stream_options : {};
      if (streamOptions.include_usage === undefined) {
        params = { ...params, stream_options: { ...streamOptions, include_usage: true } };
        args = [params, ...args.slice(1)];
      }
    }

    const result = orig.apply(owner, args);
    if (!isObject(result) || !isFn((result as { then?: unknown }).then)) {
      return result;
    }
    const promise = result as unknown as Promise<unknown>;

    if (!streaming) {
      // Side-listen and return the ORIGINAL promise untouched, so vendor
      // promise extras (.withResponse() etc.) keep working.
      safe(() => {
        promise.then(
          (res) => safe(() => recordFromResponse(vendor, res, params, record)),
          () => {}, // the caller owns errors; nothing to count on failure
        );
      });
      return result;
    }

    const observer = makeStreamObserver(vendor, params, record);
    return promise.then((stream) =>
      isObject(stream) ? wrapStream(stream, observer) : stream,
    );
  };
}

/** Anthropic's messages.stream() returns a MessageStream; its finalMessage
 * event carries the complete usage. Attach if the shape allows, else skip. */
function wrapMessagesStream(orig: AnyFn, owner: object, record: RecordCall): AnyFn {
  return function wrappedStream(...args: unknown[]): unknown {
    const result = orig.apply(owner, args);
    safe(() => {
      const on = isObject(result) ? result.on : undefined;
      if (!isFn(on)) return;
      on.call(result, "finalMessage", (message: unknown) => {
        safe(() => {
          if (!isObject(message)) return;
          const tokens = tokensFromUsage(message.usage);
          const model = modelOf(message) ?? modelOf(args[0]);
          if (tokens && model) {
            record({
              vendor: "anthropic",
              model,
              inputTokens: tokens.input,
              outputTokens: tokens.output,
            });
          }
        });
      });
    });
    return result;
  };
}

interface Leaf {
  path: string[];
  kind: "create" | "stream";
  chat?: boolean;
}

const LEAVES: Record<Vendor, Leaf[]> = {
  anthropic: [
    { path: ["messages", "create"], kind: "create" },
    { path: ["messages", "stream"], kind: "stream" },
  ],
  openai: [
    { path: ["chat", "completions", "create"], kind: "create", chat: true },
    { path: ["responses", "create"], kind: "create" },
    { path: ["embeddings", "create"], kind: "create" },
  ],
};

/** Wrap a vendor client: known call paths are intercepted, everything else
 * passes through untouched. */
export function wrapClient<T extends object>(
  client: T,
  vendor: Vendor,
  record: RecordCall,
): T {
  const leaves = LEAVES[vendor];

  function proxyAt(target: object, prefix: string[]): object {
    return new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (typeof prop !== "string") {
          return isFn(value) ? value.bind(t) : value;
        }
        const next = [...prefix, prop];
        const leaf = leaves.find(
          (l) => l.path.length === next.length && l.path.every((s, i) => s === next[i]),
        );
        if (leaf && isFn(value)) {
          return leaf.kind === "stream"
            ? wrapMessagesStream(value, t, record)
            : wrapCreate(value, t, vendor, Boolean(leaf.chat), record);
        }
        const onPath = leaves.some(
          (l) => l.path.length > next.length && next.every((s, i) => s === l.path[i]),
        );
        if (onPath && isObject(value)) return proxyAt(value, next);
        return isFn(value) ? value.bind(t) : value;
      },
    });
  }

  return proxyAt(client, []) as T;
}
