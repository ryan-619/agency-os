-- 0015_a_booking_is_a_request — the public booking page writes about strangers.
--
-- Review found that `bookInbound` treated an anonymous form submission as
-- authoritative about a person the team may ALREADY have on file. Three
-- consequences, all reachable by anyone who knows an address:
--
--   * a recorded refusal (`consents.granted = false`) was REPLACED with a
--     grant, because recordConsent upserts — and §2.1 says a refusal is one
--     of the things nobody can approve past;
--   * an existing contact's `phone` and `time_zone` were overwritten, and
--     `time_zone` is the clock quiet hours are evaluated against;
--   * an existing company's deal was advanced to `meeting` by anyone who
--     could guess an address at its domain.
--
-- The code fix is that a booking may CREATE records and may never MODIFY
-- ones it did not create. This migration gives that fix two things it needs
-- to be legible rather than silent:
--
--   1. `companies.source = 'inbound'`. A company invented from a stranger's
--      email domain was stored as 'manual', which reads as "a person on the
--      team typed this". `contacts.source` has had 'inbound' since 0003; this
--      closes the gap so provenance survives into the UI and into the agent's
--      context, where unverified free text must never look like agency data.
--   2. `meetings.needs_review`. A booking that matched an existing contact or
--      company is recorded — refusing a real prospect for being known would
--      be worse — but nothing else about them is touched and a person is told
--      to confirm who it actually was.

ALTER TABLE companies DROP CONSTRAINT companies_source_check;
ALTER TABLE companies ADD CONSTRAINT companies_source_check
  CHECK (source IN ('apollo', 'manual', 'import', 'agent', 'inbound'));

ALTER TABLE meetings
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN meetings.needs_review IS
  'An unauthenticated booking matched a contact or company already on file. Nothing about them was modified; a person confirms who booked before acting on it.';

-- The booking page is the only unauthenticated writer in the product, so the
-- rows it makes are worth finding quickly when one turns out to be spam.
CREATE INDEX meetings_needs_review_idx ON meetings (org_id, starts_at DESC)
  WHERE needs_review;
