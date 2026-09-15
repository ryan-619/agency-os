-- Revert 0013_zones_the_runtime_knows.
--
-- Restoring 0010's stricter pattern fails if any row holds a slash-less zone
-- the runtime accepts ('Japan', 'GMT'). Those rows are set to NULL first,
-- which the send path reads as "unknown timezone, refuse" — the safe reading
-- — rather than the down-migration aborting halfway.

DROP INDEX IF EXISTS touches_in_by_provider_id_idx;
DROP INDEX IF EXISTS touches_out_by_provider_id_idx;
CREATE INDEX touches_provider_id_idx ON touches (org_id, provider_id)
  WHERE provider_id IS NOT NULL AND direction = 'out';

UPDATE contacts SET time_zone = NULL
  WHERE time_zone IS NOT NULL AND time_zone !~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$';
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_time_zone_looks_like_iana;
ALTER TABLE contacts ADD CONSTRAINT contacts_time_zone_looks_like_iana
  CHECK (time_zone IS NULL OR time_zone ~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$');

UPDATE companies SET time_zone = NULL
  WHERE time_zone IS NOT NULL AND time_zone !~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$';
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_time_zone_looks_like_iana;
ALTER TABLE companies ADD CONSTRAINT companies_time_zone_looks_like_iana
  CHECK (time_zone IS NULL OR time_zone ~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$');
