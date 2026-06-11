-- First statement succeeds, second is invalid SQL.
-- The whole file must roll back: partial_table must NOT exist afterwards.
CREATE TABLE partial_table (
  id serial PRIMARY KEY
);

THIS IS NOT VALID SQL;
