"""ai-pnl wrap() against faithful fakes of the vendor Python clients (the
exact response/stream shapes the openai and anthropic packages produce -
typed objects with attributes, not dicts; the SDK speaks structural typing,
so the shapes ARE the contract): counting calls from usage fields incl.
streaming on sync AND async clients, request-context token attach, and
fail-open everywhere."""

from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ai_pnl import Pnl  # noqa: E402


def make_pnl(**over):
    """A Pnl whose transport accepts everything; events inspected via pending()."""
    sent = []

    def transport(url, headers, body):
        import json

        events = json.loads(body.decode("utf-8"))["events"]
        sent.append({"url": url, "auth": headers.get("authorization"), "events": events})
        return 200, json.dumps(
            {"results": [{"id": e["id"], "status": "accepted"} for e in events]}
        ).encode("utf-8")

    cfg = {"url": "http://pnl.test", "key": "pnl_test", "product": "support-bot", "transport": transport}
    cfg.update(over)
    return Pnl(**cfg), sent


# --- faithful fakes ---------------------------------------------------------


class FakeStream:
    """openai.Stream / anthropic.Stream shape: iterator + context manager + close()."""

    def __init__(self, chunks):
        self._chunks = iter(chunks)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        self.closed = True


class FakeAsyncStream:
    """openai.AsyncStream shape: async iterator + async context manager."""

    def __init__(self, chunks):
        self._chunks = iter(chunks)
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._chunks)
        except StopIteration:
            raise StopAsyncIteration

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True
        return False


def openai_chat_chunks():
    return [
        NS(id="c1", model="gpt-4o-mini-2024-07-18", choices=[NS(delta=NS(content="He"))], usage=None),
        NS(id="c1", model="gpt-4o-mini-2024-07-18", choices=[NS(delta=NS(content="llo"))], usage=None),
        NS(
            id="c1",
            model="gpt-4o-mini-2024-07-18",
            choices=[],
            usage=NS(prompt_tokens=50, completion_tokens=10, total_tokens=60),
        ),
    ]


class FakeOpenAI:
    """The openai.OpenAI client shape: chat.completions / responses / embeddings."""

    def __init__(self):
        self.api_key = "sk-test"
        self.calls = []
        client = self

        class Completions:
            def create(self, **params):
                client.calls.append(params)
                if params.get("stream"):
                    return FakeStream(openai_chat_chunks())
                return NS(
                    id="chatcmpl-1",
                    model="gpt-4o-mini-2024-07-18",
                    choices=[NS(message=NS(role="assistant", content="Hello"))],
                    usage=NS(prompt_tokens=120, completion_tokens=30, total_tokens=150),
                )

        class Responses:
            def create(self, **params):
                client.calls.append(params)
                if params.get("stream"):
                    return FakeStream(
                        [
                            NS(type="response.created"),
                            NS(type="response.output_text.delta", delta="Hi"),
                            NS(
                                type="response.completed",
                                response=NS(model="gpt-4o-2024-08-06", usage=NS(input_tokens=300, output_tokens=50)),
                            ),
                        ]
                    )
                return NS(
                    id="resp-1",
                    model="gpt-4o-2024-08-06",
                    usage=NS(input_tokens=200, output_tokens=40),
                )

        class Embeddings:
            def create(self, **params):
                client.calls.append(params)
                return NS(
                    model="text-embedding-3-small",
                    data=[NS(embedding=[0.1])],
                    usage=NS(prompt_tokens=8, total_tokens=8),
                )

        class Models:
            def list(self):
                return ["gpt-4o-mini"]

        self.chat = NS(completions=Completions())
        self.responses = Responses()
        self.embeddings = Embeddings()
        self.models = Models()


class FakeAsyncOpenAI:
    """The openai.AsyncOpenAI shape: create() is a coroutine; stream=True
    resolves to an AsyncStream."""

    def __init__(self):
        self.calls = []
        client = self

        class Completions:
            async def create(self, **params):
                client.calls.append(params)
                if params.get("stream"):
                    return FakeAsyncStream(openai_chat_chunks())
                return NS(
                    id="chatcmpl-2",
                    model="gpt-4o-mini-2024-07-18",
                    choices=[NS(message=NS(content="Hi"))],
                    usage=NS(prompt_tokens=70, completion_tokens=20, total_tokens=90),
                )

        self.chat = NS(completions=Completions())


def anthropic_stream_events():
    return [
        NS(
            type="message_start",
            message=NS(model="claude-sonnet-4-5", usage=NS(input_tokens=900, output_tokens=2)),
        ),
        NS(type="content_block_delta", delta=NS(type="text_delta", text="Hel")),
        NS(type="content_block_delta", delta=NS(type="text_delta", text="lo")),
        NS(type="message_delta", usage=NS(output_tokens=120)),
        NS(type="message_stop"),
    ]


class FakeMessageStream:
    """anthropic MessageStream shape: event iterator, text_stream property,
    get_final_message(), current_message_snapshot accumulated from events -
    however the stream is consumed, like the real SDK."""

    def __init__(self, events):
        self._events = events
        self._snapshot = None

    def __iter__(self):
        for event in self._events:
            self._apply(event)
            yield event

    @property
    def text_stream(self):
        for event in self:
            if event.type == "content_block_delta":
                yield event.delta.text

    def get_final_message(self):
        for _ in self:
            pass
        return self._snapshot

    @property
    def current_message_snapshot(self):
        assert self._snapshot is not None
        return self._snapshot

    def _apply(self, event):
        if event.type == "message_start":
            self._snapshot = NS(
                model=event.message.model,
                usage=NS(
                    input_tokens=event.message.usage.input_tokens,
                    output_tokens=event.message.usage.output_tokens,
                ),
            )
        elif event.type == "message_delta" and self._snapshot is not None:
            self._snapshot.usage.output_tokens = event.usage.output_tokens

    def close(self):
        pass


class FakeMessageStreamManager:
    def __enter__(self):
        self.stream = FakeMessageStream(anthropic_stream_events())
        return self.stream

    def __exit__(self, *exc):
        return False


class FakeAsyncMessageStream(FakeMessageStream):
    def __aiter__(self):
        self._it = iter(self._events)
        return self

    async def __anext__(self):
        try:
            event = next(self._it)
        except StopIteration:
            raise StopAsyncIteration
        self._apply(event)
        return event

    async def get_final_message(self):
        async for _ in self:
            pass
        return self._snapshot


class FakeAsyncMessageStreamManager:
    async def __aenter__(self):
        self.stream = FakeAsyncMessageStream(anthropic_stream_events())
        return self.stream

    async def __aexit__(self, *exc):
        return False


class FakeAnthropic:
    """The anthropic.Anthropic client shape: messages.create + messages.stream."""

    def __init__(self):
        self.calls = []
        client = self

        class Messages:
            def create(self, **params):
                client.calls.append(params)
                if params.get("stream"):
                    return FakeStream(anthropic_stream_events())
                return NS(
                    id="msg-1",
                    model="claude-sonnet-4-5",
                    content=[NS(type="text", text="Hello")],
                    usage=NS(input_tokens=900, output_tokens=120),
                )

            def stream(self, **params):
                client.calls.append(params)
                return FakeMessageStreamManager()

        self.messages = Messages()


# --- tests ------------------------------------------------------------------


class WrapOpenAITest(unittest.TestCase):
    def test_chat_completion_records_usage_and_returns_response_untouched(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        res = ai.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
        self.assertEqual(res.choices[0].message.content, "Hello")
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            {k: events[0][k] for k in ("kind", "vendor", "model", "inputTokens", "outputTokens", "product")},
            {
                "kind": "call",
                "vendor": "openai",
                "model": "gpt-4o-mini-2024-07-18",
                "inputTokens": 120,
                "outputTokens": 30,
                "product": "support-bot",
            },
        )

    def test_chat_stream_injects_include_usage_and_counts_final_chunk(self):
        pnl, _ = make_pnl()
        client = FakeOpenAI()
        ai = pnl.wrap(client)
        chunks = list(ai.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True))
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": True})
        self.assertEqual(len(chunks), 3)  # chunks pass through unchanged
        self.assertEqual(chunks[0].choices[0].delta.content, "He")
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (50, 10))

    def test_chat_stream_respects_callers_stream_options(self):
        pnl, _ = make_pnl()
        client = FakeOpenAI()
        ai = pnl.wrap(client)
        ai.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True, stream_options={"include_usage": False})
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": False})

    def test_abandoned_stream_without_usage_records_nothing(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        with ai.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True) as stream:
            next(iter(stream))  # consumer walks away before the usage chunk
        self.assertEqual(pnl.pending(), [])  # no usage observed = no fake numbers

    def test_responses_stream_counts_response_completed(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        for _ in ai.responses.create(model="gpt-4o", input="hi", stream=True):
            pass
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            (events[0]["model"], events[0]["inputTokens"], events[0]["outputTokens"]),
            ("gpt-4o-2024-08-06", 300, 50),
        )

    def test_embeddings_count_prompt_tokens_only(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        ai.embeddings.create(model="text-embedding-3-small", input="hello")
        events = pnl.pending()
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (8, 0))
        self.assertEqual(events[0]["model"], "text-embedding-3-small")

    def test_other_attributes_pass_through(self):
        pnl, _ = make_pnl()
        client = FakeOpenAI()
        ai = pnl.wrap(client)
        self.assertEqual(ai.api_key, "sk-test")
        self.assertEqual(ai.models.list(), ["gpt-4o-mini"])
        self.assertEqual(pnl.pending(), [])

    def test_vendor_error_propagates_and_nothing_is_recorded(self):
        pnl, _ = make_pnl()

        class BoomCompletions:
            def create(self, **params):
                raise RuntimeError("rate limited")

        ai = pnl.wrap(NS(chat=NS(completions=BoomCompletions())))
        with self.assertRaises(RuntimeError):
            ai.chat.completions.create(model="gpt-4o-mini")
        self.assertEqual(pnl.pending(), [])

    def test_unrecognized_client_returned_unwrapped(self):
        pnl, _ = make_pnl()
        thing = object()
        self.assertIs(pnl.wrap(thing), thing)


class WrapAnthropicTest(unittest.TestCase):
    def test_messages_create_records_usage(self):
        pnl, _ = make_pnl()
        claude = pnl.wrap(FakeAnthropic(), employee="dana@acme.com")
        res = claude.messages.create(model="claude-sonnet-4-5", max_tokens=200, messages=[])
        self.assertEqual(res.content[0].text, "Hello")
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            {k: events[0][k] for k in ("vendor", "model", "inputTokens", "outputTokens", "employee")},
            {
                "vendor": "anthropic",
                "model": "claude-sonnet-4-5",
                "inputTokens": 900,
                "outputTokens": 120,
                "employee": "dana@acme.com",
            },
        )

    def test_create_stream_true_counts_message_start_plus_delta(self):
        pnl, _ = make_pnl()
        claude = pnl.wrap(FakeAnthropic())
        seen = [e.type for e in claude.messages.create(model="claude-sonnet-4-5", messages=[], stream=True)]
        self.assertIn("message_stop", seen)  # events pass through unchanged
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (900, 120))

    def test_messages_stream_text_stream_records_via_snapshot_on_exit(self):
        pnl, _ = make_pnl()
        claude = pnl.wrap(FakeAnthropic())
        text = ""
        with claude.messages.stream(model="claude-sonnet-4-5", max_tokens=200, messages=[]) as stream:
            for chunk in stream.text_stream:
                text += chunk
        self.assertEqual(text, "Hello")
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            (events[0]["model"], events[0]["inputTokens"], events[0]["outputTokens"]),
            ("claude-sonnet-4-5", 900, 120),
        )

    def test_messages_stream_get_final_message_records_once(self):
        pnl, _ = make_pnl()
        claude = pnl.wrap(FakeAnthropic())
        with claude.messages.stream(model="claude-sonnet-4-5", messages=[]) as stream:
            final = stream.get_final_message()
        self.assertEqual(final.usage.output_tokens, 120)
        self.assertEqual(len(pnl.pending()), 1)

    def test_messages_stream_never_consumed_records_nothing(self):
        pnl, _ = make_pnl()
        claude = pnl.wrap(FakeAnthropic())
        with claude.messages.stream(model="claude-sonnet-4-5", messages=[]):
            pass  # snapshot never exists - the real SDK asserts on access
        self.assertEqual(pnl.pending(), [])


class WrapAsyncTest(unittest.IsolatedAsyncioTestCase):
    async def test_async_chat_completion_records(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeAsyncOpenAI())
        res = await ai.chat.completions.create(model="gpt-4o-mini", messages=[])
        self.assertEqual(res.choices[0].message.content, "Hi")
        events = pnl.pending()
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (70, 20))

    async def test_async_chat_stream_records(self):
        pnl, _ = make_pnl()
        client = FakeAsyncOpenAI()
        ai = pnl.wrap(client)
        stream = await ai.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
        chunks = [c async for c in stream]
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": True})
        self.assertEqual(len(chunks), 3)
        events = pnl.pending()
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (50, 10))

    async def test_async_anthropic_messages_stream(self):
        pnl, _ = make_pnl()

        class AsyncMessages:
            async def create(self, **params):  # presence makes detection say anthropic
                raise NotImplementedError

            def stream(self, **params):
                return FakeAsyncMessageStreamManager()

        claude = pnl.wrap(NS(messages=AsyncMessages()))
        async with claude.messages.stream(model="claude-sonnet-4-5", messages=[]) as stream:
            await stream.get_final_message()
        events = pnl.pending()
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["inputTokens"], events[0]["outputTokens"]), (900, 120))


class ContextAttachTest(unittest.TestCase):
    def test_context_accumulates_tokens_and_attaches_to_track(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        with pnl.context(employee="dana@acme.com"):
            ai.chat.completions.create(model="gpt-4o-mini", messages=[])
            ai.chat.completions.create(model="gpt-4o-mini", messages=[])
            pnl.track("ticket_resolved", value=4.5, ref="ZD-1")
        events = pnl.pending()
        calls = [e for e in events if e["kind"] == "call"]
        outcomes = [e for e in events if e["kind"] == "outcome"]
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(outcomes), 1)
        outcome = outcomes[0]
        self.assertEqual(outcome["outcome"], "ticket_resolved")
        self.assertEqual(outcome["valueCents"], 450)
        self.assertEqual(outcome["currency"], "USD")
        self.assertEqual(outcome["ref"], "ZD-1")
        self.assertEqual(outcome["employee"], "dana@acme.com")
        self.assertEqual(outcome["tokens"]["inputTokens"], 240)
        self.assertEqual(outcome["tokens"]["outputTokens"], 60)
        self.assertEqual(outcome["tokens"]["calls"], [c["id"] for c in calls])
        for call in calls:
            self.assertEqual(call["employee"], "dana@acme.com")

    def test_outside_context_no_tokens_attach(self):
        pnl, _ = make_pnl()
        pnl.track("ticket_resolved")
        (outcome,) = pnl.pending()
        self.assertNotIn("tokens", outcome)
        self.assertNotIn("employee", outcome)

    def test_explicit_employee_beats_context(self):
        pnl, _ = make_pnl()
        with pnl.context(employee="dana@acme.com"):
            pnl.track("lead_scored", employee="omer@acme.com")
        (outcome,) = pnl.pending()
        self.assertEqual(outcome["employee"], "omer@acme.com")

    def test_contexts_are_isolated(self):
        pnl, _ = make_pnl()
        ai = pnl.wrap(FakeOpenAI())
        with pnl.context(employee="a@acme.com"):
            ai.chat.completions.create(model="gpt-4o-mini", messages=[])
        with pnl.context(employee="b@acme.com"):
            pnl.track("done")  # the other context's tokens must not leak in
        outcome = [e for e in pnl.pending() if e["kind"] == "outcome"][0]
        self.assertNotIn("tokens", outcome)
        self.assertEqual(outcome["employee"], "b@acme.com")


class MiddlewareTest(unittest.IsolatedAsyncioTestCase):
    async def test_asgi_middleware_opens_context(self):
        pnl, _ = make_pnl()
        seen = {}

        async def app(scope, receive, send):
            pnl.track("handled")
            seen["done"] = True

        factory = pnl.middleware(lambda scope: dict(scope.get("headers") or {}).get("x-user-email"))
        wrapped = factory(app)
        await wrapped({"type": "http", "headers": {"x-user-email": "dana@acme.com"}}, None, None)
        self.assertTrue(seen["done"])
        (outcome,) = pnl.pending()
        self.assertEqual(outcome["employee"], "dana@acme.com")

    async def test_middleware_employee_lookup_failure_is_fail_open(self):
        pnl, _ = make_pnl()

        async def app(scope, receive, send):
            pnl.track("handled")

        def boom(scope):
            raise ValueError("no header")

        await pnl.middleware(boom)(app)({"type": "http"}, None, None)
        (outcome,) = pnl.pending()
        self.assertNotIn("employee", outcome)


if __name__ == "__main__":
    unittest.main()
