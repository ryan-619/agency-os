-- 0008_a_draft_names_its_company — let a message exist before its recipient does.
--
-- PROMPT.md §4's `touches` is contact-centric: a message goes to a PERSON, and
-- the person belongs to a company, so the company is reachable through
-- contact_id. That holds for Phase 4, where a campaign sends to contacts who
-- have consented.
--
-- It does not hold for a draft. Phase 2's agent drafts an opener from a
-- company's findings, and it does so before any contact exists — deliberately,
-- because §2.1 makes consent per channel and per person, and there is no
-- consent to check yet. Such a row has contact_id NULL and recipient NULL, and
-- without this column it names nothing at all: a body of text about a company
-- nobody can identify, which is not a draft, it is a note.
--
-- Phase 4 wants it too. A touch's company is how a sender finds the findings
-- the message quotes, in order to re-verify them before it goes out (§2.2).
--
-- Nullable, because a Phase 4 reply arriving from a contact whose company was
-- deleted must still be logged; the whole point of touches is that the message
-- log outlives everything it points at.

ALTER TABLE touches
  ADD COLUMN company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX touches_company_idx ON touches (company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

-- A message has to be about someone or something. A row naming neither a
-- contact nor a company nor a campaign cannot be actioned, re-verified or
-- attributed, and is the shape a half-written tool produces.
ALTER TABLE touches ADD CONSTRAINT touches_names_a_subject
  CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL OR campaign_id IS NOT NULL);
