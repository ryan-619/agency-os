-- Revert 0021_firmographics_and_one_active_icp.
-- DATA LOSS, stated: every company's industry, city, description and the
-- source of its headcount are DELETED with their columns. `headcount` itself
-- predates 0021 and stays, unchecked again. Code before 0021 reads none of
-- them. The ICP profiles stay as they are, and more than one may then be
-- active again — which code before 0021 never writes.
DROP INDEX icp_profiles_one_active_per_org;

ALTER TABLE companies
  DROP CONSTRAINT companies_headcount_is_a_count,
  DROP COLUMN industry,
  DROP COLUMN city,
  DROP COLUMN description,
  DROP COLUMN headcount_source;
