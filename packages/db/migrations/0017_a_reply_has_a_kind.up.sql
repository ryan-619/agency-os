-- What kind of reply it was, for triage (§5.5's classify_reply).
--
-- A three-person agency reads every reply; a pipeline with two hundred
-- contacted companies does not. The kind is what lets somebody open the four
-- that said "interested" before the ninety that were out of office.
--
-- NULLABLE on purpose: every reply recorded before this migration has no
-- kind, and inventing one for them would be a claim about mail nobody
-- classified. NULL means "not classified", which is different from 'other'
-- ("classified, and it is none of these").
--
-- 'opted_out' is in this list and is NEVER decided by a model. §2.1 puts the
-- opt-out reader in packages/core as a pure function over the person's own
-- words, because a model having a pleasant conversation is exactly the one
-- that misses "take me off your list". The classifier below it only ever
-- sees replies that pure function already cleared.
ALTER TABLE touches ADD COLUMN reply_kind text;

ALTER TABLE touches ADD CONSTRAINT touches_reply_kind_is_known CHECK (
  reply_kind IS NULL
  OR reply_kind IN ('opted_out', 'interested', 'not_now', 'wrong_person', 'auto_reply', 'other')
);

-- Only an INBOUND touch can have one. An outbound message is not a reply, and
-- a kind on one would be a category error somebody would later read as data.
ALTER TABLE touches ADD CONSTRAINT touches_reply_kind_is_inbound_only CHECK (
  reply_kind IS NULL OR direction = 'in'
);

-- The triage query: "show me the interested ones", scoped to an org.
CREATE INDEX touches_org_reply_kind_idx ON touches (org_id, reply_kind)
  WHERE reply_kind IS NOT NULL;
