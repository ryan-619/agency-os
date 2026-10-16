-- Revert 0023_quotes_profiles_share_links_and_places.
-- DATA LOSS, stated: every quote, every share link (quote, audit page and
-- website preview links stop opening), the agency's profile (legal name,
-- GSTIN, UPI ID, terms, brochure link) and every company's coordinates are
-- DELETED. Nothing before 0023 reads any of them.
ALTER TABLE companies
  DROP CONSTRAINT companies_coordinates_are_dated,
  DROP CONSTRAINT companies_coordinates_are_on_earth,
  DROP CONSTRAINT companies_coordinates_are_a_pair,
  DROP COLUMN longitude,
  DROP COLUMN latitude;

DROP TABLE share_links;
DROP TABLE quotes;
DROP TABLE org_profiles;
