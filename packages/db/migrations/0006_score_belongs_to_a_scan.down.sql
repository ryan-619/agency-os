-- Revert 0006_score_belongs_to_a_scan.
--
-- Dropping the column drops the link; the scores themselves are untouched, so
-- the only loss is the ability to say which observations each one was computed
-- from.

DROP INDEX IF EXISTS scores_scan_idx;
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_scan_matches_company_and_org;
ALTER TABLE scores DROP COLUMN IF EXISTS scan_id;
