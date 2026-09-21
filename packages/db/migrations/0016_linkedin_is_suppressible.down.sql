-- Reverting REMOVES LinkedIn suppressions, because the narrower CHECK cannot
-- be added while rows violating it exist. That is data loss and it is the
-- only way down: the alternative is a migration that fails on any database
-- where the feature was used. A down that cannot run is worse than one that
-- says what it costs (§10 requires every migration to be reversible).
DELETE FROM suppressions WHERE kind = 'linkedin';

ALTER TABLE suppressions DROP CONSTRAINT suppressions_value_is_normalised;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_value_is_normalised CHECK (
  CASE kind
    WHEN 'phone' THEN value ~ '^\+[1-9][0-9]{6,14}$'
    ELSE value = lower(btrim(value)) AND length(value) > 0
  END
);

ALTER TABLE suppressions DROP CONSTRAINT suppressions_kind_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_kind_check
  CHECK (kind IN ('email', 'domain', 'phone'));
