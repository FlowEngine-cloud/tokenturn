"""Tokenturn Python SDK - count every OpenAI/Anthropic call, track outcomes
with real value. Full parity with @tokenturn/sdk; zero runtime dependencies."""

from .client import FLUSH_BATCH, FLUSH_INTERVAL_SECONDS, MAX_BUFFER, Pnl, default_transport

__version__ = "0.1.0"

#: The shared instance most apps use; create extra Pnl() clients for
#: several products in one app (an ingest key is scoped to one product).
pnl = Pnl()

__all__ = [
    "FLUSH_BATCH",
    "FLUSH_INTERVAL_SECONDS",
    "MAX_BUFFER",
    "Pnl",
    "default_transport",
    "pnl",
]
