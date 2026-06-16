-- Tokenturn schema - the whole thing, one file.
--
-- Conventions:
-- - Money is stored as billed: amount_cents + ISO-4217 currency. Rollups
--   normalize to USD cents via fx_rates; drill-downs show the original.
-- - Day buckets are UTC dates.
-- - person_id is nullable on spend/outcome rows: NULL = the visible
--   Unassigned bucket. Unassigned money is never dropped, never hidden.
-- - Nothing hard-deletes in normal operation (archive instead). The one
--   exception is GDPR person hard-delete; FKs there are ON DELETE SET NULL
--   so facts fall back to Unassigned rather than disappearing.
--
-- Two billing axes on spend live side by side and are orthogonal:
--   cost_basis   - how sure we are of the number (estimated/invoiced/manual).
--   billing_mode - how it is incurred (metered pay-as-you-go vs a flat
--                  subscription seat fee).

-- ===========================================================================
-- People + products (the attribution targets)
-- ===========================================================================

-- People: employees. Matched across vendors by email (case-insensitive).
-- merged_into: two emails, one human - the merged-away row archives and
-- points at the survivor. monthly_limit_usd_cents: our alert threshold
-- (Slack at 80/100%), USD cents, NULL = no limit.
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'offboarded', 'archived')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('csv', 'okta', 'google', 'manual')),
  merged_into uuid REFERENCES people (id) ON DELETE SET NULL,
  monthly_limit_usd_cents bigint
    CHECK (monthly_limit_usd_cents IS NULL OR monthly_limit_usd_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_email_lower_key ON people (lower(email));

-- person_emails: the auto-match memory - confirmed aliases, always lowercase.
-- Any future identity carrying the email auto-maps with no human action.
CREATE TABLE person_emails (
  email text PRIMARY KEY CHECK (email = lower(email)),
  person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_emails_person_idx ON person_emails (person_id);

-- Products: cost centers. Anything that spends AI money. default_value per
-- outcome is applied at READ time, so changing it re-values history.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  attribution text NOT NULL
    CHECK (attribution IN ('connector', 'key', 'sdk', 'manual')),
  outcome_kind text NOT NULL DEFAULT 'none'
    CHECK (outcome_kind IN ('none', 'github_pr', 'issue_done', 'sdk_event', 'manual')),
  default_value_cents bigint CHECK (default_value_cents >= 0),
  default_value_currency text CHECK (default_value_currency ~ '^[A-Z]{3}$'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_default_value_pair
    CHECK ((default_value_cents IS NULL) = (default_value_currency IS NULL))
);
CREATE UNIQUE INDEX products_name_lower_key ON products (lower(name));

-- Identities: vendor identities (users, API keys, seats) -> people. person_id
-- NULL = unresolved (the Resolve queue). Key names become tags (overwritten
-- each sync); manual_tags are Resolve decisions and survive. not_person marks
-- a service account (person_id stays NULL forever); product_id is per-key
-- routing. subscription_type marks a flat-seat holder (Anthropic Claude Code
-- customer_type='subscription'). deprovisioned_at = removed at the vendor.
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  vendor text NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key', 'seat')),
  tags text[] NOT NULL DEFAULT '{}',
  email text,
  display_name text,
  not_person boolean NOT NULL DEFAULT false,
  product_id uuid REFERENCES products (id),
  manual_tags text[] NOT NULL DEFAULT '{}',
  deprovisioned_at timestamptz,
  subscription_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, external_id, kind),
  CONSTRAINT identities_not_person_unmapped
    CHECK (NOT (not_person AND person_id IS NOT NULL))
);
CREATE INDEX identities_person_idx ON identities (person_id);

-- ===========================================================================
-- Spend + outcomes (the ledger)
-- ===========================================================================

-- Spend facts: raw per-day spend rows. source_ref points at the vendor record
-- (drillable); (vendor, source_ref) is the upsert key so re-pulls restate in
-- place. Raw facts keep 13 months; rollups stay forever.
CREATE TABLE spend_facts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day date NOT NULL,
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  product_id uuid REFERENCES products (id),
  vendor text NOT NULL,
  model text,
  tokens bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cost_basis text NOT NULL CHECK (cost_basis IN ('estimated', 'invoiced', 'manual')),
  billing_mode text NOT NULL DEFAULT 'metered'
    CHECK (billing_mode IN ('metered', 'subscription')),
  source_ref text NOT NULL,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spend_facts_day_idx ON spend_facts (day);
CREATE INDEX spend_facts_person_idx ON spend_facts (person_id, day);
CREATE INDEX spend_facts_product_idx ON spend_facts (product_id, day);
CREATE INDEX spend_facts_vendor_idx ON spend_facts (vendor, day);
CREATE INDEX spend_facts_identity_idx ON spend_facts (identity_id);
CREATE UNIQUE INDEX spend_facts_vendor_source_ref_key ON spend_facts (vendor, source_ref);

-- Outcomes: successes (merged PR, resolved ticket, ...). count-aware (a manual
-- month entry is one row counting N); value_cents is per outcome. tools = AI
-- authorship detected on the record; reverted_at/revert_source_ref record a
-- flip without deleting the row; meta carries keys a later revert references.
CREATE TABLE outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  kind text NOT NULL,
  value_cents bigint,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  source_ref text NOT NULL,
  count integer NOT NULL DEFAULT 1 CHECK (count >= 0),
  tools text[] NOT NULL DEFAULT '{}',
  reverted_at timestamptz,
  revert_source_ref text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((value_cents IS NULL) = (currency IS NULL))
);
CREATE INDEX outcomes_product_idx ON outcomes (product_id, ts);
CREATE INDEX outcomes_person_idx ON outcomes (person_id, ts);
CREATE INDEX outcomes_identity_idx ON outcomes (identity_id);
CREATE UNIQUE INDEX outcomes_kind_source_ref_key ON outcomes (kind, source_ref);

-- Usage metrics: per-user vendor counters that are NOT spend (Claude Code
-- sessions/commits/PRs/tool acceptances/tokens/estimated cost). Kept out of
-- spend_facts so the ledger never double counts; rates are computed at read
-- time. (vendor, source_ref, metric) is the idempotent upsert key.
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

-- Tag settings: per-tag config (key names become tags). No row = defaults
-- (counts toward personal usage, no product). counts_personal flags spend out
-- of personal-usage views/limits; product_id routes every key carrying the tag.
CREATE TABLE tag_settings (
  tag text PRIMARY KEY CHECK (tag = btrim(tag) AND tag <> ''),
  counts_personal boolean NOT NULL DEFAULT true,
  product_id uuid REFERENCES products (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- FX rates (daily, ECB). usd_rate = USD per 1 unit of currency. USD needs no
-- row (rate 1).
CREATE TABLE fx_rates (
  day date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  usd_rate numeric NOT NULL CHECK (usd_rate > 0),
  PRIMARY KEY (day, currency)
);

-- Subscription seats: a person's flat recurring plan with a vendor (Claude
-- Max, a Cursor/Copilot seat). Materializes into spend_facts as one
-- billing_mode 'subscription' row per active month. One plan per vendor+person.
CREATE TABLE subscription_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  tier text,
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  started_month date NOT NULL
    CHECK (started_month = date_trunc('month', started_month)::date),
  ended_month date
    CHECK (ended_month = date_trunc('month', ended_month)::date),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_month IS NULL OR ended_month >= started_month),
  UNIQUE (vendor, person_id)
);
CREATE INDEX subscription_seats_person_idx ON subscription_seats (person_id);
CREATE INDEX subscription_seats_vendor_idx ON subscription_seats (vendor);

-- Line survival (spec 5): per (merged AI PR, horizon), how many added lines
-- still existed 30/90 days later. Final once written; error rows leave lines
-- NULL and the aggregates skip them.
CREATE TABLE survival_checks (
  source_ref text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days > 0),
  lines_written integer CHECK (lines_written >= 0),
  lines_alive integer CHECK (lines_alive >= 0),
  error text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_ref, horizon_days),
  CHECK (lines_alive IS NULL OR lines_alive <= lines_written),
  CHECK ((error IS NULL) = (lines_written IS NOT NULL AND lines_alive IS NOT NULL))
);

-- Monthly invoice import: one row per (vendor, month). The true-up
-- materializes as one derived adjustment fact (see lib/invoices.ts).
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_cents bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, month)
);
CREATE INDEX invoices_month_idx ON invoices (month);

-- Manual entries: spend and outcomes for tools with no API. One row per
-- (product, kind, month); each materializes into the ledger (vendor 'manual',
-- cost_basis 'manual') / outcomes (kind 'manual').
CREATE TABLE manual_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id),
  kind text NOT NULL CHECK (kind IN ('cost', 'outcomes')),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_cents bigint CHECK (amount_cents >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  outcome_count integer CHECK (outcome_count >= 0),
  value_cents bigint CHECK (value_cents >= 0),
  value_currency text CHECK (value_currency ~ '^[A-Z]{3}$'),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, kind, month),
  CHECK ((amount_cents IS NULL) = (currency IS NULL)),
  CHECK ((value_cents IS NULL) = (value_currency IS NULL)),
  CHECK (
    (kind = 'cost' AND amount_cents IS NOT NULL
       AND outcome_count IS NULL AND value_cents IS NULL)
    OR (kind = 'outcomes' AND outcome_count IS NOT NULL
       AND amount_cents IS NULL)
  )
);
CREATE INDEX manual_entries_product_idx ON manual_entries (product_id, month);

-- ===========================================================================
-- Daily rollups (power every chart; raw facts power drill-downs only)
-- ===========================================================================

-- Derived, rebuilt by the recompute job - so no FKs. Amounts normalized to
-- USD cents; conversion to the display currency happens at read time.
-- counts_personal (the per-tag toggle) and billing_mode join the grain.
CREATE TABLE rollup_daily (
  day date NOT NULL,
  person_id uuid,
  product_id uuid,
  vendor text NOT NULL,
  cost_basis text NOT NULL CHECK (cost_basis IN ('estimated', 'invoiced', 'manual')),
  counts_personal boolean NOT NULL DEFAULT true,
  billing_mode text NOT NULL DEFAULT 'metered'
    CHECK (billing_mode IN ('metered', 'subscription')),
  tokens bigint NOT NULL DEFAULT 0,
  amount_usd_cents bigint NOT NULL,
  fact_count integer NOT NULL,
  UNIQUE NULLS NOT DISTINCT
    (day, person_id, product_id, vendor, cost_basis, counts_personal, billing_mode)
);
CREATE INDEX rollup_daily_person_idx ON rollup_daily (person_id, day);
CREATE INDEX rollup_daily_product_idx ON rollup_daily (product_id, day);

-- valued_count = outcomes carrying an explicit value, so read-time
-- default-value math works from rollups alone.
CREATE TABLE rollup_outcomes_daily (
  day date NOT NULL,
  product_id uuid NOT NULL,
  person_id uuid,
  kind text NOT NULL,
  outcome_count integer NOT NULL,
  valued_count integer NOT NULL DEFAULT 0,
  value_usd_cents bigint,
  UNIQUE NULLS NOT DISTINCT (day, product_id, person_id, kind)
);
CREATE INDEX rollup_outcomes_product_idx ON rollup_outcomes_daily (product_id, day);

-- ===========================================================================
-- Config, ingest, alerts, sync
-- ===========================================================================

-- Sync runs: one row per connector run. cursor is the connector's opaque
-- resume point; error holds the vendor's error verbatim.
CREATE TABLE sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'success', 'error')),
  cursor text,
  error text,
  rows_synced bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX sync_runs_connector_idx ON sync_runs (connector, started_at DESC);

-- Connectors: one row per connected vendor, created after token scopes
-- validate. Credentials live encrypted in settings, never here.
CREATE TABLE connectors (
  vendor text PRIMARY KEY,
  connected_at timestamptz NOT NULL DEFAULT now(),
  history_limit_days integer NOT NULL CHECK (history_limit_days > 0),
  scopes text[] NOT NULL DEFAULT '{}'
);

-- Settings: all config (DATABASE_URL is the only env var). secret=true rows
-- hold AES-256-GCM ciphertext as a JSON string. Never plaintext.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ingest keys: SDK auth, scoped per product. Only the token's sha256 is kept.
CREATE TABLE ingest_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id),
  name text,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ingest_keys_product_idx ON ingest_keys (product_id);

-- Ingest events: the SDK's raw per-request ledger AND the dedupe key (the
-- client UUID is the PK, upserted ON CONFLICT DO NOTHING). 'call' events
-- derive spend_facts buckets; 'outcome' events upsert outcomes.
CREATE TABLE ingest_events (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES ingest_keys (id),
  product_id uuid NOT NULL REFERENCES products (id),
  kind text NOT NULL CHECK (kind IN ('call', 'outcome')),
  ts timestamptz NOT NULL,
  day date NOT NULL,
  vendor text CHECK (vendor IN ('openai', 'anthropic')),
  model text,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  outcome text,
  value_cents bigint CHECK (value_cents >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  ref text,
  employee_email text,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'call'
      AND vendor IS NOT NULL AND model IS NOT NULL
      AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND outcome IS NULL AND value_cents IS NULL
      AND currency IS NULL AND ref IS NULL)
    OR
    (kind = 'outcome'
      AND outcome IS NOT NULL
      AND vendor IS NULL AND model IS NULL
      AND input_tokens IS NULL AND output_tokens IS NULL
      AND (value_cents IS NULL) = (currency IS NULL))
  )
);
CREATE INDEX ingest_events_bucket_idx
  ON ingest_events (key_id, day, vendor, model, identity_id)
  WHERE kind = 'call';
CREATE INDEX ingest_events_day_idx ON ingest_events (day);
CREATE INDEX ingest_events_identity_idx ON ingest_events (identity_id);

-- Alert dedup state: one alert per (kind, scope, period).
CREATE TABLE alert_state (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  scope text NOT NULL,
  period_key text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, scope, period_key)
);

-- People in/out: one row per key/seat an offboard sweep tries to remove, kept
-- forever as history. At most one live item per identity (idempotent planning).
CREATE TABLE offboard_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  vendor text NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key', 'seat')),
  display_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'removed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX offboard_items_person_idx ON offboard_items (person_id, created_at DESC);
CREATE UNIQUE INDEX offboard_items_live_identity_key
  ON offboard_items (identity_id) WHERE status <> 'removed';

-- Jira/Linear success state machine (spec 7): derived from status-transition
-- history, so a quiet window can turn into a success weeks later.
CREATE TABLE issue_tracking (
  vendor text NOT NULL,
  source_ref text NOT NULL,
  issue_key text NOT NULL,
  title text,
  project text NOT NULL,
  identity_id uuid REFERENCES identities (id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  anchor_ts timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'success', 'fail')),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, source_ref),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX issue_tracking_product_idx ON issue_tracking (product_id, status);
CREATE INDEX issue_tracking_pending_idx ON issue_tracking (vendor, window_end)
  WHERE status = 'pending';

-- Project -> ROI mapping, chosen at connect. Unmapped projects fall through.
CREATE TABLE issue_project_routes (
  vendor text NOT NULL,
  project text NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, project)
);

-- ===========================================================================
-- Auth (spec 11/12): one admin claims the instance; viewers are added later.
-- ===========================================================================

-- Dashboard users. name is the login identifier. person_id links a login to a
-- person ("Can sign in"); a GDPR hard-delete takes the login with it. "Exactly
-- one admin" is enforced by the API's license gate, not a unique index.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash text,
  person_id uuid UNIQUE REFERENCES people (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))
  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_name_lower_key ON users (lower(name));

-- Passkeys. credential_id is base64url; public_key is the COSE key; counter
-- catches cloned authenticators.
CREATE TABLE webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

-- Sessions: the cookie holds a random token; the DB stores only its sha256.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Personal API keys: authenticate the dashboard API as their owner, inherit
-- the owner's role. Only the sha256 and a display prefix are stored.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at DESC);

-- One-time WebAuthn challenges, deleted on use so an assertion can't replay.
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge text NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time admin reset links (docker exec <container> reset-admin).
CREATE TABLE reset_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- Enterprise audit log. Recording is always on (so a license bought later
-- shows full history); reading/exporting is the licensed feature.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_name text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC, id DESC);
