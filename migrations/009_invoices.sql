-- Monthly invoice import (spec section 4): "Monthly invoice import (CSV)
-- trues estimated up to invoiced; Overview shows drift when they diverge."
--
-- - One row per (vendor, month), upserted - a correction rewrites the month
--   in place, nothing hard-deletes (same rule as manual_entries).
-- - amount is stored as billed: cents + currency; drill-downs show the
--   original, conversion happens via fx_rates like every other amount.
-- - source_ref optionally carries the vendor's invoice number - the vendor
--   record the trued-up numbers drill to.
-- - The true-up materializes as ONE adjustment spend_facts row per invoiced
--   (vendor, month): day = the month's last UTC day, cost_basis 'invoiced',
--   person/product NULL (no known owner -> the visible Unassigned bucket),
--   amount = invoice total minus what the synced facts already say (negative
--   when the vendor billed less than estimated), source_ref =
--   'invoice:<id>'. With it, estimated + invoiced sums to the invoice -
--   People and Products still each sum to the (now trued-up) total. The
--   adjustment is derived: it recomputes after every import and after every
--   sync that touches the month, and disappears when the drift is zero.
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  -- The first day of the month the invoice covers.
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_cents bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The vendor's invoice number, when the CSV carries one.
  source_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, month)
);
CREATE INDEX invoices_month_idx ON invoices (month);
