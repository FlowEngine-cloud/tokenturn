"""wrap() internals: intercept OpenAI / Anthropic client calls and read
token counts from the response usage fields - streaming included.

Structural typing only (zero runtime dependencies): a client is recognized
by the methods it carries, never by isinstance. Everything not intercepted
passes straight through, and every observation is wrapped in try/except -
an SDK bug must never break the host app.
"""

from __future__ import annotations

import functools
import inspect
import math
from typing import Any, Callable, NamedTuple, Optional, Tuple


class RecordedCall(NamedTuple):
    vendor: str  # "openai" | "anthropic"
    model: str
    input_tokens: int
    output_tokens: int


RecordFn = Callable[[RecordedCall], None]


def _safe(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception:
        pass  # fail open - observation errors never reach the host app


def _field(obj: Any, name: str) -> Any:
    """Read a field structurally: attribute first (vendor SDKs return typed
    objects), mapping second (parsed JSON)."""
    if obj is None:
        return None
    try:
        value = getattr(obj, name)
        if value is not None:
            return value
    except Exception:
        pass
    try:
        if isinstance(obj, dict):
            return obj.get(name)
    except Exception:
        pass
    return None


def _method_at(obj: Any, path: Tuple[str, ...]) -> Optional[Callable[..., Any]]:
    cur = obj
    for name in path:
        if cur is None:
            return None
        try:
            cur = getattr(cur, name)
        except Exception:
            return None
    return cur if callable(cur) else None


def detect_vendor(client: Any) -> Optional[str]:
    if _method_at(client, ("messages", "create")):
        return "anthropic"
    if (
        _method_at(client, ("chat", "completions", "create"))
        or _method_at(client, ("responses", "create"))
        or _method_at(client, ("embeddings", "create"))
    ):
        return "openai"
    return None


def _count(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
        return value
    return None


def _tokens_from_usage(usage: Any) -> Optional[Tuple[int, int]]:
    """Token counts out of a usage object, whichever dialect it speaks:
    OpenAI chat (prompt/completion_tokens), OpenAI responses + Anthropic
    (input/output_tokens), embeddings (prompt_tokens only)."""
    if usage is None:
        return None
    inp = _count(_field(usage, "input_tokens"))
    if inp is None:
        inp = _count(_field(usage, "prompt_tokens"))
    out = _count(_field(usage, "output_tokens"))
    if out is None:
        out = _count(_field(usage, "completion_tokens"))
    if inp is None and out is None:
        return None
    return (int(inp or 0), int(out or 0))


def _model_of(value: Any) -> Optional[str]:
    model = _field(value, "model")
    return model if isinstance(model, str) and model else None


def _record_from_response(vendor: str, res: Any, params: Any, record: RecordFn) -> None:
    tokens = _tokens_from_usage(_field(res, "usage"))
    model = _model_of(res) or _model_of(params)
    if not tokens or not model:
        return  # no usage reported = nothing to count
    record(RecordedCall(vendor, model, tokens[0], tokens[1]))


class _StreamObserver:
    """Accumulate usage across stream events. Counters are cumulative on both
    vendors (Anthropic message_start carries input, message_delta the running
    output; OpenAI's final chunk carries the whole usage), so max() per side
    is exact. Records once, when the consumer finishes (or abandons) the
    stream - and only if usage was actually observed: no fake numbers."""

    def __init__(self, vendor: str, params: Any, record: RecordFn) -> None:
        self._vendor = vendor
        self._record = record
        self._model = _model_of(params)
        self._input: Optional[int] = None
        self._output: Optional[int] = None
        self._done = False

    def on_chunk(self, chunk: Any) -> None:
        usage: Any = None
        if self._vendor == "anthropic":
            ctype = _field(chunk, "type")
            if ctype == "message_start":
                message = _field(chunk, "message")
                self._model = _model_of(message) or self._model
                usage = _field(message, "usage")
            elif ctype == "message_delta":
                usage = _field(chunk, "usage")
        else:
            self._model = _model_of(chunk) or self._model
            usage = _field(chunk, "usage")
            if _field(chunk, "type") == "response.completed":
                response = _field(chunk, "response")
                self._model = _model_of(response) or self._model
                usage = _field(response, "usage")
        tokens = _tokens_from_usage(usage)
        if tokens:
            self._input = max(self._input or 0, tokens[0])
            self._output = max(self._output or 0, tokens[1])

    def on_end(self) -> None:
        if self._done:
            return
        self._done = True
        if self._model and (self._input is not None or self._output is not None):
            self._record(
                RecordedCall(self._vendor, self._model, self._input or 0, self._output or 0)
            )


class _WrappedStream:
    """Iterates like the vendor stream it wraps, observing chunks on the way
    through; everything else delegates to the original object."""

    def __init__(self, inner: Any, observer: _StreamObserver) -> None:
        self._inner = inner
        self._observer = observer
        self._iter: Any = None

    def __iter__(self) -> "_WrappedStream":
        return self

    def __next__(self) -> Any:
        if self._iter is None:
            self._iter = iter(self._inner)
        try:
            chunk = next(self._iter)
        except BaseException:
            _safe(self._observer.on_end)  # StopIteration or a vendor error
            raise
        _safe(lambda: self._observer.on_chunk(chunk))
        return chunk

    def __enter__(self) -> "_WrappedStream":
        enter = getattr(self._inner, "__enter__", None)
        if callable(enter):
            enter()
        return self

    def __exit__(self, *exc: Any) -> Any:
        _safe(self._observer.on_end)
        exit_ = getattr(self._inner, "__exit__", None)
        return exit_(*exc) if callable(exit_) else False

    def close(self) -> None:
        _safe(self._observer.on_end)
        close = getattr(self._inner, "close", None)
        if callable(close):
            close()

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_inner"), name)


class _WrappedAsyncStream:
    """Async twin of _WrappedStream."""

    def __init__(self, inner: Any, observer: _StreamObserver) -> None:
        self._inner = inner
        self._observer = observer
        self._iter: Any = None

    def __aiter__(self) -> "_WrappedAsyncStream":
        return self

    async def __anext__(self) -> Any:
        if self._iter is None:
            self._iter = self._inner.__aiter__()
        try:
            chunk = await self._iter.__anext__()
        except BaseException:
            _safe(self._observer.on_end)  # StopAsyncIteration or a vendor error
            raise
        _safe(lambda: self._observer.on_chunk(chunk))
        return chunk

    async def __aenter__(self) -> "_WrappedAsyncStream":
        aenter = getattr(self._inner, "__aenter__", None)
        if callable(aenter):
            await aenter()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        _safe(self._observer.on_end)
        aexit = getattr(self._inner, "__aexit__", None)
        return await aexit(*exc) if callable(aexit) else False

    async def close(self) -> None:
        _safe(self._observer.on_end)
        close = getattr(self._inner, "close", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_inner"), name)


def _observe_result(
    result: Any, vendor: str, params: Any, streaming: bool, record: RecordFn
) -> Any:
    if inspect.isawaitable(result):
        return _observe_awaited(result, vendor, params, streaming, record)
    if streaming:
        if hasattr(result, "__iter__"):
            return _WrappedStream(result, _StreamObserver(vendor, params, record))
        return result  # not a stream shape we know - pass through untouched
    _safe(lambda: _record_from_response(vendor, result, params, record))
    return result


async def _observe_awaited(
    awaitable: Any, vendor: str, params: Any, streaming: bool, record: RecordFn
) -> Any:
    res = await awaitable  # vendor errors propagate to the caller untouched
    try:
        if streaming:
            if hasattr(res, "__aiter__"):
                return _WrappedAsyncStream(res, _StreamObserver(vendor, params, record))
            return res
        _safe(lambda: _record_from_response(vendor, res, params, record))
    except Exception:
        pass
    return res


def _wrap_create(orig: Callable[..., Any], vendor: str, is_chat: bool, record: RecordFn) -> Any:
    @functools.wraps(orig)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        params: Any = kwargs
        if args and isinstance(args[0], dict):
            params = {**args[0], **kwargs}
        streaming = params.get("stream") is True if isinstance(params, dict) else False

        # OpenAI chat streams only report usage when asked: inject
        # stream_options.include_usage so streamed calls still count.
        if streaming and vendor == "openai" and is_chat:
            try:
                opts = kwargs.get("stream_options") or {}
                if isinstance(opts, dict) and "include_usage" not in opts:
                    kwargs = {**kwargs, "stream_options": {**opts, "include_usage": True}}
            except Exception:
                pass

        result = orig(*args, **kwargs)
        try:
            return _observe_result(result, vendor, params, streaming, record)
        except Exception:
            return result

    return wrapped


class _WrappedMessageStreamManager:
    """Anthropic's messages.stream() returns a context manager whose
    MessageStream accumulates a message snapshot (usage included) no matter
    how it is consumed - events, text_stream, or get_final_message(). The
    with-block gets the REAL stream; we record from the snapshot on exit."""

    def __init__(self, manager: Any, params: Any, record: RecordFn) -> None:
        self._manager = manager
        self._params = params
        self._record = record
        self._stream: Any = None

    def __enter__(self) -> Any:
        self._stream = self._manager.__enter__()
        return self._stream

    def __exit__(self, *exc: Any) -> Any:
        _safe(self._record_snapshot)
        return self._manager.__exit__(*exc)

    def _record_snapshot(self) -> None:
        snapshot = getattr(self._stream, "current_message_snapshot", None)
        tokens = _tokens_from_usage(_field(snapshot, "usage"))
        model = _model_of(snapshot) or _model_of(self._params)
        if tokens and model:
            self._record(RecordedCall("anthropic", model, tokens[0], tokens[1]))

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_manager"), name)


class _WrappedAsyncMessageStreamManager:
    """Async twin of _WrappedMessageStreamManager."""

    def __init__(self, manager: Any, params: Any, record: RecordFn) -> None:
        self._manager = manager
        self._params = params
        self._record = record
        self._stream: Any = None

    async def __aenter__(self) -> Any:
        self._stream = await self._manager.__aenter__()
        return self._stream

    async def __aexit__(self, *exc: Any) -> Any:
        _safe(self._record_snapshot)
        return await self._manager.__aexit__(*exc)

    def _record_snapshot(self) -> None:
        snapshot = getattr(self._stream, "current_message_snapshot", None)
        tokens = _tokens_from_usage(_field(snapshot, "usage"))
        model = _model_of(snapshot) or _model_of(self._params)
        if tokens and model:
            self._record(RecordedCall("anthropic", model, tokens[0], tokens[1]))

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_manager"), name)


def _wrap_messages_stream(orig: Callable[..., Any], record: RecordFn) -> Any:
    @functools.wraps(orig)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        result = orig(*args, **kwargs)
        try:
            if hasattr(result, "__aenter__"):
                return _WrappedAsyncMessageStreamManager(result, kwargs, record)
            if hasattr(result, "__enter__"):
                return _WrappedMessageStreamManager(result, kwargs, record)
        except Exception:
            pass
        return result

    return wrapped


# (path, kind, is_chat_completions)
_LEAVES = {
    "anthropic": (
        (("messages", "create"), "create", False),
        (("messages", "stream"), "stream", False),
    ),
    "openai": (
        (("chat", "completions", "create"), "create", True),
        (("responses", "create"), "create", False),
        (("embeddings", "create"), "create", False),
    ),
}


class _ClientProxy:
    """Pass-through proxy: known call paths are intercepted, everything else
    reaches the real client untouched."""

    def __init__(self, target: Any, prefix: Tuple[str, ...], vendor: str, record: RecordFn) -> None:
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_prefix", prefix)
        object.__setattr__(self, "_vendor", vendor)
        object.__setattr__(self, "_record", record)

    def __getattr__(self, name: str) -> Any:
        target = object.__getattribute__(self, "_target")
        prefix = object.__getattribute__(self, "_prefix")
        vendor = object.__getattribute__(self, "_vendor")
        record = object.__getattribute__(self, "_record")
        value = getattr(target, name)
        path = prefix + (name,)
        for leaf_path, kind, is_chat in _LEAVES[vendor]:
            if leaf_path == path and callable(value):
                if kind == "stream":
                    return _wrap_messages_stream(value, record)
                return _wrap_create(value, vendor, is_chat, record)
        on_path = any(
            len(leaf_path) > len(path) and leaf_path[: len(path)] == path
            for leaf_path, _kind, _chat in _LEAVES[vendor]
        )
        if on_path and value is not None and not callable(value):
            return _ClientProxy(value, path, vendor, record)
        return value

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_target"), name, value)

    def __repr__(self) -> str:
        return repr(object.__getattribute__(self, "_target"))

    def __dir__(self) -> Any:
        return dir(object.__getattribute__(self, "_target"))


def wrap_client(client: Any, vendor: str, record: RecordFn) -> Any:
    return _ClientProxy(client, (), vendor, record)
