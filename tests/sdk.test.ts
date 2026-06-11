import { afterEach, describe, expect, it, vi } from "vitest";
import { FLUSH_BATCH, MAX_BUFFER, Pnl } from "../sdk/src/client";
import type { CallEvent, IngestEvent, OutcomeEvent } from "../sdk/src/types";

/**
 * @ai-pnl/sdk (spec 6), against faithful fakes of the vendor clients (the
 * exact response/stream shapes the OpenAI and Anthropic SDKs produce -
 * the SDK speaks structural typing, so the shapes ARE the contract):
 * wrap() counting calls from usage fields incl. streaming, track() with
 * request-context token attach, batching/flush triggers, the 10k
 * oldest-dropped buffer, and fail-open everywhere.
 */

interface Captured {
  url: string;
  auth: string | null;
  events: IngestEvent[];
}

/** A capturing ingest server: 200 + per-event accepted verdicts. */
function captureServer(statusPlan: number[] = []) {
  const requests: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: IngestEvent[] };
    requests.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      events: body.events,
    });
    const status = statusPlan.shift() ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: "boom" }), { status });
    return Response.json({
      results: body.events.map((e) => ({ id: e.id, status: "accepted" })),
    });
  }) as typeof fetch;
  return { requests, fetch: fetchImpl };
}

function makePnl(over: ConstructorParameters<typeof Pnl>[0] = {}) {
  const server = captureServer();
  const pnl = new Pnl({
    url: "http://pnl.test",
    key: "pnl_test",
    roi: "support-bot",
    fetch: server.fetch,
    ...over,
  });
  return { pnl, server };
}

/** The OpenAI client shape: chat.completions.create + usage fields. */
function fakeOpenAI() {
  const calls: unknown[] = [];
  const client = {
    apiKey: "sk-test",
    chat: {
      completions: {
        async create(params: { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } }) {
          calls.push(params);
          if (params.stream) {
            expect(params.stream_options).toEqual({ include_usage: true });
            return (async function* () {
              yield { id: "c1", model: "gpt-4o-mini-2024-07-18", choices: [{ delta: { content: "He" } }], usage: null };
              yield { id: "c1", model: "gpt-4o-mini-2024-07-18", choices: [{ delta: { content: "llo" } }], usage: null };
              yield { id: "c1", model: "gpt-4o-mini-2024-07-18", choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
            })();
          }
          return {
            id: "chatcmpl-1",
            model: "gpt-4o-mini-2024-07-18",
            choices: [{ message: { role: "assistant", content: "Hello" } }],
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
          };
        },
      },
    },
    embeddings: {
      async create(params: { model: string }) {
        calls.push(params);
        return {
          data: [{ embedding: [0.1] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 8, total_tokens: 8 },
        };
      },
    },
  };
  return { client, calls };
}

/** The Anthropic client shape: messages.create / messages.stream. */
function fakeAnthropic() {
  const streamHandlers = new Map<string, (arg: unknown) => void>();
  const client = {
    messages: {
      async create(params: { model: string; stream?: boolean }) {
        if (params.stream) {
          return (async function* () {
            yield {
              type: "message_start",
              message: { model: "claude-sonnet-4-5", usage: { input_tokens: 80, output_tokens: 1 } },
            };
            yield { type: "content_block_delta", delta: { text: "Hi" } };
            yield { type: "message_delta", usage: { output_tokens: 25 } };
            yield { type: "message_stop" };
          })();
        }
        return {
          id: "msg-1",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Hi" }],
          usage: { input_tokens: 200, output_tokens: 40 },
        };
      },
      stream() {
        return {
          on(event: string, handler: (arg: unknown) => void) {
            streamHandlers.set(event, handler);
            return this;
          },
        };
      },
    },
  };
  return { client, streamHandlers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("@ai-pnl/sdk wrap()", () => {
  it("counts OpenAI chat + embeddings calls from the response usage fields", async () => {
    const { pnl, server } = makePnl();
    const { client } = fakeOpenAI();
    const ai = pnl.wrap(client, { employee: "dana@acme.com" });

    const res = (await ai.chat.completions.create({ model: "gpt-4o-mini" })) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(res.choices[0].message.content).toBe("Hello"); // untouched
    await ai.embeddings.create({ model: "text-embedding-3-small" });
    await pnl.flush();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe("http://pnl.test/api/ingest");
    expect(server.requests[0].auth).toBe("Bearer pnl_test");
    const [chat, embed] = server.requests[0].events as CallEvent[];
    expect(chat).toMatchObject({
      kind: "call",
      vendor: "openai",
      model: "gpt-4o-mini-2024-07-18",
      inputTokens: 120,
      outputTokens: 30,
      roi: "support-bot",
      employee: "dana@acme.com",
    });
    expect(chat.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(embed).toMatchObject({ model: "text-embedding-3-small", inputTokens: 8, outputTokens: 0 });
  });

  it("counts OpenAI streams: include_usage injected, chunks pass through intact", async () => {
    const { pnl, server } = makePnl();
    const ai = pnl.wrap(fakeOpenAI().client);

    const stream = await ai.chat.completions.create({ model: "gpt-4o-mini", stream: true });
    const seen: string[] = [];
    for await (const chunk of stream as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>) {
      seen.push(chunk.choices[0]?.delta?.content ?? "");
    }
    expect(seen).toEqual(["He", "llo", ""]);
    await pnl.flush();

    expect(server.requests[0].events[0]).toMatchObject({
      kind: "call",
      vendor: "openai",
      model: "gpt-4o-mini-2024-07-18",
      inputTokens: 50,
      outputTokens: 10,
    });
  });

  it("counts Anthropic calls, streams and messages.stream() finalMessage", async () => {
    const { pnl, server } = makePnl();
    const { client, streamHandlers } = fakeAnthropic();
    const claude = pnl.wrap(client);

    await claude.messages.create({ model: "claude-sonnet-4-5" });

    const stream = await claude.messages.create({ model: "claude-sonnet-4-5", stream: true });
    for await (const event of stream as AsyncIterable<unknown>) void event;

    claude.messages.stream();
    streamHandlers.get("finalMessage")?.({
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 9, output_tokens: 3 },
    });

    await pnl.flush();
    const events = server.requests[0].events as CallEvent[];
    expect(events.map((e) => [e.vendor, e.inputTokens, e.outputTokens])).toEqual([
      ["anthropic", 200, 40],
      ["anthropic", 80, 25],
      ["anthropic", 9, 3],
    ]);
  });

  it("fails open: unrecognized clients, vendor errors and SDK bugs never break the host", async () => {
    const { pnl } = makePnl();
    const notAClient = { complete: async () => "hi" };
    expect(pnl.wrap(notAClient)).toBe(notAClient);

    const failing = {
      chat: {
        completions: {
          async create() {
            throw new Error("vendor down");
          },
        },
      },
    };
    const wrapped = pnl.wrap(failing);
    await expect(wrapped.chat.completions.create()).rejects.toThrow("vendor down");
    expect(pnl.pending()).toHaveLength(0); // nothing counted, nothing broken

    // A response with no usage records nothing - no fake numbers.
    const usageless = {
      chat: { completions: { async create() { return { model: "gpt-4o", choices: [] }; } } },
    };
    await pnl.wrap(usageless).chat.completions.create();
    expect(pnl.pending()).toHaveLength(0);
  });
});

describe("@ai-pnl/sdk track() + context", () => {
  it("records value, ref and employee; request-context tokens attach automatically", async () => {
    const { pnl, server } = makePnl();
    const ai = pnl.wrap(fakeOpenAI().client);

    await pnl.context({ employee: "dana@acme.com" }, async () => {
      await ai.chat.completions.create({ model: "gpt-4o-mini" });
      pnl.track("ticket_resolved", { value: 4.5, ref: "ZD-3141" });
    });
    await pnl.flush();

    const [callEvent, outcome] = server.requests[0].events as [CallEvent, OutcomeEvent];
    expect(callEvent.employee).toBe("dana@acme.com"); // from the context
    expect(outcome).toMatchObject({
      kind: "outcome",
      outcome: "ticket_resolved",
      valueCents: 450,
      currency: "USD",
      ref: "ZD-3141",
      employee: "dana@acme.com",
      roi: "support-bot",
      tokens: { inputTokens: 120, outputTokens: 30, calls: [callEvent.id] },
    });
  });

  it("middleware opens a context for the request", async () => {
    const { pnl, server } = makePnl();
    const handler = pnl.middleware<{ email: string }, unknown>((req) => ({ employee: req.email }));
    await new Promise<void>((resolve) => {
      handler({ email: "bob@acme.com" }, {}, () => {
        pnl.track("lead_scored");
        resolve();
      });
    });
    await pnl.flush();
    expect(server.requests[0].events[0]).toMatchObject({
      kind: "outcome",
      outcome: "lead_scored",
      employee: "bob@acme.com",
    });
  });

  it("outside a context nothing attaches; bad input is dropped, not thrown", async () => {
    const { pnl, server } = makePnl();
    pnl.track("plain");
    pnl.track(""); // dropped
    pnl.track("bad_value", { value: -1 }); // dropped
    await pnl.flush();
    const events = server.requests[0].events as OutcomeEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].tokens).toBeUndefined();
    expect(events[0].employee).toBeUndefined();
  });

  it('the pre-rename "product" option still works everywhere as a silent roi alias', async () => {
    const { pnl, server } = makePnl({ roi: undefined, product: "support-bot" });
    const ai = pnl.wrap(fakeOpenAI().client, { product: "support-bot" });
    await ai.chat.completions.create({ model: "gpt-4o-mini" });
    pnl.track("ticket_resolved", { product: "support-bot" });
    pnl.track("roi_wins", { roi: "explicit", product: "ignored" }); // roi outranks the alias
    await pnl.flush();

    const [call, outcome, mixed] = server.requests[0].events as [CallEvent, OutcomeEvent, OutcomeEvent];
    expect(call).toMatchObject({ kind: "call", roi: "support-bot" });
    expect(call.product).toBeUndefined(); // the wire speaks roi
    expect(outcome).toMatchObject({ kind: "outcome", roi: "support-bot" });
    expect(mixed.roi).toBe("explicit");
  });
});

describe("@ai-pnl/sdk buffering + flush", () => {
  it("flushes every 5 seconds", async () => {
    vi.useFakeTimers();
    const { pnl, server } = makePnl();
    pnl.track("tick");
    expect(server.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.requests).toHaveLength(1);
  });

  it("flushes at 100 buffered events, in batches of 100", async () => {
    const { pnl, server } = makePnl();
    for (let i = 0; i < FLUSH_BATCH + 20; i++) pnl.track("bulk", { ref: `r${i}` });
    await pnl.flush();
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    expect(server.requests[0].events).toHaveLength(FLUSH_BATCH);
    const total = server.requests.reduce((n, r) => n + r.events.length, 0);
    expect(total).toBe(FLUSH_BATCH + 20);
    expect(pnl.pending()).toHaveLength(0);
  });

  it("caps the buffer at 10k, dropping the oldest", () => {
    // No url -> nothing can flush; events accumulate.
    const pnl = new Pnl({ key: "pnl_test" });
    const extra = 5;
    for (let i = 0; i < MAX_BUFFER + extra; i++) pnl.track("burst", { ref: `e${i}` });
    const pending = pnl.pending() as OutcomeEvent[];
    expect(pending).toHaveLength(MAX_BUFFER);
    expect(pending[0].ref).toBe(`e${extra}`); // e0..e4 dropped
    expect(pending[pending.length - 1].ref).toBe(`e${MAX_BUFFER + extra - 1}`);
  });

  it("retries on 5xx and network errors with the SAME event UUIDs; drops on 4xx", async () => {
    const server = captureServer([500]);
    const { pnl } = makePnl({ fetch: server.fetch });
    pnl.track("keep", { ref: "k1" });
    await pnl.flush();
    expect(pnl.pending()).toHaveLength(1); // retained for retry
    await pnl.flush();
    expect(pnl.pending()).toHaveLength(0);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].events[0].id).toBe(server.requests[0].events[0].id);

    // Network down: never throws, keeps the events.
    const down = new Pnl({
      url: "http://pnl.test",
      key: "k",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    down.track("offline");
    await expect(down.flush()).resolves.toBeUndefined();
    expect(down.pending()).toHaveLength(1);

    // 4xx: retrying cannot help - the batch is dropped, loudly.
    const bad = captureServer([400]);
    const dropper = makePnl({ fetch: bad.fetch }).pnl;
    dropper.track("doomed");
    await dropper.flush();
    expect(dropper.pending()).toHaveLength(0);
  });
});
