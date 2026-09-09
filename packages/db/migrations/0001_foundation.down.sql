-- Drop order matters: every table carrying a set_updated_at trigger must be
-- gone before the function itself, or Postgres refuses with a dependency error.
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS verification_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS orgs;
DROP FUNCTION IF EXISTS set_updated_at();
