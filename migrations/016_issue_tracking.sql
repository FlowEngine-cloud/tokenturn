-- Jira + Linear success integrations, full spec-7 shape.
--
-- One outcome kind for both: 'issue_done' - the Add ROI "Issues done
-- (Jira/Linear)" option. Replaces the interim 'jira_issue'/'linear_issue'
-- kinds (pre-release rename; outcome source_refs move to the issue URL, so
-- the two vendors can never collide on (kind, source_ref)).
UPDATE products SET outcome_kind = 'issue_done'
  WHERE outcome_kind IN ('jira_issue', 'linear_issue');
UPDATE outcomes SET kind = 'issue_done'
  WHERE kind IN ('jira_issue', 'linear_issue');
UPDATE rollup_outcomes_daily SET kind = 'issue_done'
  WHERE kind IN ('jira_issue', 'linear_issue');
UPDATE rollup_outcomes_daily SET kind = 'issue_done:reverted'
  WHERE kind IN ('jira_issue:reverted', 'linear_issue:reverted');
ALTER TABLE products DROP CONSTRAINT products_outcome_kind_check;
ALTER TABLE products ADD CONSTRAINT products_outcome_kind_check
  CHECK (outcome_kind IN ('none', 'github_pr', 'issue_done', 'sdk_event', 'manual'));

-- The per-issue success state machine (spec 7). An issue that hits the
-- connection's "submitted" status goes pending; it succeeds when the window
-- passes without regressing to the fail status (or reaches Done sooner) and
-- fails when it regresses inside the window. All of it is derived from
-- status-transition history (Jira changelog / Linear history), never from
-- the status the sync happens to observe - this table is what lets a quiet
-- window turn into a success weeks after the issue last appeared in a sync.
--
-- - source_ref = the issue's URL, same as the outcome it emits.
-- - product_id = where the issue's success routes (identity tag routing >
--   project mapping > the default "Issues done" row) - the ROI page's
--   ticket drill reads it.
-- - anchor_ts = first transition into submitted (or straight into Done);
--   window_end = anchor + the connection's window. status 'pending' rows
--   with window_end in the past promote to success at the end of each sync.
CREATE TABLE issue_tracking (
  vendor text NOT NULL,
  source_ref text NOT NULL,
  issue_key text NOT NULL,
  title text,
  project text NOT NULL,
  identity_id uuid REFERENCES identities(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  anchor_ts timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'success', 'fail')),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, source_ref),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX issue_tracking_product_idx ON issue_tracking (product_id, status);
CREATE INDEX issue_tracking_pending_idx ON issue_tracking (vendor, window_end)
  WHERE status = 'pending';

-- Project -> ROI mapping, chosen at connect (spec 7 routing layer 2: one
-- shared app creates everything, so the issue's project says which ROI it
-- belongs to). Unmapped projects fall through to the default row.
CREATE TABLE issue_project_routes (
  vendor text NOT NULL,
  project text NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, project)
);
