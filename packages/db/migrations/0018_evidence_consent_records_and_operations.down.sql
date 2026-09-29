-- Revert 0018_evidence_consent_records_and_operations.
-- DATA LOSS, stated: notes, tasks, proposal share links and worker heartbeats
-- are DELETED with their tables; which replies were handled and by whom, which
-- drafts answered which reply, meeting outcomes, bounce marks, suppression
-- sources and revocations are lost. Informational findings are DELETED before
-- `scored` is dropped — without the column the older code would render them
-- as gaps in the ICP table, a §2.2 violation the revert must not create.
DROP TRIGGER IF EXISTS worker_heartbeats_set_updated_at ON worker_heartbeats;
DROP TABLE IF EXISTS worker_heartbeats;
DROP TRIGGER IF EXISTS proposal_shares_set_updated_at ON proposal_shares;
DROP TABLE IF EXISTS proposal_shares;
DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
DROP TABLE IF EXISTS tasks;
DROP TRIGGER IF EXISTS notes_set_updated_at ON notes;
DROP TABLE IF EXISTS notes;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_outcome_known;
ALTER TABLE meetings DROP COLUMN IF EXISTS outcome;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_bounce_has_code;
ALTER TABLE contacts DROP COLUMN IF EXISTS email_bounce_code;
ALTER TABLE contacts DROP COLUMN IF EXISTS email_bounced_at;
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_name_is_not_agency;
ALTER TABLE users DROP COLUMN IF EXISTS revoked_at;
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_source_is_known;
ALTER TABLE suppressions DROP COLUMN IF EXISTS source;
DROP INDEX IF EXISTS touches_answers_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_answer_is_outbound;
ALTER TABLE touches DROP COLUMN IF EXISTS answers_touch_id;
DROP INDEX IF EXISTS touches_org_inbox_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_handled_has_who;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_handled_is_inbound_only;
ALTER TABLE touches DROP COLUMN IF EXISTS handled_by;
ALTER TABLE touches DROP COLUMN IF EXISTS handled_at;
DROP INDEX IF EXISTS findings_company_informational_idx;
DELETE FROM findings WHERE NOT scored;
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_informational_carries_no_weight;
ALTER TABLE findings DROP COLUMN IF EXISTS scored;
