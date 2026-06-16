-- Catch-up migration for deployments created BEFORE subscription seats were
-- folded into 001_core_schema.sql.
--
-- 001 was squashed from 19 incremental files into one. The migrate runner
-- skips a migration whose NAME is already in schema_migrations, so a DB that
-- was migrated before the squash (it has the old 001..018 names recorded)
-- never re-runs the new 001 and so never gets the subscription-seats schema -
-- the new code then queries tables/columns that do not exist (500s).
--
-- This file has a NEW name, so every DB runs it once. Every statement is
-- guarded (IF NOT EXISTS / conditional), so on a fresh install - where 001
-- already created all of this - it is a clean no-op; on a pre-squash DB it
-- adds exactly what is missing. Keep it forever: it is the upgrade bridge.

ALTER TABLE spend_facts ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'metered'
  CHECK (billing_mode IN ('metered', 'subscription'));

ALTER TABLE rollup_daily ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'metered'
  CHECK (billing_mode IN ('metered', 'subscription'));

-- Widen the rollup unique key to include billing_mode, but only if it does not
-- already (a fresh DB built from 001 already has the wide key - leave it).
DO $$
DECLARE cname text;
DECLARE cdef text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO cname, cdef
  FROM pg_constraint WHERE conrelid = 'rollup_daily'::regclass AND contype = 'u';
  IF cname IS NOT NULL AND position('billing_mode' in cdef) = 0 THEN
    EXECUTE format('ALTER TABLE rollup_daily DROP CONSTRAINT %I', cname);
    EXECUTE 'ALTER TABLE rollup_daily ADD UNIQUE NULLS NOT DISTINCT '
      || '(day, person_id, product_id, vendor, cost_basis, counts_personal, billing_mode)';
  END IF;
END $$;

ALTER TABLE identities ADD COLUMN IF NOT EXISTS subscription_type text;

CREATE TABLE IF NOT EXISTS subscription_seats (
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
CREATE INDEX IF NOT EXISTS subscription_seats_person_idx ON subscription_seats (person_id);
CREATE INDEX IF NOT EXISTS subscription_seats_vendor_idx ON subscription_seats (vendor);
