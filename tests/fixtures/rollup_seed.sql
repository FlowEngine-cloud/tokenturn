-- Rollup recompute fixture. Fixed UUIDs so tests can assert exact rows.
-- Covers: multi-currency (USD/EUR), estimated vs invoiced, the Unassigned
-- bucket (person_id NULL), product attribution, an FX day-gap (06-04 uses
-- the 06-03 EUR rate), a backfill day before the first rate (05-30 falls
-- forward to the 06-01 rate), and UTC day bucketing for outcomes.

INSERT INTO people (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@acme.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@acme.com', 'Bob');

INSERT INTO products (id, name, attribution, outcome_kind) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'support-bot', 'sdk', 'sdk_event');

INSERT INTO fx_rates (day, currency, usd_rate) VALUES
  ('2026-06-01', 'EUR', 1.10),
  ('2026-06-03', 'EUR', 1.20);

INSERT INTO spend_facts
  (day, person_id, product_id, vendor, model, tokens, amount_cents, currency, cost_basis, source_ref)
VALUES
  -- two same-group facts -> one rollup row (800 cents, 3000 tokens, count 2)
  ('2026-06-01', '11111111-1111-1111-1111-111111111111', NULL, 'anthropic', 'claude-sonnet', 1000, 500, 'USD', 'estimated', 'anthropic:usage:a1'),
  ('2026-06-01', '11111111-1111-1111-1111-111111111111', NULL, 'anthropic', 'claude-opus',   2000, 300, 'USD', 'estimated', 'anthropic:usage:a2'),
  -- EUR invoiced, rate of 2026-06-01 (1.10) -> 1100 usd cents
  ('2026-06-01', '22222222-2222-2222-2222-222222222222', NULL, 'openai', NULL, 0, 1000, 'EUR', 'invoiced', 'openai:invoice:b1'),
  -- Unassigned bucket: person NULL, never dropped
  ('2026-06-01', NULL, NULL, 'openai', 'gpt-5', 500, 250, 'USD', 'estimated', 'openai:usage:u1'),
  -- rate gap: 06-04 uses latest rate <= day (06-03, 1.20) -> 1200 usd cents
  ('2026-06-04', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'anthropic', 'claude-sonnet', 4000, 1000, 'EUR', 'estimated', 'anthropic:usage:b2'),
  -- backfill before the first EUR rate: falls forward to 06-01 (1.10) -> 110
  ('2026-05-30', '11111111-1111-1111-1111-111111111111', NULL, 'cursor', NULL, 0, 100, 'EUR', 'invoiced', 'cursor:invoice:a3');

INSERT INTO outcomes (ts, product_id, person_id, kind, value_cents, currency, source_ref) VALUES
  ('2026-06-01T10:00:00Z', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'ticket_resolved', 450, 'USD', 'zendesk:ticket:1'),
  -- Unassigned outcome, EUR -> 220 usd cents
  ('2026-06-01T23:30:00Z', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, 'ticket_resolved', 200, 'EUR', 'zendesk:ticket:2'),
  -- 02:00 UTC on 06-02 is still 06-01 in US timezones: must bucket as 06-02 (UTC)
  ('2026-06-02T02:00:00Z', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'ticket_resolved', NULL, NULL, 'zendesk:ticket:3');
