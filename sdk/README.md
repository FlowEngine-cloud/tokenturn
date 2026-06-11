# @ai-pnl/sdk

The AI P&L TypeScript SDK. Wrap your OpenAI or Anthropic client so every call is counted - token counts from the response usage fields, streaming included - and track outcomes with real value, so the dashboard shows ROI instead of just burn.

- **Fail-open always.** SDK errors never break your app: bad input is logged and dropped, an unreachable server buffers and retries (cap 10,000 events, oldest dropped), a wrapped call always behaves exactly like the unwrapped one.
- **Zero runtime dependencies.** Node 18.18+, full TypeScript types, <1ms overhead per call.
- **Retry-safe.** Events carry client-side UUIDs and flush every 5 seconds or 100 events; the server upserts on the UUID, so a retry after a lost response can never double-count.

## Setup

1. In AI P&L, create a product (attribution `sdk` for call counting, outcome kind `sdk_event` for `track()`).
2. Mint an ingest key for it in Settings - it is shown once.
3. Give the SDK the server URL and key: `pnl.configure({ url, key })`, or set `AI_PNL_URL` and `AI_PNL_KEY`.

```ts
import { pnl } from "@ai-pnl/sdk";
import OpenAI from "openai";

const ai = pnl.wrap(new OpenAI(), { product: "support-bot" }); // counts every call

pnl.track("ticket_resolved", { value: 4.5, ref: "ZD-3141", employee: "dana@acme.com" });
```

`wrap()` recognizes OpenAI (`chat.completions`, `responses`, `embeddings`) and Anthropic (`messages.create`, `messages.stream`) clients structurally - no dependency on either SDK. For OpenAI chat streams it sets `stream_options.include_usage` so streamed calls report usage too.

`track(kind, opts)` records a success: `value` in currency units (4.5 = $4.50, `currency` defaults to USD), `ref` is the real record behind the outcome (ticket id, coupon id) - it becomes `source_ref`, the thing the dashboard drills down to. Tokens spent in the current request context attach automatically.

`employee` is an email; it attributes spend and outcomes to a person through the same Resolve machinery as every vendor identity.

## Next.js

```ts
// lib/pnl.ts - one shared instance, configured from your own config source
import { pnl } from "@ai-pnl/sdk";
import OpenAI from "openai";

pnl.configure({ product: "support-bot" }); // url/key from AI_PNL_URL / AI_PNL_KEY
export const ai = pnl.wrap(new OpenAI());
export { pnl };
```

```ts
// app/api/answer/route.ts
import { ai, pnl } from "@/lib/pnl";

export async function POST(req: Request) {
  const { question, user } = await req.json();
  return pnl.context({ employee: user }, async () => {
    const res = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    pnl.track("question_answered", { value: 0.5, ref: `q-${Date.now()}` });
    return Response.json({ answer: res.choices[0].message.content });
  });
}
```

## Express

```ts
import express from "express";
import OpenAI from "openai";
import { pnl } from "@ai-pnl/sdk";

pnl.configure({ url: process.env.AI_PNL_URL, key: process.env.AI_PNL_KEY, product: "support-bot" });
const ai = pnl.wrap(new OpenAI());

const app = express();
app.use(express.json());
app.use(pnl.middleware((req) => ({ employee: req.header("x-user-email") })));

app.post("/resolve", async (req, res) => {
  const completion = await ai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: req.body.ticket }],
  });
  pnl.track("ticket_resolved", { value: 4.5, ref: req.body.ticketId });
  res.json({ reply: completion.choices[0].message.content });
});

app.listen(3001);
```

## Plain script

```ts
import Anthropic from "@anthropic-ai/sdk";
import { pnl } from "@ai-pnl/sdk";

pnl.configure({ url: "http://localhost:3000", key: "pnl_...", product: "batch-tagger" });
const claude = pnl.wrap(new Anthropic(), { employee: "dana@acme.com" });

const msg = await claude.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 200,
  messages: [{ role: "user", content: "Tag this article: ..." }],
});
pnl.track("article_tagged", { ref: "article-77" });

await pnl.flush(); // short-lived process: send before exiting
```

## Several products in one app

An ingest key is scoped to one product. Create one client per product:

```ts
import { Pnl } from "@ai-pnl/sdk";

const supportBot = new Pnl({ url, key: SUPPORT_BOT_KEY, product: "support-bot" });
const brain = new Pnl({ url, key: BRAIN_KEY, product: "company-brain" });
```
