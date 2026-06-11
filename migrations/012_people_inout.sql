-- People in / out (spec section 8).
--
-- - identities.deprovisioned_at: set when an offboard sweep removed the key
--   or seat at the vendor. The identity row itself stays - history is kept,
--   every old fact still drills to its key - it just stops being "current
--   access" and never re-plans into another sweep.
-- - offboard_items: one row per key/seat an offboard sweep tries to remove,
--   kept forever as the offboard history. status walks pending -> removed,
--   or pending -> failed with the vendor's error verbatim; failed items are
--   retried one by one. The partial unique index makes planning idempotent:
--   an identity has at most one live (not yet removed) item, so re-running
--   the sweep retries the existing failures instead of stacking duplicates.

ALTER TABLE identities
  ADD COLUMN deprovisioned_at timestamptz;

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
  -- The vendor's error, verbatim (spec 8: "Failed items show the vendor
  -- error, retryable one by one").
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX offboard_items_person_idx ON offboard_items (person_id, created_at DESC);
CREATE UNIQUE INDEX offboard_items_live_identity_key
  ON offboard_items (identity_id) WHERE status <> 'removed';
