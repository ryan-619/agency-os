-- Revert 0010_quiet_hours_need_a_timezone.
--
-- Reverting this loses every recorded timezone and every pause. The pauses are
-- the ones worth naming: a paused contact is somebody who replied, and after a
-- down-migration their sequence resumes. Re-applying restores the columns and
-- not the values.

-- Any row that says 'refused' would violate the restored CHECK, so it becomes
-- 'failed' first. That LOSES the distinction this migration added — a refusal
-- reading as a failure afterwards — which is the honest consequence of
-- reverting and is why it is written down here rather than discovered.
UPDATE touches SET status = 'failed' WHERE status = 'refused';
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_status_check;
ALTER TABLE touches ADD CONSTRAINT touches_status_check
  CHECK (status IN ('queued', 'awaiting_approval', 'approved', 'sent',
                    'delivered', 'bounced', 'replied', 'failed'));

DROP INDEX IF EXISTS touches_refused_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_refused_was_not_sent;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_refusal_is_explained;
ALTER TABLE touches DROP COLUMN IF EXISTS refusal_code;

DROP INDEX IF EXISTS contacts_paused_idx;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_pause_has_a_reason;
ALTER TABLE contacts
  DROP COLUMN IF EXISTS paused_reason,
  DROP COLUMN IF EXISTS paused_at;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_time_zone_looks_like_iana;
ALTER TABLE companies DROP COLUMN IF EXISTS time_zone;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_time_zone_looks_like_iana;
ALTER TABLE contacts DROP COLUMN IF EXISTS time_zone;
