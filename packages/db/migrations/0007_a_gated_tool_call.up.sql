-- 0007_a_gated_tool_call — make an approval name the tool call it gates.
--
-- Phase 2 turns `approvals` from a table that RECORDS a decision into the thing
-- a running turn BLOCKS on. Three facts about the installed Agent SDK make that
-- need columns the table does not have.
--
-- 1. `Query.reinitialize()` redelivers a pending can_use_tool request after a
--    transport gap, and the SDK's own documentation says callbacks must be
--    idempotent because "a request whose response was lost in the gap will be
--    dispatched again". An unconditional INSERT therefore writes a second row
--    for one tool call: two cards, two humans, one action. `options.toolUseID`
--    is REQUIRED on the callback, so it is the natural key this table never
--    had.
--
-- 2. The same documentation says a tool call that races an unanswered hook is
--    "denied with a retry notice" and retried — and the retry carries a NEW
--    tool_use_id. So tool_use_id ALONE does not deduplicate the one case the
--    SDK explicitly tells us to expect. A hash of the payload, scoped to the
--    turn, does.
--
-- 3. A turn that a worker restart interrupted is invisible without a marker, so
--    a browser that reattaches shows a spinner with no end. `chat_sessions`
--    carries the marker and the boot reconciler clears it.
--
-- No table is added, so CI's count of 23 application tables plus the migration
-- ledger still holds.

-- ---------------------------------------------------------------------------
-- approvals — name the call, the bytes, and the turn
-- ---------------------------------------------------------------------------

ALTER TABLE approvals
  ADD COLUMN chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  ADD COLUMN turn_id         uuid,
  ADD COLUMN tool_use_id     text,
  ADD COLUMN payload_sha256  text,
  ADD COLUMN decided_reason  text;

-- SET NULL rather than CASCADE, for the reason already written out for
-- touches.contact_id: deleting a chat thread must not erase the record that a
-- human made a decision (§2.4). The approval outlives the conversation.

-- The redelivery key. Partial, because Phase 4 raises approvals that never came
-- from a tool call at all and those rows have no tool_use_id.
CREATE UNIQUE INDEX approvals_org_tool_use_key
  ON approvals (org_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- The retry key. Deliberately NOT narrowed to pending rows: if a human denied
-- this exact call and the model asks again inside the same turn, reusing the
-- decided row is precisely what the human's answer meant. The gate reads the
-- row's status and refuses again without asking anyone a second time.
CREATE UNIQUE INDEX approvals_org_turn_payload_key
  ON approvals (org_id, turn_id, tool_name, payload_sha256)
  WHERE turn_id IS NOT NULL;

CREATE INDEX approvals_chat_session_idx
  ON approvals (chat_session_id, created_at DESC) WHERE chat_session_id IS NOT NULL;

-- An approval the agent raised must name the call it gates and the bytes the
-- human was shown. A row that cannot be traced back to a specific tool call is
-- not a gate, it is a note.
ALTER TABLE approvals ADD CONSTRAINT approvals_agent_request_is_traceable
  CHECK (requested_by <> 'agent'
         OR (chat_session_id IS NOT NULL AND turn_id IS NOT NULL
             AND tool_use_id IS NOT NULL AND payload_sha256 IS NOT NULL));

-- Expiry is a lapse, not a decision. approvals_decided_has_decider already
-- PERMITS an expired row to have no decider; this forbids it from having one,
-- so a sweeper can never leave behind a row that reads as a person's answer.
ALTER TABLE approvals ADD CONSTRAINT approvals_expired_has_no_decider
  CHECK (status <> 'expired' OR (decided_by IS NULL AND decided_at IS NULL));

-- A reason is part of a decision. A pending row carrying one is a draft of an
-- answer nobody has given.
ALTER TABLE approvals ADD CONSTRAINT approvals_reason_belongs_to_a_decision
  CHECK (decided_reason IS NULL OR status IN ('approved', 'denied'));

-- ---------------------------------------------------------------------------
-- chat_sessions — a turn in flight, so a restart is visible instead of a spinner
-- ---------------------------------------------------------------------------

ALTER TABLE chat_sessions
  ADD COLUMN running_turn_id uuid,
  ADD COLUMN running_since   timestamptz;

ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_running_turn_is_timed
  CHECK ((running_turn_id IS NULL) = (running_since IS NULL));

-- sdk_session_id's index was partial and NON-unique, so nothing stopped two
-- chat threads from naming one SDK transcript — and `resume` would then splice
-- two conversations together. Nothing creates that today; the schema should
-- refuse it anyway, because a fork feature is exactly where it would appear.
DROP INDEX chat_sessions_sdk_id_idx;
CREATE UNIQUE INDEX chat_sessions_sdk_id_key
  ON chat_sessions (org_id, sdk_session_id) WHERE sdk_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- chat_messages — order within a turn, and one row per tool call
-- ---------------------------------------------------------------------------

ALTER TABLE chat_messages
  ADD COLUMN turn_id     uuid,
  ADD COLUMN seq         integer,
  ADD COLUMN tool_use_id text;

CREATE INDEX chat_messages_turn_idx ON chat_messages (session_id, turn_id, seq);

-- One row for a tool call and one for its result. A redelivered or replayed
-- frame must not append a second copy of either.
CREATE UNIQUE INDEX chat_messages_tool_use_key
  ON chat_messages (session_id, tool_use_id, role) WHERE tool_use_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- audit_log is append-only, and now the schema says so
-- ---------------------------------------------------------------------------
-- It is the only table with an updated_at and no set_updated_at trigger. That
-- is correct for an append-only table, but a column that looks like an
-- oversight invites someone to "fix" it by adding the trigger. §2.4: approval
-- decides, the audit log remembers — and a memory that can be edited is not
-- one. DELETE stays permitted so an org cascade does not fail; UPDATE is the
-- tamper vector and is refused.
CREATE FUNCTION audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: row % may not be updated', OLD.id;
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
