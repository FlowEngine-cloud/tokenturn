-- Core schema (spec section 4) plus auth/config/ingest/alert tables and
-- the daily rollup tables.
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

-- People: employees. Matched across vendors by email (case-insensitive).
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'offboarded', 'archived')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('csv', 'okta', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_email_lower_key ON people (lower(email));

-- Products: cost centers. Anything that spends AI money.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  attribution text NOT NULL
    CHECK (attribution IN ('connector', 'key', 'sdk', 'manual')),
  outcome_kind text NOT NULL DEFAULT 'none'
    CHECK (outcome_kind IN ('none', 'github_pr', 'sdk_event', 'manual')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_name_lower_key ON products (lower(name));

-- Identities: the mapping table from vendor identities (users, API keys,
-- seats) to people. person_id NULL = unresolved, sits in the Resolve queue.
-- Key names become tags (spec 7b).
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  vendor text NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key', 'seat')),
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, external_id, kind)
);
CREATE INDEX identities_person_idx ON identities (person_id);

-- Spend facts: raw per-day spend rows pulled from vendors. source_ref always
-- points at the vendor record - that's what makes every number drillable.
-- Raw facts keep 13 months (a retention job purges; rollups stay forever).
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
  cost_basis text NOT NULL CHECK (cost_basis IN ('estimated', 'invoiced')),
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spend_facts_day_idx ON spend_facts (day);
CREATE INDEX spend_facts_person_idx ON spend_facts (person_id, day);
CREATE INDEX spend_facts_product_idx ON spend_facts (product_id, day);
CREATE INDEX spend_facts_vendor_idx ON spend_facts (vendor, day);

-- Outcomes: successes (merged PR, resolved ticket, ...). value_cents is
-- optional; when present, currency is required. source_ref points at the
-- real record (PR URL, ticket id).
CREATE TABLE outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  person_id uuid REFERENCES people (id) ON DELETE SET NULL,
  kind text NOT NULL,
  value_cents bigint,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((value_cents IS NULL) = (currency IS NULL))
);
CREATE INDEX outcomes_product_idx ON outcomes (product_id, ts);
CREATE INDEX outcomes_person_idx ON outcomes (person_id, ts);

-- FX rates (daily, ECB). usd_rate = USD per 1 unit of currency, so
-- amount_usd = amount * usd_rate. USD itself never needs a row (rate 1).
CREATE TABLE fx_rates (
  day date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  usd_rate numeric NOT NULL CHECK (usd_rate > 0),
  PRIMARY KEY (day, currency)
);

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

-- Dashboard users: one admin (first visitor signs up, passkey with password
-- fallback) plus view-only users. Email optional - no email needed to log in.
-- Passkey credential storage arrives with the auth feature as its own table.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  name text,
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))
  WHERE email IS NOT NULL;

-- Settings: all config lives here (DATABASE_URL is the only env var).
-- secret=true rows hold AES-256-GCM ciphertext (key in the data volume),
-- stored as a JSON string in value. Never plaintext.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ingest keys: SDK auth, minted in Settings, scoped per product. The
-- plaintext token is shown once and never stored - only its sha256 hex.
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

-- Alert dedup state: one alert per (kind, scope, period).
--   limit_80 / limit_100: scope = person id, period_key = 'YYYY-MM' (UTC)
--   anomaly:              scope = person id, period_key = 'YYYY-MM-DD'
--   connector_silent:     scope = connector, period_key = 'YYYY-MM-DD'
CREATE TABLE alert_state (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  scope text NOT NULL,
  period_key text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, scope, period_key)
);

-- Daily rollups: power every chart; raw facts power drill-downs only.
-- Derived tables, rebuilt by the recompute job - so no FKs (GDPR person
-- delete keeps the aggregate here even after the person row is gone).
-- Amounts are normalized to USD cents at rollup time; conversion to the
-- org's display currency happens at read time via fx_rates, so changing
-- the display currency never needs a recompute.
-- person_id NULL = Unassigned, product_id NULL = no cost center.
CREATE TABLE rollup_daily (
  day date NOT NULL,
  person_id uuid,
  product_id uuid,
  vendor text NOT NULL,
  cost_basis text NOT NULL CHECK (cost_basis IN ('estimated', 'invoiced')),
  tokens bigint NOT NULL DEFAULT 0,
  amount_usd_cents bigint NOT NULL,
  fact_count integer NOT NULL,
  UNIQUE NULLS NOT DISTINCT (day, person_id, product_id, vendor, cost_basis)
);
CREATE INDEX rollup_daily_person_idx ON rollup_daily (person_id, day);
CREATE INDEX rollup_daily_product_idx ON rollup_daily (product_id, day);

CREATE TABLE rollup_outcomes_daily (
  day date NOT NULL,
  product_id uuid NOT NULL,
  person_id uuid,
  kind text NOT NULL,
  outcome_count integer NOT NULL,
  value_usd_cents bigint,
  UNIQUE NULLS NOT DISTINCT (day, product_id, person_id, kind)
);
CREATE INDEX rollup_outcomes_product_idx ON rollup_outcomes_daily (product_id, day);
