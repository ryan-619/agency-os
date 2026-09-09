DROP TABLE IF EXISTS scores;
-- The trigger goes with the table; the function it calls does not.
DROP TABLE IF EXISTS findings;
DROP FUNCTION IF EXISTS findings_refuse_claims_from_a_failed_scan();
DROP TABLE IF EXISTS scans;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS icp_profiles;
