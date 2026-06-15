-- Backfill the personal API keys table (spec 12b) for instances that applied
-- 002_auth.sql before that migration grew the api_keys table. The runner skips
-- already-applied files by name, so the table can only reach old DBs through a
-- new migration. Idempotent: fresh installs already have it from 002, so every
-- statement here is a no-op there.
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id, created_at DESC);
