# ai-pnl (Python SDK)

The AI P&L Python SDK - full parity with [@ai-pnl/sdk](../sdk/README.md). Wrap your OpenAI or Anthropic client (sync or async) so every call is counted - token counts from the response usage fields, streaming included - and track outcomes with real value, so the dashboard shows ROI instead of just burn.

- **Fail-open always.** SDK errors never break your app: bad input is logged and dropped, an unreachable server buffers and retries (cap 10,000 events, oldest dropped), a wrapped call always behaves exactly like the unwrapped one.
- **Zero runtime dependencies.** Python 3.9+, stdlib only - HTTP is `urllib` on the background flush thread, where blocking I/O costs your app nothing; `httpx` would buy nothing but a dependency tree.
- **Retry-safe.** Events carry client-side UUIDs and flush every 5 seconds or 100 events; the server upserts on the UUID, so a retry after a lost response can never double-count.

## Setup

1. In AI P&L, create an ROI (spend source `sdk` for call counting, success kind `sdk_event` for `track()`).
2. Mint an ingest key for it in Settings - it is shown once.
3. Give the SDK the server URL and key: `pnl.configure(url=..., key=...)`, or set `AI_PNL_URL` and `AI_PNL_KEY`.

```python
from ai_pnl import pnl
from openai import OpenAI

ai = pnl.wrap(OpenAI(), roi="support-bot")  # counts every call

pnl.track("ticket_resolved", value=4.5, ref="ZD-3141", employee="dana@acme.com")
```

`wrap()` recognizes OpenAI (`chat.completions`, `responses`, `embeddings`) and Anthropic (`messages.create`, `messages.stream`) clients structurally - no dependency on either SDK, sync and async clients alike. For OpenAI chat streams it sets `stream_options={"include_usage": True}` so streamed calls report usage too.

`track(kind, ...)` records a success: `value` in currency units (4.5 = $4.50, `currency` defaults to USD), `ref` is the real record behind the outcome (ticket id, coupon id) - it becomes `source_ref`, the thing the dashboard drills down to. Tokens spent in the current request context attach automatically.

`employee` is an email; it attributes spend and outcomes to a person through the same Resolve machinery as every vendor identity.

Upgrading: the `roi` argument was previously named `product`. The old name still works everywhere (`wrap`, `track`, `configure`, `Pnl(...)`, the wire format) - no code change needed.

## FastAPI

```python
# pnl_setup.py - one shared instance, wrapped client exported
from ai_pnl import pnl
from openai import OpenAI

pnl.configure(roi="support-bot")  # url/key from AI_PNL_URL / AI_PNL_KEY
ai = pnl.wrap(OpenAI())
```

```python
# main.py
from fastapi import FastAPI, Request
from ai_pnl import pnl
from pnl_setup import ai

app = FastAPI()


def employee_from_scope(scope):
    headers = dict(scope.get("headers") or [])
    email = headers.get(b"x-user-email")
    return email.decode() if email else None


app.add_middleware(pnl.middleware(employee_from_scope))


@app.post("/resolve")
async def resolve(request: Request):
    body = await request.json()
    completion = ai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": body["ticket"]}],
    )
    pnl.track("ticket_resolved", value=4.5, ref=body["ticket_id"])
    return {"reply": completion.choices[0].message.content}
```

Prefer no middleware? Open the context yourself:

```python
@app.post("/answer")
async def answer(request: Request):
    body = await request.json()
    with pnl.context(employee=body["user"]):
        res = ai.chat.completions.create(model="gpt-4o-mini", messages=[...])
        pnl.track("question_answered", value=0.5, ref=f"q-{body['id']}")
    return {"answer": res.choices[0].message.content}
```

## Plain script

```python
from anthropic import Anthropic
from ai_pnl import pnl

pnl.configure(url="http://localhost:3000", key="pnl_...", roi="batch-tagger")
claude = pnl.wrap(Anthropic(), employee="dana@acme.com")

msg = claude.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=200,
    messages=[{"role": "user", "content": "Tag this article: ..."}],
)
pnl.track("article_tagged", ref="article-77")

pnl.flush()  # short-lived process: send before exiting
```

Streaming counts too, on every shape the vendor SDKs offer:

```python
with claude.messages.stream(model="claude-sonnet-4-5", max_tokens=200, messages=[...]) as stream:
    for text in stream.text_stream:
        print(text, end="")
# usage recorded from the stream's message snapshot when the block exits
```

## Several ROIs in one app

An ingest key is scoped to one ROI. Create one client per ROI:

```python
from ai_pnl import Pnl

support_bot = Pnl(url=url, key=SUPPORT_BOT_KEY, roi="support-bot")
brain = Pnl(url=url, key=BRAIN_KEY, roi="company-brain")
```

## Tests

```sh
python3 -m unittest discover -s sdk-py/tests           # unit: fakes of the vendor clients
TEST_DATABASE_URL=postgres://... python3 -m unittest discover -s sdk-py/tests  # + end to end against the real ingest API
```
