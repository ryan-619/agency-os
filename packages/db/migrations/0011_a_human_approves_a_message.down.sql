-- Revert 0011_a_human_approves_a_message.
--
-- Reverting loses who approved each message and which message each reply
-- answered. The first is the one worth saying out loud: after this runs, a
-- sent message that a person approved reads as one nobody approved.

-- A row mid-send when this runs has no status in the restored CHECK. 'failed'
-- is the safe reading: nobody can tell whether the provider was reached.
UPDATE touches SET status = 'failed', error = 'reverted 0011 while sending' WHERE status = 'sending';
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_status_check;
ALTER TABLE touches ADD CONSTRAINT touches_status_check
  CHECK (status IN ('queued', 'awaiting_approval', 'approved', 'sent',
                    'delivered', 'bounced', 'replied', 'failed', 'refused'));

DROP INDEX IF EXISTS touches_due_idx;
DROP INDEX IF EXISTS touches_provider_id_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_only_inbound_replies;
ALTER TABLE touches DROP COLUMN IF EXISTS in_reply_to;

ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_approver_and_time_agree;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_approved_has_approver;
ALTER TABLE touches
  DROP COLUMN IF EXISTS decision_note,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by;
