-- Identity resolution (spec 5 "Identity resolution"; spec 4: a Resolve match
-- re-attributes that identity's FULL history, not just future spend).
--
-- - person_emails: the match memory - confirmed forever. Auto-match by email
--   (case-insensitive) consults these aliases first, then people.email, so a
--   Resolve confirm or a person merge is remembered: any future identity on
--   any vendor carrying that email auto-maps with no human action. Rows are
--   always stored lowercase.
-- - people.merged_into: two emails, one human (spec 5). The merged-away row
--   archives and points at the survivor; auto-match skips merged rows and
--   the merged email becomes an alias of the survivor, so history and all
--   future spend follow the surviving person.
-- - identities.not_person: a key marked "not a person" (service account).
--   person_id stays NULL forever - auto-match never re-fills it - and its
--   spend routes to a product (identities.product_id) and/or a tag instead.
-- - identities.product_id: per-key product routing. A key routes to at most
--   one product (spec 7b); its facts inherit the product at sync time and
--   the full history is re-attributed when the routing is set.
-- - identities.manual_tags: tags added in Resolve. Kept apart from tags,
--   which mirror the vendor-side key name and are overwritten every sync
--   (a key rename re-tags); manual tags survive.
-- - outcomes.identity_id: outcomes remember the vendor identity that earned
--   them, exactly like facts and metrics, so a Resolve match re-attributes
--   outcome history too.

ALTER TABLE people
  ADD COLUMN merged_into uuid REFERENCES people (id) ON DELETE SET NULL;

CREATE TABLE person_emails (
  email text PRIMARY KEY CHECK (email = lower(email)),
  person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_emails_person_idx ON person_emails (person_id);

ALTER TABLE identities
  ADD COLUMN not_person boolean NOT NULL DEFAULT false,
  ADD COLUMN product_id uuid REFERENCES products (id),
  ADD COLUMN manual_tags text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT identities_not_person_unmapped
    CHECK (NOT (not_person AND person_id IS NOT NULL));

ALTER TABLE outcomes
  ADD COLUMN identity_id uuid REFERENCES identities (id) ON DELETE SET NULL;
CREATE INDEX outcomes_identity_idx ON outcomes (identity_id);
