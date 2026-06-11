-- Auth (spec 11 + 12b): the first visitor claims the instance as the one
-- admin (passkey with password fallback), the admin adds view-only users,
-- sessions ride an httpOnly cookie, and the reset-admin CLI mints one-time
-- reset links. No email anywhere in login - the login identifier is the
-- username (users.name).

ALTER TABLE users ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX users_name_lower_key ON users (lower(name));

-- Exactly one admin (spec 11). Every admin row indexes the same key value,
-- so a second admin INSERT violates the unique index - this is also what
-- makes the first-boot claim race safe under concurrency.
CREATE UNIQUE INDEX users_one_admin_key ON users ((role)) WHERE role = 'admin';

-- Passkeys. credential_id is base64url (what the authenticator reports);
-- public_key is the COSE key; counter catches cloned authenticators.
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

-- Sessions: the cookie holds a random token; the DB stores only its sha256,
-- so a database dump never yields a usable session.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One-time WebAuthn challenges, deleted on use so an assertion can never be
-- replayed. user_id NULL = pre-login flows (first-boot claim, passkey login).
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge text NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time admin reset links (spec 12b: docker exec <container> reset-admin).
-- Same hashing rule as sessions: only the sha256 ever touches the DB.
CREATE TABLE reset_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
