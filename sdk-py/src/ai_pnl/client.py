"""The AI P&L client (spec 6). Fail-open always: nothing in here ever
raises into the host app - bad input is logged and dropped, an unreachable
server buffers and retries, a full buffer drops the oldest events. Events
carry client-side UUIDs and the server upserts on them, so retrying after a
lost response can never double-count.

HTTP is stdlib urllib, on purpose: the SDK ships zero runtime dependencies
(full parity with @ai-pnl/sdk), every request happens on the background
flush thread where blocking I/O costs the host nothing, and the ingest API
needs exactly what urllib has - POST, a Bearer header, status codes, a
body. httpx would buy nothing but a dependency tree in the host app.
"""

from __future__ import annotations

import contextvars
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from .wrap import RecordedCall, detect_vendor, wrap_client

MAX_BUFFER = 10_000
FLUSH_INTERVAL_SECONDS = 5.0
FLUSH_BATCH = 100
_LOG_THROTTLE_SECONDS = 60.0
_UNSET = object()

# (url, headers, body) -> (status, response_body); raises on network failure.
Transport = Callable[[str, Dict[str, str], bytes], Tuple[int, bytes]]


def default_transport(url: str, headers: Dict[str, str], body: bytes) -> Tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        # Non-2xx still carries a status + body; only network failures raise.
        try:
            detail = err.read()
        except Exception:
            detail = b""
        return err.code, detail


class _RequestContext:
    """The with-block context() returns; restores the previous context on
    exit, nested and async-safe via contextvars."""

    def __init__(self, var: contextvars.ContextVar, store: Dict[str, Any]) -> None:
        self._var = var
        self._store = store
        self._token: Optional[contextvars.Token] = None

    def __enter__(self) -> "_RequestContext":
        self._token = self._var.set(self._store)
        return self

    def __exit__(self, *exc: Any) -> bool:
        if self._token is not None:
            try:
                self._var.reset(self._token)
            except Exception:
                pass  # fail open: exiting in a different context must not raise
        return False


class Pnl:
    def __init__(
        self,
        url: Optional[str] = None,
        key: Optional[str] = None,
        roi: Optional[str] = None,
        transport: Optional[Transport] = None,
        now: Optional[Callable[[], datetime]] = None,
        product: Optional[str] = None,  # deprecated alias for roi, accepted silently
    ) -> None:
        self._url = url
        self._key = key
        self._roi = roi if roi is not None else product
        self._transport: Transport = transport or default_transport
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._buffer: List[Dict[str, Any]] = []
        self._buffer_lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._worker_lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None
        self._wake = threading.Event()
        self._last_log: Dict[str, float] = {}
        self._store: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
            "ai_pnl_context", default=None
        )

    def configure(
        self,
        url: Any = _UNSET,
        key: Any = _UNSET,
        roi: Any = _UNSET,
        transport: Any = _UNSET,
        now: Any = _UNSET,
        product: Any = _UNSET,  # deprecated alias for roi, accepted silently
    ) -> "Pnl":
        """Merge configuration; chainable. url/key fall back to the
        AI_PNL_URL / AI_PNL_KEY environment variables."""
        if url is not _UNSET:
            self._url = url
        if key is not _UNSET:
            self._key = key
        if roi is not _UNSET:
            self._roi = roi
        elif product is not _UNSET:
            self._roi = product
        if transport is not _UNSET:
            self._transport = transport or default_transport
        if now is not _UNSET:
            self._now = now or (lambda: datetime.now(timezone.utc))
        return self

    def wrap(
        self,
        client: Any,
        roi: Optional[str] = None,
        employee: Optional[str] = None,
        product: Optional[str] = None,  # deprecated alias for roi, accepted silently
    ) -> Any:
        """Wrap an OpenAI or Anthropic client (sync or async) so every call
        is counted - token counts from the response usage fields, streaming
        included. The client is recognized structurally; an unrecognized one
        is returned unwrapped (logged, never raised). A wrap-level `employee`
        attributes every call from this client to one person; per-request
        attribution belongs in context() instead."""
        try:
            vendor = detect_vendor(client)
            if vendor is None:
                self._log(
                    "wrap",
                    "client not recognized as an OpenAI or Anthropic SDK instance - returning it unwrapped",
                )
                return client

            resolved_roi = roi if roi is not None else product

            def record(call: RecordedCall) -> None:
                self._record_call(call, resolved_roi, employee)

            return wrap_client(client, vendor, record)
        except Exception as err:
            self._log("wrap", f"wrap() failed ({err!r}) - returning the client unwrapped")
            return client

    def track(
        self,
        kind: str,
        value: Optional[float] = None,
        currency: Optional[str] = None,
        ref: Optional[Any] = None,
        employee: Optional[str] = None,
        roi: Optional[str] = None,
        product: Optional[str] = None,  # deprecated alias for roi, accepted silently
    ) -> None:
        """Record a success and its value (in currency units: 4.5 = $4.50).
        `ref` becomes the outcome's source_ref (the ticket id / coupon id
        every displayed number drills down to); tokens spent in the current
        request context attach automatically."""
        try:
            if not isinstance(kind, str) or not kind.strip():
                self._log("track", "track() needs a non-empty outcome kind - event dropped")
                return
            event: Dict[str, Any] = {
                "id": str(uuid.uuid4()),
                "kind": "outcome",
                "ts": self._ts(),
                "outcome": kind.strip(),
            }
            if value is not None:
                if (
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(value)
                    or value < 0
                ):
                    self._log(
                        "track",
                        f'track("{kind}") value must be a non-negative number - event dropped',
                    )
                    return
                event["valueCents"] = int(math.floor(value * 100 + 0.5))
                event["currency"] = (currency or "USD").upper()
            if ref is not None:
                event["ref"] = str(ref)
            store = self._store.get()
            resolved_employee = employee or (store or {}).get("employee")
            if resolved_employee:
                event["employee"] = resolved_employee
            resolved_roi = roi or product or self._roi
            if resolved_roi:
                event["roi"] = resolved_roi
            if store and store["calls"]:
                event["tokens"] = {
                    "inputTokens": store["input_tokens"],
                    "outputTokens": store["output_tokens"],
                    "calls": list(store["calls"]),
                }
            self._push(event)
        except Exception as err:
            self._log("track", f"track() failed ({err!r}) - event dropped")

    def context(self, employee: Optional[str] = None) -> _RequestContext:
        """A with-block request context: wrapped calls made inside it
        accumulate tokens that attach to any track() in the same context,
        and an `employee` set here attributes everything recorded inside.

            with pnl.context(employee="dana@acme.com"):
                ai.chat.completions.create(...)
                pnl.track("ticket_resolved", value=4.5, ref="ZD-1")
        """
        return _RequestContext(
            self._store,
            {"employee": employee, "input_tokens": 0, "output_tokens": 0, "calls": []},
        )

    def middleware(self, get_employee: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None) -> Any:
        """ASGI middleware factory: opens a request context (optionally with
        the employee read off the ASGI scope) for the rest of the request.

            app.add_middleware(pnl.middleware(employee_from_scope))
        """
        pnl = self

        def factory(app: Any) -> Any:
            async def asgi(scope: Dict[str, Any], receive: Any, send: Any) -> None:
                if scope.get("type") != "http":
                    await app(scope, receive, send)
                    return
                employee: Optional[str] = None
                if get_employee is not None:
                    try:
                        employee = get_employee(scope)
                    except Exception as err:
                        pnl._log(
                            "middleware",
                            f"employee lookup failed ({err!r}) - continuing without",
                        )
                with pnl.context(employee=employee):
                    await app(scope, receive, send)

            return asgi

        return factory

    def flush(self) -> None:
        """Send everything buffered, now. Flushes also happen on their own
        every 5 seconds and whenever 100 events are waiting; call this at
        the end of short-lived scripts. Never raises."""
        try:
            with self._flush_lock:
                self._do_flush()
        except Exception as err:
            self._log("flush", f"flush failed ({err!r}) - events kept for retry")

    def pending(self) -> List[Dict[str, Any]]:
        """Test-only: a copy of the not-yet-flushed events."""
        with self._buffer_lock:
            return list(self._buffer)

    # internals ----------------------------------------------------------

    def _record_call(self, call: RecordedCall, roi: Optional[str], employee: Optional[str]) -> None:
        try:
            event_id = str(uuid.uuid4())
            event: Dict[str, Any] = {
                "id": event_id,
                "kind": "call",
                "ts": self._ts(),
                "vendor": call.vendor,
                "model": call.model,
                "inputTokens": call.input_tokens,
                "outputTokens": call.output_tokens,
            }
            store = self._store.get()
            resolved_employee = employee or (store or {}).get("employee")
            if resolved_employee:
                event["employee"] = resolved_employee
            resolved_roi = roi or self._roi
            if resolved_roi:
                event["roi"] = resolved_roi
            if store is not None:
                store["input_tokens"] += call.input_tokens
                store["output_tokens"] += call.output_tokens
                store["calls"].append(event_id)
            self._push(event)
        except Exception as err:
            self._log("record", f"recording a call failed ({err!r}) - event dropped")

    def _push(self, event: Dict[str, Any]) -> None:
        dropped = 0
        with self._buffer_lock:
            self._buffer.append(event)
            overflow = len(self._buffer) - MAX_BUFFER
            if overflow > 0:
                del self._buffer[:overflow]
                dropped = overflow
            size = len(self._buffer)
        if dropped:
            self._log("buffer", f"buffer full ({MAX_BUFFER}) - dropped the {dropped} oldest event(s)")
        self._ensure_worker()
        if size >= FLUSH_BATCH:
            self._wake.set()

    def _ensure_worker(self) -> None:
        with self._worker_lock:
            if self._worker is not None and self._worker.is_alive():
                return
            # Daemon: never holds the process open - short scripts call
            # flush() themselves (parity with the TS SDK's unref'd interval).
            self._worker = threading.Thread(target=self._worker_loop, name="ai-pnl-flush", daemon=True)
            self._worker.start()

    def _worker_loop(self) -> None:
        while True:
            self._wake.wait(FLUSH_INTERVAL_SECONDS)
            self._wake.clear()
            self.flush()

    def _do_flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
        url = self._url or os.environ.get("AI_PNL_URL")
        key = self._key or os.environ.get("AI_PNL_KEY")
        if not url or not key:
            self._log("config", "AI P&L url/key not configured (AI_PNL_URL / AI_PNL_KEY) - buffering")
            return
        endpoint = url.rstrip("/") + "/api/ingest"
        headers = {"content-type": "application/json", "authorization": f"Bearer {key}"}

        while True:
            with self._buffer_lock:
                if not self._buffer:
                    return
                batch = self._buffer[:FLUSH_BATCH]
                del self._buffer[:FLUSH_BATCH]
            body = json.dumps({"events": batch}).encode("utf-8")
            try:
                status, res_body = self._transport(endpoint, headers, body)
            except Exception as err:
                self._requeue(batch)
                self._log("flush", f"ingest unreachable ({err!r}) - will retry")
                return
            if status == 429 or status >= 500:
                self._requeue(batch)
                self._log("flush", f"ingest returned {status} - will retry")
                return
            if not 200 <= status < 300:
                # 4xx: retrying cannot help - drop the batch, say why.
                detail = ""
                try:
                    detail = json.loads(res_body.decode("utf-8")).get("error") or ""
                except Exception:
                    pass  # body unreadable - the status is all we have
                self._log("flush", f"ingest returned {status} ({detail}) - dropped {len(batch)} event(s)")
                continue
            try:
                results = json.loads(res_body.decode("utf-8")).get("results") or []
                rejected = [r for r in results if r.get("status") == "rejected"]
                if rejected:
                    self._log(
                        "rejected",
                        f"{len(rejected)} event(s) rejected, e.g.: {rejected[0].get('error') or 'no reason given'}",
                    )
            except Exception:
                pass  # verdicts unreadable - the events were accepted, nothing to do

    def _requeue(self, batch: List[Dict[str, Any]]) -> None:
        """Put a failed batch back at the FRONT (it holds the oldest events);
        when that overflows the cap, the oldest still drop first."""
        with self._buffer_lock:
            merged = batch + self._buffer
            self._buffer = merged[max(0, len(merged) - MAX_BUFFER):]

    def _ts(self) -> str:
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _log(self, scope: str, message: str) -> None:
        """stderr, throttled per scope - never spams a hot path."""
        now = time.monotonic()
        last = self._last_log.get(scope)
        if last is not None and now - last < _LOG_THROTTLE_SECONDS:
            return
        self._last_log[scope] = now
        print(f"[ai-pnl] {message}", file=sys.stderr)
