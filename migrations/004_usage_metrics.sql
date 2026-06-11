-- Usage metrics (spec 5 Anthropic row + dashboard page 4 "Tools").
--
-- Vendors report per-user productivity/usage counters that are NOT spend:
-- Claude Code analytics (sessions, commits, PRs, accepted/rejected tool
-- actions, tokens, the vendor's own estimated cost). These power accept
-- rates and per-tool comparisons but must never land in spend_facts -
-- Claude Code traffic already shows up in the raw API usage report under
-- its API key, so counting its analytics dollars as facts would double
-- count the ledger (spec 4: one dollar belongs to one person).
--
-- Raw counters only - rates (accept rate = accepted / (accepted+rejected))
-- are computed at display time, never stored.
--
-- Mirrors spend_facts: (vendor, source_ref, metric) is the idempotent
-- upsert key, identity_id remembers the vendor identity so a Resolve match
-- re-attributes metric history exactly like facts.

CREATE TABLE usage_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day date NOT NULL,
  vendor text NOT NULL,
  metric text NOT NULL,
  value bigint NOT NULL,
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usage_metrics_vendor_source_metric_key
  ON usage_metrics (vendor, source_ref, metric);
CREATE INDEX usage_metrics_person_idx ON usage_metrics (person_id, day);
CREATE INDEX usage_metrics_identity_idx ON usage_metrics (identity_id);
CREATE INDEX usage_metrics_vendor_idx ON usage_metrics (vendor, day);
