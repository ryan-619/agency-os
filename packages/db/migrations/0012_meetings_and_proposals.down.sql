-- Revert 0012_meetings_and_proposals.
--
-- Drops every meeting and every proposal. The proposals are the loss worth
-- naming: each is a generated document tied to the scan it came from, and
-- regenerating one after re-applying this migration produces the CURRENT
-- scan's scope, not the one the buyer was sent.

DROP INDEX IF EXISTS deals_one_open_per_company;

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_booking_slug_is_url_safe;
ALTER TABLE orgs DROP COLUMN IF EXISTS booking_slug;

DROP TRIGGER IF EXISTS proposals_set_updated_at ON proposals;
DROP INDEX IF EXISTS proposals_company_idx;
DROP INDEX IF EXISTS proposals_org_status_idx;
DROP TABLE IF EXISTS proposals;

DROP TRIGGER IF EXISTS meetings_set_updated_at ON meetings;
DROP INDEX IF EXISTS meetings_company_idx;
DROP INDEX IF EXISTS meetings_org_starts_idx;
DROP TABLE IF EXISTS meetings;
