"""ai-pnl buffering and delivery: batching/flush triggers, the 10k
oldest-dropped buffer, retry-with-same-UUIDs on 429/5xx/network, drop on
other 4xx, track() validation, and the real urllib transport against a real
local HTTP server."""

from __future__ import annotations

import http.server
import json
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import ai_pnl.client as client_module  # noqa: E402
from ai_pnl import FLUSH_BATCH, MAX_BUFFER, Pnl  # noqa: E402


def capture_server(status_plan=None):
    """A capturing ingest transport: 200 + per-event accepted verdicts,
    optionally fronted by a plan of error statuses."""
    plan = list(status_plan or [])
    requests = []

    def transport(url, headers, body):
        events = json.loads(body.decode("utf-8"))["events"]
        requests.append({"url": url, "auth": headers.get("authorization"), "events": events})
        status = plan.pop(0) if plan else 200
        if status == "network":
            raise OSError("connection refused")
        if status != 200:
            return status, json.dumps({"error": "boom"}).encode("utf-8")
        return 200, json.dumps(
            {"results": [{"id": e["id"], "status": "accepted"} for e in events]}
        ).encode("utf-8")

    return requests, transport


def make_pnl(status_plan=None, **over):
    requests, transport = capture_server(status_plan)
    cfg = {"url": "http://pnl.test", "key": "pnl_k", "product": "support-bot", "transport": transport}
    cfg.update(over)
    return Pnl(**cfg), requests


class BatchingTest(unittest.TestCase):
    def test_flush_sends_batches_of_100_in_order_with_auth(self):
        # Buffer everything unconfigured first, so the background worker
        # cannot race the foreground flush and batch sizes are deterministic.
        pnl, requests = make_pnl(url=None)
        for i in range(250):
            pnl.track("t", ref=f"r-{i}")
        pnl.configure(url="http://pnl.test")
        pnl.flush()
        self.assertEqual([len(r["events"]) for r in requests], [100, 100, 50])
        self.assertTrue(all(r["url"] == "http://pnl.test/api/ingest" for r in requests))
        self.assertTrue(all(r["auth"] == "Bearer pnl_k" for r in requests))
        refs = [e["ref"] for r in requests for e in r["events"]]
        self.assertEqual(refs, [f"r-{i}" for i in range(250)])
        self.assertEqual(pnl.pending(), [])

    def test_url_trailing_slash_normalized(self):
        pnl, requests = make_pnl(url="http://pnl.test///")
        pnl.track("t")
        pnl.flush()
        self.assertEqual(requests[0]["url"], "http://pnl.test/api/ingest")

    def test_hundredth_event_triggers_background_flush(self):
        pnl, requests = make_pnl()
        for _ in range(FLUSH_BATCH):
            pnl.track("t")
        deadline = time.monotonic() + 5
        while not requests and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(requests[0]["events"]), FLUSH_BATCH)

    def test_interval_flush_happens_without_reaching_100(self):
        original = client_module.FLUSH_INTERVAL_SECONDS
        client_module.FLUSH_INTERVAL_SECONDS = 0.05
        try:
            pnl, requests = make_pnl()
            pnl.track("t")
            deadline = time.monotonic() + 5
            while not requests and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(requests), 1)
        finally:
            client_module.FLUSH_INTERVAL_SECONDS = original


class RetryTest(unittest.TestCase):
    def test_429_requeues_and_retry_sends_the_same_uuids(self):
        pnl, requests = make_pnl(status_plan=[429])
        pnl.track("t", ref="a")
        pnl.track("t", ref="b")
        pnl.flush()
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(pnl.pending()), 2)  # kept for retry, order intact
        first_ids = [e["id"] for e in requests[0]["events"]]
        pnl.flush()
        self.assertEqual(len(requests), 2)
        self.assertEqual([e["id"] for e in requests[1]["events"]], first_ids)
        self.assertEqual([e["ref"] for e in requests[1]["events"]], ["a", "b"])
        self.assertEqual(pnl.pending(), [])

    def test_500_and_network_errors_requeue(self):
        for plan in ([500], ["network"]):
            pnl, requests = make_pnl(status_plan=plan)
            pnl.track("t")
            pnl.flush()
            self.assertEqual(len(pnl.pending()), 1, f"plan {plan}")
            pnl.flush()
            self.assertEqual(pnl.pending(), [], f"plan {plan}")
            self.assertEqual(len(requests), 2, f"plan {plan}")

    def test_other_4xx_drops_the_batch_and_moves_on(self):
        pnl, requests = make_pnl(status_plan=[401])
        pnl.track("t")
        pnl.flush()
        self.assertEqual(len(requests), 1)
        self.assertEqual(pnl.pending(), [])  # retrying cannot help - dropped
        pnl.flush()
        self.assertEqual(len(requests), 1)  # nothing left to send

    def test_flush_never_raises_and_keeps_the_batch(self):
        class WeirdError(Exception):
            def __str__(self):
                raise ValueError("even __str__ is hostile")

        def transport(url, headers, body):
            raise WeirdError()

        pnl = Pnl(url="http://pnl.test", key="k", transport=transport)
        pnl.track("t")
        pnl.flush()  # must neither raise nor lose the event
        self.assertEqual(len(pnl.pending()), 1)


class BufferCapTest(unittest.TestCase):
    def test_cap_drops_oldest_first(self):
        pnl = Pnl()  # no url/key: everything buffers
        for i in range(MAX_BUFFER + 50):
            pnl.track("t", ref=f"r-{i}")
        pending = pnl.pending()
        self.assertEqual(len(pending), MAX_BUFFER)
        self.assertEqual(pending[0]["ref"], "r-50")  # oldest 50 dropped
        self.assertEqual(pending[-1]["ref"], f"r-{MAX_BUFFER + 49}")

    def test_unconfigured_flush_keeps_buffering(self):
        pnl = Pnl()
        pnl.track("t")
        pnl.flush()
        self.assertEqual(len(pnl.pending()), 1)


class TrackValidationTest(unittest.TestCase):
    def test_invalid_input_dropped_valid_kept(self):
        pnl, _ = make_pnl()
        pnl.track("")  # empty kind
        pnl.track("  ")  # whitespace kind
        pnl.track("ok", value=-1)  # negative value
        pnl.track("ok", value=float("nan"))
        pnl.track("ok", value=True)  # bool is not a number
        self.assertEqual(pnl.pending(), [])
        pnl.track("ok", value=4.5, currency="eur")
        (event,) = pnl.pending()
        self.assertEqual(event["valueCents"], 450)
        self.assertEqual(event["currency"], "EUR")
        self.assertEqual(event["outcome"], "ok")

    def test_value_rounds_half_up_like_the_ts_sdk(self):
        pnl, _ = make_pnl()
        pnl.track("ok", value=0.125)
        (event,) = pnl.pending()
        self.assertEqual(event["valueCents"], 13)

    def test_no_value_means_no_currency(self):
        pnl, _ = make_pnl()
        pnl.track("ok", ref=12345)
        (event,) = pnl.pending()
        self.assertNotIn("valueCents", event)
        self.assertNotIn("currency", event)
        self.assertEqual(event["ref"], "12345")  # refs coerced to strings


class _IngestHandler(http.server.BaseHTTPRequestHandler):
    store = None  # set per test: {"requests": [...], "plan": [...]}

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        payload = json.loads(body.decode("utf-8"))
        type(self).store["requests"].append(
            {"path": self.path, "auth": self.headers.get("authorization"), "events": payload["events"]}
        )
        plan = type(self).store["plan"]
        status = plan.pop(0) if plan else 200
        if status != 200:
            out = json.dumps({"error": "planned failure"}).encode("utf-8")
        else:
            out = json.dumps(
                {"results": [{"id": e["id"], "status": "accepted"} for e in payload["events"]]}
            ).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class RealHttpTransportTest(unittest.TestCase):
    """The default stdlib-urllib transport against a real local HTTP server -
    including the HTTPError path (429 keeps the batch, then a retry lands)."""

    def setUp(self):
        _IngestHandler.store = {"requests": [], "plan": []}
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _IngestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_delivers_over_real_http(self):
        pnl = Pnl(url=self.url, key="pnl_real")
        pnl.track("ticket_resolved", value=4.5, ref="ZD-9", employee="dana@acme.com", product="support-bot")
        pnl.flush()
        requests = _IngestHandler.store["requests"]
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["path"], "/api/ingest")
        self.assertEqual(requests[0]["auth"], "Bearer pnl_real")
        (event,) = requests[0]["events"]
        self.assertEqual(
            {k: event[k] for k in ("kind", "outcome", "valueCents", "currency", "ref", "employee", "product")},
            {
                "kind": "outcome",
                "outcome": "ticket_resolved",
                "valueCents": 450,
                "currency": "USD",
                "ref": "ZD-9",
                "employee": "dana@acme.com",
                "product": "support-bot",
            },
        )
        self.assertEqual(pnl.pending(), [])

    def test_real_429_then_success_retries_same_uuids(self):
        _IngestHandler.store["plan"] = [429]
        pnl = Pnl(url=self.url, key="pnl_real")
        pnl.track("t")
        pnl.flush()
        self.assertEqual(len(pnl.pending()), 1)
        pnl.flush()
        requests = _IngestHandler.store["requests"]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["events"][0]["id"], requests[1]["events"][0]["id"])
        self.assertEqual(pnl.pending(), [])

    def test_unreachable_server_buffers(self):
        pnl = Pnl(url="http://127.0.0.1:1", key="pnl_real")  # nothing listens here
        pnl.track("t")
        pnl.flush()
        self.assertEqual(len(pnl.pending()), 1)


if __name__ == "__main__":
    unittest.main()
