-- Enterprise (spec 11): the audit log, and roster sources for the directory
-- syncs. Recording into audit_log is always on (so a license bought later
-- shows full history); reading/exporting it is the licensed feature.

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  -- The dashboard user who acted; NULL = the system (scheduler, Okta hook).
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC, id DESC);

-- Directory syncs add people too (spec 11: Okta, Google Workspace).
ALTER TABLE people DROP CONSTRAINT people_source_check;
ALTER TABLE people ADD CONSTRAINT people_source_check
  CHECK (source IN ('csv', 'okta', 'google', 'manual'));

-- More admins is an enterprise feature (spec 11), so "exactly one admin"
-- moves from this index to the API's license gate. The first-boot claim
-- race the index used to break is now serialized with an advisory lock in
-- the setup routes.
DROP INDEX users_one_admin_key;
