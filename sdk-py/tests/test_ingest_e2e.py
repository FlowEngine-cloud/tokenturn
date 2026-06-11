"""The whole spec-6 offer for Python, end to end: the SDK delivers over real
HTTP to the REAL ingest API (`next dev` against a scratch Postgres, the same
migrations the container runs on boot), so wrap() + track() drive the
production path into a real database - estimated facts priced from the
pinned table, outcomes drilling to the ref, rollups recomputed - and a full
re-send of already-delivered bytes (the retry after a lost response)
changes nothing.

Needs TEST_DATABASE_URL (same contract as the vitest suite); skipped
otherwise."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ai_pnl import Pnl, default_transport  # noqa: E402

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


_DB_QUERY_JS = """
const { Client } = require("pg");
(async () => {
  const client = new Client({ connectionString: process.argv[1] });
  await client.connect();
  try {
    const res = await client.query(process.argv[2]);
    for (const row of res.rows ?? []) {
      console.log(Object.values(row).map((v) => (v === null ? "" : String(v))).join("|"));
    }
  } finally {
    await client.end();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
"""


def psql(database_url, sql):
    """Run one statement through the repo's own pg client (no psql binary
    needed); returns rows as '|'-joined strings."""
    out = subprocess.run(
        ["node", "-e", _DB_QUERY_JS, database_url, sql],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"query failed: {out.stderr.strip()}\nsql: {sql}")
    return [line for line in out.stdout.splitlines() if line]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class FakeOpenAI:
    """Faithful openai client shape - the vendor client is the ONLY fake in
    this test; SDK, HTTP, route, pricing, and database are all real."""

    def __init__(self):
        class Completions:
            def create(self, **params):
                return NS(
                    model=params["model"],
                    choices=[NS(message=NS(content="done"))],
                    # x2 calls: 2.4M in x $0.15/MTok + 600k out x $0.60/MTok = $0.72
                    usage=NS(prompt_tokens=1_200_000, completion_tokens=300_000),
                )

        self.chat = NS(completions=Completions())


@unittest.skipUnless(TEST_DATABASE_URL, "TEST_DATABASE_URL not set")
class IngestE2ETest(unittest.TestCase):
    sent_bodies = []  # (headers, body) per delivered request, exact bytes

    @classmethod
    def setUpClass(cls):
        name = f"pnl_py_e2e_{int(time.time())}_{secrets.randbelow(10**6)}"
        psql(TEST_DATABASE_URL, f"CREATE DATABASE {name}")
        parts = urllib.parse.urlsplit(TEST_DATABASE_URL)
        cls.db_url = urllib.parse.urlunsplit(parts._replace(path=f"/{name}"))

        try:
            migrate = subprocess.run(
                ["node", "scripts/migrate.mjs"],
                cwd=REPO_ROOT,
                env={**os.environ, "DATABASE_URL": cls.db_url},
                capture_output=True,
                text=True,
                timeout=120,
            )
            if migrate.returncode != 0:
                raise RuntimeError(f"migrations failed: {migrate.stderr}")

            psql(cls.db_url, "INSERT INTO people (email, name, source) VALUES ('dana@acme.com', 'Dana', 'csv')")
            (cls.product_id,) = psql(
                cls.db_url,
                "INSERT INTO products (name, attribution, outcome_kind) "
                "VALUES ('Support Bot', 'sdk', 'sdk_event') RETURNING id",
            )
            # Mint an ingest key the way Settings does: plaintext never stored.
            cls.token = f"pnl_{secrets.token_hex(24)}"
            token_hash = hashlib.sha256(cls.token.encode("utf-8")).hexdigest()
            psql(
                cls.db_url,
                "INSERT INTO ingest_keys (product_id, name, token_hash, token_prefix) "
                f"VALUES ('{cls.product_id}', 'py-e2e', '{token_hash}', '{cls.token[:12]}')",
            )

            port = free_port()
            cls.base_url = f"http://127.0.0.1:{port}"
            cls.server_log = tempfile.NamedTemporaryFile(  # noqa: SIM115 - kept for teardown
                mode="w+", prefix="ai-pnl-e2e-", suffix=".log", delete=False
            )
            cls.server = subprocess.Popen(
                [os.path.join(REPO_ROOT, "node_modules", ".bin", "next"), "dev", "-p", str(port)],
                cwd=REPO_ROOT,
                env={**os.environ, "DATABASE_URL": cls.db_url, "PORT": str(port)},
                stdout=cls.server_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            deadline = time.monotonic() + 180
            while True:
                try:
                    with urllib.request.urlopen(f"{cls.base_url}/healthz", timeout=2) as res:
                        if res.status == 200:
                            break
                except Exception:
                    pass
                if cls.server.poll() is not None or time.monotonic() > deadline:
                    cls.server_log.flush()
                    with open(cls.server_log.name) as log:
                        raise RuntimeError(f"next dev never became healthy:\n{log.read()[-4000:]}")
                time.sleep(0.5)
        except BaseException:
            cls._teardown_infra()
            raise

    @classmethod
    def tearDownClass(cls):
        cls._teardown_infra()

    @classmethod
    def _teardown_infra(cls):
        server = getattr(cls, "server", None)
        if server is not None and server.poll() is None:
            try:
                os.killpg(os.getpgid(server.pid), signal.SIGTERM)
                server.wait(timeout=15)
            except Exception:
                try:
                    os.killpg(os.getpgid(server.pid), signal.SIGKILL)
                except Exception:
                    pass
        log = getattr(cls, "server_log", None)
        if log is not None:
            log.close()
            os.unlink(log.name)
        if getattr(cls, "db_url", None):
            name = urllib.parse.urlsplit(cls.db_url).path.lstrip("/")
            psql(TEST_DATABASE_URL, f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")

    def test_a_two_minutes_to_data(self):
        """wrap + track over real HTTP, and the ledger has it all."""
        record = type(self).sent_bodies

        def recording_transport(url, headers, body):
            status, res_body = default_transport(url, headers, body)
            record.append((dict(headers), body))
            return status, res_body

        pnl = Pnl(url=self.base_url, key=self.token, product="Support Bot", transport=recording_transport)
        ai = pnl.wrap(FakeOpenAI())
        with pnl.context(employee="dana@acme.com"):
            ai.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "?"}])
            ai.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "?"}])
            pnl.track("ticket_resolved", value=4.5, ref="ZD-1")
        pnl.flush()
        self.assertEqual(pnl.pending(), [])
        self.assertGreaterEqual(len(record), 1)

        # One estimated fact bucket, priced from the pinned table, on Dana.
        facts = psql(
            self.db_url,
            "SELECT f.vendor, f.model, f.tokens, f.amount_cents, f.cost_basis, f.product_id, p.email "
            "FROM spend_facts f JOIN people p ON p.id = f.person_id",
        )
        self.assertEqual(
            facts,
            [f"openai|gpt-4o-mini|3000000|72|estimated|{self.product_id}|dana@acme.com"],
        )

        # The outcome drills to the ticket, carries the context's tokens.
        outcomes = psql(
            self.db_url,
            "SELECT o.kind, o.value_cents, o.currency, o.source_ref, p.email, "
            "o.meta->'tokens'->>'inputTokens' AS in_tokens, "
            "o.meta->'tokens'->>'outputTokens' AS out_tokens, "
            "jsonb_array_length(o.meta->'tokens'->'calls') AS call_count "
            "FROM outcomes o JOIN people p ON p.id = o.person_id",
        )
        self.assertEqual(outcomes, ["ticket_resolved|450|USD|ZD-1|dana@acme.com|2400000|600000|2"])

        # The charts agree without any extra step: rollups already carry it.
        self.assertEqual(
            psql(self.db_url, f"SELECT SUM(amount_usd_cents) FROM rollup_daily WHERE product_id = '{self.product_id}'"),
            ["72"],
        )
        self.assertEqual(
            psql(
                self.db_url,
                f"SELECT SUM(outcome_count) FROM rollup_outcomes_daily WHERE product_id = '{self.product_id}'",
            ),
            ["1"],
        )

    def test_b_retried_delivery_is_a_pure_no_op(self):
        """Re-send the exact bytes already delivered - all duplicates."""
        self.assertGreaterEqual(len(type(self).sent_bodies), 1, "test_a must run first")
        before = psql(
            self.db_url,
            "SELECT (SELECT count(*) FROM ingest_events), (SELECT sum(amount_cents) FROM spend_facts)",
        )
        for headers, body in type(self).sent_bodies:
            req = urllib.request.Request(
                f"{self.base_url}/api/ingest", data=body, headers=headers, method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                self.assertEqual(res.status, 200)
                results = json.loads(res.read().decode("utf-8"))["results"]
            self.assertTrue(results)
            for verdict in results:
                self.assertEqual(verdict["status"], "duplicate")
        after = psql(
            self.db_url,
            "SELECT (SELECT count(*) FROM ingest_events), (SELECT sum(amount_cents) FROM spend_facts)",
        )
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
