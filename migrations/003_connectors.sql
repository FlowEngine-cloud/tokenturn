-- Connector framework (spec section 5).
--
-- - connectors: one row per connected vendor, created after token scopes
--   validate on connect. Vendor credentials live encrypted in settings
--   (key connector:<vendor>:config), never here, never plaintext.
-- - spend_facts gains identity_id: facts remember which vendor identity
--   produced them, so a Resolve match can re-attribute the identity's full
--   history (spec 4), and a unique (vendor, source_ref) key so syncs upsert
--   and never duplicate a row - trailing 7-day re-pulls restate in place.
-- - identities gain the vendor-side email/display name, the raw material
--   for auto-match and Resolve suggestions.

CREATE TABLE connectors (
  vendor text PRIMARY KEY,
  connected_at timestamptz NOT NULL DEFAULT now(),
  -- How far back the vendor's history goes, captured at connect so the UI
  -- can show how far the backfill will reach.
  history_limit_days integer NOT NULL CHECK (history_limit_days > 0),
  -- Scopes reported by the vendor when the token validated on connect.
  scopes text[] NOT NULL DEFAULT '{}'
);

ALTER TABLE identities
  ADD COLUMN email text,
  ADD COLUMN display_name text;

ALTER TABLE spend_facts
  ADD COLUMN identity_id uuid REFERENCES identities (id) ON DELETE SET NULL;
CREATE INDEX spend_facts_identity_idx ON spend_facts (identity_id);

-- Idempotent upserts: one vendor record = one fact row, forever.
CREATE UNIQUE INDEX spend_facts_vendor_source_ref_key
  ON spend_facts (vendor, source_ref);
