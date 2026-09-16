-- 0015_a_booking_is_a_request — down.
--
-- 'inbound' companies become 'manual' BEFORE the old CHECK is restored:
-- re-adding a constraint that existing rows violate fails outright, and a
-- down migration that cannot run is not a down migration (§10). The
-- provenance is lost, which is the honest cost of reverting this.
DROP INDEX IF EXISTS meetings_needs_review_idx;

ALTER TABLE meetings DROP COLUMN IF EXISTS needs_review;

UPDATE companies SET source = 'manual' WHERE source = 'inbound';

ALTER TABLE companies DROP CONSTRAINT companies_source_check;
ALTER TABLE companies ADD CONSTRAINT companies_source_check
  CHECK (source IN ('apollo', 'manual', 'import', 'agent'));
