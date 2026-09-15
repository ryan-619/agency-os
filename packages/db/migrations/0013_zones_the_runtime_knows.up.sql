-- 0013_zones_the_runtime_knows — two things review found in 0010 and 0011.
--
-- ---------------------------------------------------------------------------
-- The timezone CHECK rejected zones the runtime accepts
-- ---------------------------------------------------------------------------
--
-- 0010 said, correctly, that the runtime's ICU data is the authority on zone
-- names and that the CHECK only stops "shapes that are obviously not zones".
-- Then it required a slash. 'Japan', 'GMT', 'EST5EDT', 'Egypt', 'Cuba' and
-- 'Zulu' are all valid IANA names with no slash, and `Intl.DateTimeFormat`
-- accepts every one of them — so `createContact` validated a zone, the
-- database refused it, and the person saw a 500 for typing something true.
--
-- The new pattern stops whitespace and punctuation that no zone name has,
-- and nothing else. The runtime remains the check that matters: a zone the
-- pattern lets through and ICU does not know is refused by `isKnownTimeZone`
-- before any row is written, and by the send path's `localMinutes` if one
-- somehow gets in.

ALTER TABLE contacts DROP CONSTRAINT contacts_time_zone_looks_like_iana;
ALTER TABLE contacts ADD CONSTRAINT contacts_time_zone_looks_like_iana
  CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');

ALTER TABLE companies DROP CONSTRAINT companies_time_zone_looks_like_iana;
ALTER TABLE companies ADD CONSTRAINT companies_time_zone_looks_like_iana
  CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');

-- ---------------------------------------------------------------------------
-- The Message-ID lookup had no index it could use
-- ---------------------------------------------------------------------------
--
-- 0011's `touches_provider_id_idx` leads with org_id. The inbound handler
-- looks a reply up by the Message-ID in its In-Reply-To header — and at that
-- moment it does not KNOW the org; the org is what the lookup finds. So the
-- index was never used and every inbound message scanned the table.
--
-- One index on provider_id alone, for outbound rows (the reply's parent), and
-- one for inbound rows (the idempotency check: a provider that retries a
-- webhook presents the same Message-ID twice).

CREATE INDEX touches_out_by_provider_id_idx ON touches (provider_id)
  WHERE provider_id IS NOT NULL AND direction = 'out';
CREATE INDEX touches_in_by_provider_id_idx ON touches (provider_id)
  WHERE provider_id IS NOT NULL AND direction = 'in';
DROP INDEX IF EXISTS touches_provider_id_idx;
