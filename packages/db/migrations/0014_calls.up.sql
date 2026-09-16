-- 0014_calls — what Phase 6 needs on the `calls` table 0004 created (PROMPT.md §4, §8.5).
--
-- 0004 laid the table down to §4's column list. The voice service needs a
-- few more things on it, and two of them are §2.1 obligations recorded so
-- they can be audited after the fact:
--
--   * disclosed_ai_at — the instant the AI said it was an AI. NULL on a call
--     the AI answered would mean the disclosure did not happen; the service
--     writes it before it says anything else.
--   * opted_out_at    — the instant the caller asked to be left alone, which
--     is also the instant a suppression row was written.
--
-- And one that is §2.4: an OUTBOUND call is a message leaving the building,
-- so it names the touch whose approval placed it. Added NOT VALID so a table
-- with rows already in it (there are none anywhere, but a migration does not
-- get to assume that) is not refused; new rows are checked.

ALTER TABLE calls
  ADD COLUMN company_id         uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN status             text NOT NULL DEFAULT 'ringing',
  ADD COLUMN from_number        text,
  ADD COLUMN to_number          text,
  ADD COLUMN provider           text NOT NULL DEFAULT 'twilio',
  ADD COLUMN answered_at        timestamptz,
  ADD COLUMN handoff_reason     text,
  ADD COLUMN disclosed_ai_at    timestamptz,
  ADD COLUMN opted_out_at       timestamptz,
  ADD COLUMN touch_id           uuid REFERENCES touches(id) ON DELETE SET NULL;

ALTER TABLE calls
  ADD CONSTRAINT calls_status_known CHECK (status IN
    ('ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'cancelled')),
  ADD CONSTRAINT calls_outcome_known CHECK (outcome IS NULL OR outcome IN
    ('qualified', 'not_qualified', 'handoff', 'opted_out', 'incomplete', 'no_answer', 'failed')),
  ADD CONSTRAINT calls_sentiment_known CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative')),
  ADD CONSTRAINT calls_ended_after_started CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  ADD CONSTRAINT calls_outbound_names_its_touch CHECK (direction = 'in' OR touch_id IS NOT NULL) NOT VALID;

CREATE INDEX calls_org_started_idx ON calls (org_id, started_at DESC);
CREATE INDEX calls_company_idx ON calls (company_id, started_at DESC);
