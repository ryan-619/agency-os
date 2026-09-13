-- 0010_quiet_hours_need_a_timezone — where the recipient actually is.
--
-- PROMPT.md §2.1: "Quiet hours are enforced server-side in the RECIPIENT's
-- timezone, not the sender's." Phase 4's send path implements that rule, and
-- until now there was nothing on any row it could read.
--
-- `companies.country` is not it. A country is not a timezone — the United
-- States has six, Russia has eleven, and Australia's differ by half an hour
-- from each other. Deriving a zone from a country name is exactly the kind of
-- guess §2.1 exists to forbid, and its failure mode is sending at 3am to
-- somebody who will report it.
--
-- So: an IANA zone name, on the contact, with the company as a fallback for
-- the common case where a whole company shares one office. NULL is allowed and
-- NULL is a REFUSAL, not a default: `decideSend` returns `unknown_timezone`
-- and routes the message to a person. Not knowing what time it is where
-- somebody lives is a reason to wait.
--
-- The CHECK is deliberately loose. The authoritative list of IANA zones lives
-- in the runtime's ICU data and changes with it, so a database that enumerated
-- them would be wrong within a year — and wrong in the direction of rejecting
-- a zone that had just been added. `Intl.DateTimeFormat` is the real check
-- (`localMinutes` returns null for a zone it does not recognise, and the send
-- path refuses); this only stops the shapes that are obviously not zones, so a
-- country name typed into the field fails at the point somebody typed it.

ALTER TABLE contacts
  ADD COLUMN time_zone text,
  ADD CONSTRAINT contacts_time_zone_looks_like_iana
    CHECK (time_zone IS NULL OR time_zone ~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$');

ALTER TABLE companies
  ADD COLUMN time_zone text,
  ADD CONSTRAINT companies_time_zone_looks_like_iana
    CHECK (time_zone IS NULL OR time_zone ~ '^(UTC|[A-Za-z_+-]+/[A-Za-z0-9_+/-]+)$');

-- ---------------------------------------------------------------------------
-- Pausing one contact's sequence
-- ---------------------------------------------------------------------------
--
-- §8.4: "an inbound reply flips the deal to `replied` and pauses the sequence
-- for that contact immediately."
--
-- "Immediately" is the load-bearing word, and it is why this is a column on
-- `contacts` rather than a status on a campaign membership row. A reply is the
-- strongest possible signal that the next scheduled message would be wrong:
-- the person is already talking to a human, and a follow-up that arrives after
-- they replied reads as nobody having read what they wrote. It must stop every
-- sequence they are in, in every campaign, without anything having to
-- enumerate those campaigns first.
--
-- A reason, because a pause with no cause is indistinguishable from a bug and
-- gets cleared by whoever finds it. `paused_reason` is NOT NULL when paused, so
-- there is no way to pause without saying why.

ALTER TABLE contacts
  ADD COLUMN paused_at     timestamptz,
  ADD COLUMN paused_reason text,
  ADD CONSTRAINT contacts_pause_has_a_reason
    CHECK ((paused_at IS NULL) = (paused_reason IS NULL));

-- The send path asks "is this contact paused?" on every message, so it is
-- indexed — but only over the paused rows, which are the minority and the only
-- ones the question has a non-trivial answer for.
CREATE INDEX contacts_paused_idx ON contacts (org_id, paused_at) WHERE paused_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A touch that was refused says why
-- ---------------------------------------------------------------------------
--
-- §8.4's send path ends by writing `touches` and `audit_log` — on the way out.
-- A message that was REFUSED never reaches that point, and the refusal is the
-- more interesting record: it is what somebody reads when they ask why a
-- campaign of 40 sent 12.
--
-- `touches.error` already exists and is the wrong shape for it: an error is
-- something that went wrong, and a suppression is the system working. So the
-- refusal gets its own column, holding the machine-readable code from
-- `decideSend` — `suppressed`, `quiet_hours`, `daily_cap` and the rest — and
-- the existing `status` carries 'refused'.

ALTER TABLE touches ADD COLUMN refusal_code text;

-- 0004's status list predates the send path and has no word for "the rules
-- said no". The closest existing value is 'failed', which is wrong in the way
-- that matters: a failure is something to retry and investigate, and a
-- suppression is neither. Dropped and re-added rather than altered, which is
-- why these are `text` + CHECK and not a Postgres ENUM (CLAUDE.md §4).
ALTER TABLE touches DROP CONSTRAINT touches_status_check;
ALTER TABLE touches ADD CONSTRAINT touches_status_check
  CHECK (status IN ('queued', 'awaiting_approval', 'approved', 'sent',
                    'delivered', 'bounced', 'replied', 'failed', 'refused'));

ALTER TABLE touches ADD CONSTRAINT touches_refusal_is_explained
  CHECK ((status = 'refused') = (refusal_code IS NOT NULL));

-- A refused message was never sent, however it looks. Without this a bug in
-- the sender could write a row that reads as both refused and delivered, and
-- the touches table is the record anyone would consult to find out which.
ALTER TABLE touches ADD CONSTRAINT touches_refused_was_not_sent
  CHECK (status <> 'refused' OR (sent_at IS NULL AND provider_id IS NULL));

CREATE INDEX touches_refused_idx ON touches (org_id, refusal_code, created_at DESC)
  WHERE status = 'refused';
