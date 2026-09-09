DROP TABLE IF EXISTS scores;
-- Triggers go with their tables; the functions they call do not.
DROP TABLE IF EXISTS findings;
DROP FUNCTION IF EXISTS findings_refuse_claims_from_a_failed_scan();
DROP TABLE IF EXISTS scans;
DROP FUNCTION IF EXISTS scans_refuse_demotion_with_observations();
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS icp_profiles;
