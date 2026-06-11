-- Line survival (spec 5) - the real quality metric for AI-written code.
--
-- One row per (merged AI PR, horizon): how many of the lines the PR added
-- still existed unchanged on the repo's base branch 30/90 days after the
-- merge. Written by the background survival job (src/lib/survival.ts),
-- which reads the repo's own git data through the GitHub connector's
-- token - vendors report line counts, never which lines, so survival can
-- only come from git itself.
--
-- - source_ref joins outcomes (kind 'github_pr'); the PR's tools[] say
--   which coding tool the lines belong to.
-- - A check is final once written: it measures the repo AT the horizon
--   commit, so re-running late never changes the answer.
-- - error rows record PRs that can never be measured (repo gone, branch
--   deleted, PR too large); lines stay NULL and the aggregates skip them -
--   a number is measured or absent, never invented.

CREATE TABLE survival_checks (
  source_ref text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days > 0),
  lines_written integer CHECK (lines_written >= 0),
  lines_alive integer CHECK (lines_alive >= 0),
  error text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_ref, horizon_days),
  CHECK (lines_alive IS NULL OR lines_alive <= lines_written),
  CHECK ((error IS NULL) = (lines_written IS NOT NULL AND lines_alive IS NOT NULL))
);
