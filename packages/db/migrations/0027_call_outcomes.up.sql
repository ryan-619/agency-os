-- 0027: what came of a call or a visit.
--
-- A call task (0022) is a person's act from their own phone, and a visit
-- one on foot; both were ticked "done" and nothing said what happened. Now
-- a done call or visit carries an OUTCOME — reached, no answer, busy, wrong
-- number, call back, not interested, asked to stop — which `/tasks` offers
-- in place of a plain Done, `tasksRecordOutcome` writes with the completion
-- in one transaction, and "What's working" and the brief can read.
--
-- Two of them do more than record: "call back" makes the next call task on
-- the day agreed, and "asked to stop" puts the number on the suppression
-- list first — §2.1's rule for voice, a person's word recorded by a person
-- — and refuses the outcome, loudly, if that row cannot be written.
ALTER TABLE tasks ADD COLUMN outcome text;
ALTER TABLE tasks ADD CONSTRAINT tasks_outcome_is_known
  CHECK (outcome IS NULL OR outcome IN ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back', 'not_interested', 'asked_to_stop'));
-- Only a done call or visit has one: an outcome on an open task, or on a to-do, is a claim.
ALTER TABLE tasks ADD CONSTRAINT tasks_outcome_is_a_done_call_or_visit
  CHECK (outcome IS NULL OR (kind IN ('call', 'visit') AND done_at IS NOT NULL));
