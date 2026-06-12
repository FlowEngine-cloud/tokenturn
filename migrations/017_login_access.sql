-- Login access is a property of the person (spec 10.6): a user row may link
-- to a person, set from the person page ("Can sign in"). Existing logins
-- migrate by email-matching their username to a person; the unmatched keep
-- their person-less login (sessions untouched) and stay listed on People.
-- A GDPR hard-delete takes the linked login with it.

ALTER TABLE users
  ADD COLUMN person_id uuid UNIQUE REFERENCES people (id) ON DELETE CASCADE;

-- One login per person: should several logins match one email (one by its
-- username, one by its optional email column), the oldest wins and the rest
-- stay person-less - still working, still listed.
UPDATE users u
SET person_id = m.person_id
FROM (
  SELECT DISTINCT ON (p.id) p.id AS person_id, c.id AS user_id
  FROM users c
  JOIN people p
    ON p.merged_into IS NULL
   AND lower(p.email) = lower(coalesce(c.email, c.name))
  WHERE c.person_id IS NULL
  ORDER BY p.id, c.created_at
) m
WHERE u.id = m.user_id;
