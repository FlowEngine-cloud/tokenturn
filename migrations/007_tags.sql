-- Tags (spec 7b). Key names become tags at sync time: identities.tags
-- mirrors the vendor-side key name and is overwritten every sync, so a key
-- rename re-tags - and because every tag query joins facts to their
-- identity, the rename re-tags HISTORY retroactively, same rule as
-- identity resolution. manual_tags are Resolve decisions and survive sync.
-- This migration adds the per-tag configuration:
--
-- - tag_settings: one row per configured tag; no row = the defaults
--   (counts toward personal usage, points at no product). Rows persist
--   even while no key carries the tag - like person_emails, a tag decision
--   is remembered and re-applies if the tag comes back.
-- - counts_personal: the per-tag toggle (batch jobs, cron keys,
--   experiments). The dollar still belongs to its person (spec 4: one
--   dollar, one person) - the toggle only flags the spend so
--   personal-usage views and limits can exclude it.
-- - product_id: the tag points at a product; every key carrying the tag
--   routes there via identities.product_id (the single product-routing
--   point) and its burn lands on the product, never a person - the agent
--   convention (a key tagged "devin" burns on the Devin product, not on
--   whoever minted it). A key whose tags point at TWO products is a
--   conflict in the Resolve queue and is left unrouted - never guessed.
-- - rollup_daily.counts_personal joins the rollup grain so personal usage
--   stays chartable from rollups alone (raw facts power drill-downs only).

CREATE TABLE tag_settings (
  tag text PRIMARY KEY CHECK (tag = btrim(tag) AND tag <> ''),
  counts_personal boolean NOT NULL DEFAULT true,
  product_id uuid REFERENCES products (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rollup_daily
  ADD COLUMN counts_personal boolean NOT NULL DEFAULT true;
ALTER TABLE rollup_daily
  DROP CONSTRAINT rollup_daily_day_person_id_product_id_vendor_cost_basis_key;
ALTER TABLE rollup_daily
  ADD UNIQUE NULLS NOT DISTINCT
    (day, person_id, product_id, vendor, cost_basis, counts_personal);
