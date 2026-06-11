-- Limits (spec section 9): a monthly spend limit per person, compared
-- against the calendar month's (UTC) attributed spend from rollup_daily.
--
-- Stored in USD cents - the same unit every rollup amount normalizes to -
-- so the comparison never needs an FX lookup of its own. NULL = no limit.
-- This is OUR alert threshold (Slack at 80%/100%): nothing here hard-stops
-- vendor spend. The vendor's own limit is shown next to it where the
-- vendor reports one (Cursor), and can be pushed to Cursor (Enterprise)
-- on request.
ALTER TABLE people
  ADD COLUMN monthly_limit_usd_cents bigint
    CHECK (monthly_limit_usd_cents IS NULL OR monthly_limit_usd_cents > 0);
