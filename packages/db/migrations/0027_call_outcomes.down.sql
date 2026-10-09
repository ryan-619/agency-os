-- Reverting 0027 forgets what came of every call and visit; the tasks, their
-- completions, the call-back tasks they made and the suppressions they wrote stay.
ALTER TABLE tasks DROP CONSTRAINT tasks_outcome_is_a_done_call_or_visit;
ALTER TABLE tasks DROP CONSTRAINT tasks_outcome_is_known;
ALTER TABLE tasks DROP COLUMN outcome;
