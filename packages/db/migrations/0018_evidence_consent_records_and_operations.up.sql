-- 0018_evidence_consent_records_and_operations
--
-- The twelve facts this revision needs the schema to hold, each earned by a
-- feature and by a §2 rule. Every enumerated column is text + CHECK (an enum
-- migration is not reversible — CLAUDE.md §4).

-- (0) The (id, org_id) keys the same-org foreign keys below hang off. A
--     plain FK to users(id) or contacts(id) lets a row in one org name a
--     person in another: a reply "handled by" a stranger, a note about
--     somebody else's contact, a task done by a user who was never in the
--     org. 0006 gave scans this shape for findings and scores; users and
--     contacts get it here, and every user- or contact-valued column this
--     migration adds references the PAIR, so the database refuses the
--     cross-org row instead of a route remembering to check.
ALTER TABLE users ADD CONSTRAINT users_id_org_key UNIQUE (id, org_id);
ALTER TABLE contacts ADD CONSTRAINT contacts_id_org_key UNIQUE (id, org_id);

-- (1) findings.scored — §2.2. The scanner now records observations that are
--     NOT in the ICP (informational signals). A row that is not scored carries
--     no weight, by CHECK, so no reader can mistake "also observed" for "a gap
--     that counts". Existing rows default TRUE: everything stored so far was
--     an ICP key.
ALTER TABLE findings ADD COLUMN scored boolean NOT NULL DEFAULT true;
ALTER TABLE findings ADD CONSTRAINT findings_informational_carries_no_weight
  CHECK (scored OR weight = 0);
CREATE INDEX findings_company_informational_idx ON findings (company_id) WHERE NOT scored;

-- (2) touches.handled_at / handled_by — a person read a reply and dealt with
--     it. NULL is "nobody has". Only an INBOUND row can be handled, and a
--     handled row names who (RESTRICT, like approvals.decided_by: the person
--     stays identifiable as long as the record does — users are revoked,
--     never deleted).
ALTER TABLE touches ADD COLUMN handled_at timestamptz;
ALTER TABLE touches ADD COLUMN handled_by uuid;
ALTER TABLE touches ADD CONSTRAINT touches_handled_by_is_in_the_same_org
  FOREIGN KEY (handled_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT;
ALTER TABLE touches ADD CONSTRAINT touches_handled_is_inbound_only
  CHECK (handled_at IS NULL OR direction = 'in');
ALTER TABLE touches ADD CONSTRAINT touches_handled_has_who
  CHECK ((handled_at IS NULL) = (handled_by IS NULL));
CREATE INDEX touches_org_inbox_idx ON touches (org_id, created_at DESC)
  WHERE direction = 'in' AND handled_at IS NULL;

-- (3) touches.answers_touch_id — an OUTBOUND draft that answers a specific
--     inbound message, so the worker can thread it (In-Reply-To/References
--     from the parent's provider_id) and the inbox can show "answered".
--     0011 makes in_reply_to inbound-only, so this column is earned. SET
--     NULL: deleting the reply must not delete the answer.
ALTER TABLE touches ADD COLUMN answers_touch_id uuid REFERENCES touches(id) ON DELETE SET NULL;
ALTER TABLE touches ADD CONSTRAINT touches_answer_is_outbound
  CHECK (answers_touch_id IS NULL OR direction = 'out');
CREATE INDEX touches_answers_idx ON touches (answers_touch_id) WHERE answers_touch_id IS NOT NULL;

-- The FK above only says the parent EXISTS. `dispatchTouch` reads the
-- parent's provider_id into In-Reply-To, so a parent in another org, or
-- an outbound row, would thread this org's message into a conversation
-- that is not its own. The trigger closes both — a CHECK cannot see
-- another row — and fires on UPDATE too, so an honest row cannot be
-- re-pointed afterwards.
CREATE FUNCTION touches_refuse_an_answer_outside_its_conversation() RETURNS trigger AS $$
DECLARE
  parent_direction text;
  parent_org uuid;
BEGIN
  SELECT direction, org_id INTO parent_direction, parent_org
    FROM touches WHERE id = NEW.answers_touch_id;
  IF parent_direction IS DISTINCT FROM 'in' OR parent_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION
      'touches_answer_names_an_inbound_row_in_the_same_org: touch % answers %, which is not an inbound row in its org',
      NEW.id, NEW.answers_touch_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touches_answer_names_an_inbound_row_in_the_same_org
  BEFORE INSERT OR UPDATE ON touches
  FOR EACH ROW WHEN (NEW.answers_touch_id IS NOT NULL)
  EXECUTE FUNCTION touches_refuse_an_answer_outside_its_conversation();

-- (4) suppressions.source — §2.1. WHICH path recorded the opt-out is a fact an
--     auditor asks for. NULLABLE like 0017's reply_kind: rows written before
--     this migration were not tracked, and inventing 'manual' for them would
--     be a claim. Five values, each with a writer in this change (the
--     suppressions route, recordInboundReply, recordOptOut, the one-click
--     unsubscribe, erasure); a value nothing writes is not listed.
ALTER TABLE suppressions ADD COLUMN source text;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_source_is_known CHECK (
  source IS NULL OR source IN ('manual', 'reply', 'voice', 'unsubscribe', 'erasure')
);

-- (5) users.revoked_at — 0004's own comment: "offboarding is a role change,
--     not a row deletion". approvals.decided_by, touches.approved_by and
--     touches.handled_by are RESTRICT; audit_log.actor is text;
--     chat_messages.cost_usd is per person. A revoked user keeps every row
--     and can no longer sign in or run a turn.
ALTER TABLE users ADD COLUMN revoked_at timestamptz;

-- (6) connectors.name <> 'agency' — the in-process server is spread LAST at
--     runtime, so a connector by that name is silently displaced and its
--     tools classified as agency tools. NOT VALID: enforced for new and
--     updated rows, never fails on an existing one.
ALTER TABLE connectors ADD CONSTRAINT connectors_name_is_not_agency
  CHECK (name <> 'agency') NOT VALID;

-- (7) contacts.email_bounced_at / email_bounce_code — a permanent bounce is
--     evidence about an ADDRESS, not a person asking to be left alone, so it
--     is a column and a refusal and never a suppression row. The code is the
--     DSN's own RFC 3463 status, stored as the evidence for the mark.
ALTER TABLE contacts ADD COLUMN email_bounced_at timestamptz;
ALTER TABLE contacts ADD COLUMN email_bounce_code text;
ALTER TABLE contacts ADD CONSTRAINT contacts_bounce_has_code
  CHECK ((email_bounced_at IS NULL) = (email_bounce_code IS NULL));

-- (8) meetings.outcome — what happened is the one fact a pipeline learns from
--     a meeting. NULL = not yet recorded; cancellation stays cancelled_at.
ALTER TABLE meetings ADD COLUMN outcome text;
ALTER TABLE meetings ADD CONSTRAINT meetings_outcome_known
  CHECK (outcome IS NULL OR outcome IN ('held', 'no_show', 'rescheduled'));

-- (9) notes — a teammate's words about a company (optionally about one of its
--     contacts), kept apart from evidence: nothing that writes a proposal or
--     a brief may read this table (packages/core/test asserts it by source).
CREATE TABLE notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id     uuid,
  author_user_id uuid NOT NULL,
  body           text NOT NULL,
  pinned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  -- Same-org foreign keys (see (0)): a note about another org's contact, or
  -- by another org's user, is unstorable.
  CONSTRAINT notes_contact_is_in_the_same_org
    FOREIGN KEY (contact_id, org_id) REFERENCES contacts (id, org_id) ON DELETE CASCADE,
  CONSTRAINT notes_author_is_in_the_same_org
    FOREIGN KEY (author_user_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT notes_body_is_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT notes_body_is_bounded  CHECK (length(body) <= 8000)
);
CREATE INDEX notes_company_idx ON notes (company_id, pinned DESC, created_at DESC);
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- (10) tasks — where LinkedIn steps, kickoff checklists, renewal reminders and
--      plain to-dos land. done_by is RESTRICT (a done task names a person
--      who stays identifiable); assignee and creator are SET NULL (an
--      unassigned task is a normal state; the agent creates tasks and has no
--      users row, so created_by is nullable and the audit row names the
--      actor). One OPEN task per touch: two callers materialising one
--      LinkedIn draft produce one task and the loser re-reads.
CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id       uuid REFERENCES companies(id) ON DELETE CASCADE,
  deal_id          uuid REFERENCES deals(id) ON DELETE SET NULL,
  touch_id         uuid REFERENCES touches(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'todo',
  title            text NOT NULL,
  detail           text,
  assignee_user_id uuid,
  created_by       uuid,
  due_at           timestamptz,
  done_at          timestamptz,
  done_by          uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  -- Same-org foreign keys (see (0)). SET NULL names its column: a two-column
  -- key would otherwise null org_id too, which is NOT NULL and would turn a
  -- user's offboarding into a failed delete.
  CONSTRAINT tasks_assignee_is_in_the_same_org
    FOREIGN KEY (assignee_user_id, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (assignee_user_id),
  CONSTRAINT tasks_creator_is_in_the_same_org
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by),
  CONSTRAINT tasks_done_by_is_in_the_same_org
    FOREIGN KEY (done_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT tasks_kind_known CHECK (kind IN ('todo', 'linkedin_send', 'kickoff', 'renewal')),
  CONSTRAINT tasks_title_is_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT tasks_title_is_bounded CHECK (length(title) <= 200),
  CONSTRAINT tasks_done_has_who CHECK ((done_at IS NULL) = (done_by IS NULL)),
  CONSTRAINT tasks_linkedin_send_names_touch CHECK (kind <> 'linkedin_send' OR touch_id IS NOT NULL)
);
CREATE INDEX tasks_org_open_idx ON tasks (org_id, due_at) WHERE done_at IS NULL;
CREATE INDEX tasks_company_idx ON tasks (company_id) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_one_open_per_touch ON tasks (touch_id)
  WHERE touch_id IS NOT NULL AND done_at IS NULL;
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- (11) proposal_shares — a buyer link. The token is a bearer credential and
--      ONLY its sha256 is stored (the CHECK makes a raw token unstorable). A
--      view is a count and two instants, never an IP or a user agent. An
--      acceptance names the person who typed their name — never a session,
--      because the buyer has none.
CREATE TABLE proposal_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  proposal_id      uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  token_hash       text NOT NULL,
  created_by       uuid NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  view_count       integer NOT NULL DEFAULT 0,
  first_viewed_at  timestamptz,
  last_viewed_at   timestamptz,
  accepted_at      timestamptz,
  accepted_by_name text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  CONSTRAINT proposal_shares_creator_is_in_the_same_org
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_shares_token_hash_key UNIQUE (token_hash),
  CONSTRAINT proposal_shares_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT proposal_shares_accepted_has_name CHECK ((accepted_at IS NULL) = (accepted_by_name IS NULL)),
  CONSTRAINT proposal_shares_accepted_name_not_blank CHECK (accepted_by_name IS NULL OR btrim(accepted_by_name) <> ''),
  CONSTRAINT proposal_shares_expires_after_created CHECK (expires_at > created_at)
);
CREATE INDEX proposal_shares_proposal_idx ON proposal_shares (proposal_id, created_at DESC);
CREATE TRIGGER proposal_shares_set_updated_at BEFORE UPDATE ON proposal_shares
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- (12) worker_heartbeats — §2.4. A worker that scaled to zero leaves
--      approvals landing on nothing and "nothing looks broken". A SYSTEM
--      table (no org_id, like the auth tables): the worker serves every org
--      — dueTouches and the reconciler are cross-org — so "the org's worker"
--      is not a concept and a per-org row would be N upserts per tick. One
--      row per worker instance, upserted every tick; the web reads the
--      newest. The CHECK keeps the two instants honest about each other.
CREATE TABLE worker_heartbeats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     text NOT NULL,
  booted_at     timestamptz NOT NULL,
  last_tick_at  timestamptz NOT NULL,
  outreach      text NOT NULL,
  chat          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  CONSTRAINT worker_heartbeats_worker_key UNIQUE (worker_id),
  CONSTRAINT worker_heartbeats_outreach_known
    CHECK (outreach IN ('disabled', 'send-only', 'send-and-receive', 'receive-only')),
  CONSTRAINT worker_heartbeats_chat_known CHECK (chat IN ('enabled', 'disabled')),
  CONSTRAINT worker_heartbeats_beat_after_boot CHECK (last_tick_at >= booted_at)
);
CREATE TRIGGER worker_heartbeats_set_updated_at BEFORE UPDATE ON worker_heartbeats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
