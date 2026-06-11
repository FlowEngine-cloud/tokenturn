-- Products = cost centers (spec section 7).
--
-- - products gain a default value per outcome (spec 7: "a product may set a
--   default value per outcome; track() overrides per event"). The default is
--   applied at READ time to outcomes that carry no explicit value, so
--   changing it later re-values history retroactively - same rule as every
--   other mapping in the ledger. Stored as billed: cents + currency.
-- - manual_entries: spend and outcomes for tools with no API (spec 7:
--   "manual monthly cost + optional manual value"). One row per
--   (product, kind, month), upserted - a correction rewrites the month in
--   place, nothing hard-deletes (spec 4). Each entry materializes into the
--   ledger so People/Products/Overview sum to the same total:
--     kind 'cost'     -> one spend_facts row on the month's first day,
--                        vendor 'manual', cost_basis 'manual'
--     kind 'outcomes' -> one outcomes row on the month's first day,
--                        kind 'manual', count = the entry's outcome_count
--   Both carry source_ref = the entry's id: manual rows are marked manual
--   and drill down to the entry, not vendor rows.
-- - cost_basis gains 'manual' on spend_facts and rollup_daily - the marker
--   that separates typed-in money from vendor-reported money.
-- - outcomes gain count (default 1): a manual entry records a month's worth
--   of outcomes ("42 tickets resolved") as one drillable row instead of 42
--   synthetic ones. value_cents stays PER OUTCOME (the unit track() and the
--   product default speak); a row's total value = count * value_cents.
-- - rollup_outcomes_daily counts become count-aware and gain valued_count
--   (how many outcomes carry an explicit value), so read-time default-value
--   math works from rollups alone:
--     value = value_usd_cents + (outcome_count - valued_count) * default.

ALTER TABLE products
  ADD COLUMN default_value_cents bigint CHECK (default_value_cents >= 0),
  ADD COLUMN default_value_currency text
    CHECK (default_value_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT products_default_value_pair
    CHECK ((default_value_cents IS NULL) = (default_value_currency IS NULL));

ALTER TABLE spend_facts
  DROP CONSTRAINT spend_facts_cost_basis_check,
  ADD CONSTRAINT spend_facts_cost_basis_check
    CHECK (cost_basis IN ('estimated', 'invoiced', 'manual'));

ALTER TABLE rollup_daily
  DROP CONSTRAINT rollup_daily_cost_basis_check,
  ADD CONSTRAINT rollup_daily_cost_basis_check
    CHECK (cost_basis IN ('estimated', 'invoiced', 'manual'));

ALTER TABLE outcomes
  ADD COLUMN count integer NOT NULL DEFAULT 1 CHECK (count >= 0);

ALTER TABLE rollup_outcomes_daily
  ADD COLUMN valued_count integer NOT NULL DEFAULT 0;
-- Best-effort backfill until the next recompute: rows with a value sum were
-- built when every counted outcome contributed (count was always 1).
UPDATE rollup_outcomes_daily
SET valued_count = outcome_count
WHERE value_usd_cents IS NOT NULL;

CREATE TABLE manual_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id),
  kind text NOT NULL CHECK (kind IN ('cost', 'outcomes')),
  -- The first day of the month the entry covers.
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  -- cost entries: the month's spend, stored as billed.
  amount_cents bigint CHECK (amount_cents >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  -- outcomes entries: how many, and (optionally) the per-outcome value -
  -- absent, the product's default value applies at read time.
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
