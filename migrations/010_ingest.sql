-- Ingest API (spec section 6): the SDK's events land here.
--
-- - ingest_events is the raw per-request ledger AND the dedupe key: the
--   client-side UUID is the primary key, the server upserts on it
--   (ON CONFLICT DO NOTHING), so SDK retries after a lost response can
--   never double-count. These are the "raw per-request facts" of spec 4 -
--   the 13-month retention applies here; everything derived survives.
-- - 'call' events (from wrap()) DERIVE spend_facts: one estimated fact per
--   (key, day, vendor, model, identity) bucket, re-aggregated from the
--   events after every batch - amount = tokens x the pinned price table,
--   rounded to cents once per bucket, never per call. The bucket fact's
--   source_ref is 'sdk:<key>:<day>:<identity>:<model>' (the reserved
--   'sdk:' prefix); its drill-down is the events behind the bucket.
-- - 'outcome' events (from track()) upsert outcomes rows directly: kind =
--   the tracked kind, source_ref = the caller's ref (the real record:
--   ticket id, coupon id) or 'sdk:<uuid>' when none was given. Re-tracking
--   the same (kind, ref) restates the outcome in place.
-- - employee emails become identities (vendor 'sdk', kind 'user'), running
--   through the same auto-match -> Resolve queue -> full-history
--   re-attribution machinery as every vendor identity.
-- - key_id keeps history when a key is revoked (revoke, never delete);
--   identity_id falls back to NULL on GDPR person-delete like facts do.

CREATE TABLE ingest_events (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES ingest_keys (id),
  product_id uuid NOT NULL REFERENCES products (id),
  kind text NOT NULL CHECK (kind IN ('call', 'outcome')),
  ts timestamptz NOT NULL,
  day date NOT NULL,
  -- call events
  vendor text CHECK (vendor IN ('openai', 'anthropic')),
  model text,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  -- outcome events
  outcome text,
  value_cents bigint CHECK (value_cents >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  ref text,
  -- both
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
-- The bucket re-aggregation path: all call events of one spend-fact bucket.
CREATE INDEX ingest_events_bucket_idx
  ON ingest_events (key_id, day, vendor, model, identity_id)
  WHERE kind = 'call';
CREATE INDEX ingest_events_day_idx ON ingest_events (day);
CREATE INDEX ingest_events_identity_idx ON ingest_events (identity_id);
