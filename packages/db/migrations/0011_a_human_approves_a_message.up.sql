-- 0011_a_human_approves_a_message — who said a draft could go, and what came back.
--
-- PROMPT.md §2.4: anything that leaves the building goes through an approval
-- queue unless the campaign has auto-send. Phase 2's `approvals` table is the
-- gate for TOOL CALLS — it is keyed by tool_use_id and turn_id, and
-- `approvals_agent_request_is_traceable` insists on both. A message draft is a
-- different thing: a `touches` row that a person reads and answers, possibly
-- days after the agent wrote it, with no turn left to trace it to.
--
-- So the touch is its own approval record. The same rule 0004 applied to
-- `approvals` applies here: a row may not claim a person approved it without
-- naming the person and the moment. A message that went out "approved" with
-- nobody's name on it is exactly the audit gap §2.4 exists to close.
--
-- Auto-send is the one path that sends WITHOUT a person, and it never passes
-- through 'approved' — it goes 'queued' → 'sent' — so the constraint below is
-- about the status a human produces and nothing else.

ALTER TABLE touches
  ADD COLUMN approved_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN approved_at   timestamptz,
  -- What the approver said, if anything. A denial's reason lives here too:
  -- a draft denied with no note is one the agent will rewrite the same way.
  ADD COLUMN decision_note text;

-- RESTRICT, matching approvals.decided_by: a person who approved a message that
-- was then sent must stay identifiable for as long as the record of the
-- message does.

ALTER TABLE touches ADD CONSTRAINT touches_approved_has_approver
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL));

-- 'sending' is the worker's claim on a row between picking it up and hearing
-- back from the provider. A status rather than a marker in another column, so
-- two workers picking the same row produce one UPDATE that matches and one
-- that matches nothing — and so a worker that died mid-send leaves a row that
-- SAYS so, for the reconciler to find.
ALTER TABLE touches DROP CONSTRAINT touches_status_check;
ALTER TABLE touches ADD CONSTRAINT touches_status_check
  CHECK (status IN ('queued', 'awaiting_approval', 'approved', 'sending', 'sent',
                    'delivered', 'bounced', 'replied', 'failed', 'refused'));

-- The two columns move together, or not at all.
ALTER TABLE touches ADD CONSTRAINT touches_approver_and_time_agree
  CHECK ((approved_by IS NULL) = (approved_at IS NULL));

-- ---------------------------------------------------------------------------
-- Tying a reply to what it answers
-- ---------------------------------------------------------------------------
--
-- §8.4: reply detection "flips the deal to `replied` and pauses the sequence
-- for that contact immediately". Knowing WHICH message was answered is what
-- makes the reply attributable to a campaign — and it is what lets an inbound
-- message be matched by the RFC 5322 In-Reply-To header, against the
-- Message-ID the provider assigned, rather than by the sender's address alone.
-- Address matching is ambiguous the moment one person is in two campaigns.
--
-- SET NULL: the reply outlives the message it answered, as every touch
-- outlives the things it points at.

ALTER TABLE touches
  ADD COLUMN in_reply_to uuid REFERENCES touches(id) ON DELETE SET NULL;

-- Only an inbound message answers something.
ALTER TABLE touches ADD CONSTRAINT touches_only_inbound_replies
  CHECK (in_reply_to IS NULL OR direction = 'in');

-- The sender looks up an outbound message by the Message-ID the provider gave
-- it, once per inbound message. Partial, because the column is null on every
-- refusal and every draft.
CREATE INDEX touches_provider_id_idx ON touches (org_id, provider_id)
  WHERE provider_id IS NOT NULL AND direction = 'out';

-- The worker's tick asks "what is approved or queued and due?" on a schedule,
-- across every org. The existing (campaign_id, status, scheduled_for) index
-- serves a campaign's view of itself, not a sender's view of everything.
CREATE INDEX touches_due_idx ON touches (status, scheduled_for)
  WHERE direction = 'out' AND status IN ('approved', 'queued');
