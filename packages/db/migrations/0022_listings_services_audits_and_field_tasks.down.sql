-- Revert 0022_listings_services_audits_and_field_tasks.
-- DATA LOSS, stated: every company's listing facts (phone, address, place id,
-- Maps link, rating, review count, category, listed website and when they
-- were read), every service in the catalogue and every PageSpeed audit are
-- DELETED. A company with no website keeps its `<slug>.nosite.invalid`
-- placeholder domain, which code before 0022 shows as a domain and never
-- scans (`.invalid` is refused as a host). Call and visit tasks become plain
-- to-dos, with their titles and details kept; a company that came in from
-- Google Maps is recorded as the agent's.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_known;
UPDATE tasks SET kind = 'todo' WHERE kind IN ('call', 'visit');
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_known CHECK (kind IN ('todo', 'linkedin_send', 'kickoff', 'renewal'));

DROP TABLE site_audits;
DROP TABLE services;

ALTER TABLE companies DROP CONSTRAINT companies_id_org_key;

ALTER TABLE companies DROP CONSTRAINT companies_source_check;
UPDATE companies SET source = 'agent' WHERE source = 'google_maps';
ALTER TABLE companies ADD CONSTRAINT companies_source_check
  CHECK (source IN ('apollo', 'manual', 'import', 'agent', 'inbound'));

DROP INDEX companies_org_place_key;

ALTER TABLE companies
  DROP CONSTRAINT companies_phone_is_e164,
  DROP CONSTRAINT companies_address_is_bounded,
  DROP CONSTRAINT companies_place_id_is_bounded,
  DROP CONSTRAINT companies_maps_url_is_https,
  DROP CONSTRAINT companies_rating_is_a_rating,
  DROP CONSTRAINT companies_review_count_is_a_count,
  DROP CONSTRAINT companies_category_is_bounded,
  DROP CONSTRAINT companies_listing_website_is_bounded,
  DROP CONSTRAINT companies_listing_has_its_time,
  DROP COLUMN phone,
  DROP COLUMN address,
  DROP COLUMN google_place_id,
  DROP COLUMN google_maps_url,
  DROP COLUMN google_rating,
  DROP COLUMN google_review_count,
  DROP COLUMN google_category,
  DROP COLUMN listing_website,
  DROP COLUMN listing_checked_at;
