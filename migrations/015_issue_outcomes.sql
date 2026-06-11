-- Jira + Linear success integrations (spec 7): they write outcomes only -
-- never spend - with kinds 'jira_issue' / 'linear_issue'. Widen the
-- products.outcome_kind gate so an ROI can count them, same as github_pr.

ALTER TABLE products DROP CONSTRAINT products_outcome_kind_check;
ALTER TABLE products ADD CONSTRAINT products_outcome_kind_check
  CHECK (outcome_kind IN ('none', 'github_pr', 'jira_issue', 'linear_issue', 'sdk_event', 'manual'));
