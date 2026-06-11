-- Outcome upserts + revert flips (spec 5 GitHub row, "Outcome counting").
--
-- - (kind, source_ref) is the idempotent upsert key for connector-written
--   outcomes: re-pulls restate in place and never duplicate a merged PR.
-- - tools: the AI authorship detected on the record (bot author or
--   co-author trailers); empty = human-only. Powers the Tools page
--   per-tool $/merge split and revert rates.
-- - reverted_at / revert_source_ref: a merged PR counts on merge; a revert
--   referencing it within revert_window_days (Settings, default 30) flips
--   it. The flip is recorded here - the original row is never deleted, and
--   revert_source_ref drills to the reverting record.
-- - meta: vendor record keys a later revert may reference (the PR's merge +
--   head commit shas, under "shas"). This is what lets a revert synced
--   weeks after its target find it without re-fetching history.

ALTER TABLE outcomes
  ADD COLUMN tools text[] NOT NULL DEFAULT '{}',
  ADD COLUMN reverted_at timestamptz,
  ADD COLUMN revert_source_ref text,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX outcomes_kind_source_ref_key ON outcomes (kind, source_ref);
