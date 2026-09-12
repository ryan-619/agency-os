-- Revert 0007_a_gated_tool_call.
--
-- Everything in reverse order, and note the one asymmetry: the original
-- `chat_sessions_sdk_id_idx` has to be RECREATED, not merely dropped, or a
-- `down all` followed by `up` leaves the database without an index 0005
-- created. CI runs exactly that sequence.

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP FUNCTION IF EXISTS audit_log_is_append_only();

DROP INDEX IF EXISTS chat_messages_tool_use_key;
DROP INDEX IF EXISTS chat_messages_turn_idx;
ALTER TABLE chat_messages
  DROP COLUMN IF EXISTS tool_use_id,
  DROP COLUMN IF EXISTS seq,
  DROP COLUMN IF EXISTS turn_id;

DROP INDEX IF EXISTS chat_sessions_sdk_id_key;
CREATE INDEX chat_sessions_sdk_id_idx ON chat_sessions (sdk_session_id)
  WHERE sdk_session_id IS NOT NULL;

ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_running_turn_is_timed;
ALTER TABLE chat_sessions
  DROP COLUMN IF EXISTS running_since,
  DROP COLUMN IF EXISTS running_turn_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_reason_belongs_to_a_decision;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_expired_has_no_decider;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_agent_request_is_traceable;
DROP INDEX IF EXISTS approvals_chat_session_idx;
DROP INDEX IF EXISTS approvals_org_turn_payload_key;
DROP INDEX IF EXISTS approvals_org_tool_use_key;
ALTER TABLE approvals
  DROP COLUMN IF EXISTS decided_reason,
  DROP COLUMN IF EXISTS payload_sha256,
  DROP COLUMN IF EXISTS tool_use_id,
  DROP COLUMN IF EXISTS turn_id,
  DROP COLUMN IF EXISTS chat_session_id;
