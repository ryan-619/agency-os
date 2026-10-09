-- 0024: follow-up sequences.
--
-- Enrolment writes one opener per person (§2, "The send path"), and nothing
-- followed it: a business that did not answer the first email heard nothing
-- again unless somebody remembered. A campaign now carries STEPS after its
-- opener — another message on its own channel, a call or a visit — each a
-- number of days after the step before, and every person a campaign wrote to
-- carries a RUN through those steps that stops the moment they reply.
--
-- A step's message is a draft like every other: awaiting a person on
-- /approvals, or queued where the campaign auto-sends, and judged by the one
-- send path at the moment of sending. A call or a visit is a task a person
-- carries out; nothing here places a call.

-- A step names its campaign in the same org, and a run its campaign, its
-- person and the message it waits on, so each needs the pair to point at.
ALTER TABLE campaigns ADD CONSTRAINT campaigns_id_org_key UNIQUE (id, org_id);
ALTER TABLE touches ADD CONSTRAINT touches_id_org_key UNIQUE (id, org_id);

CREATE TABLE campaign_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  -- The opener is step 1, written by enrolment; these are 2 onwards.
  position smallint NOT NULL,
  kind text NOT NULL,
  -- Days after the step before: after its message was SENT, or its task made.
  after_days smallint NOT NULL,
  -- A message's words, with {first_name}, {company} and {agency} filled in when it is drafted.
  subject text,
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT campaign_steps_campaign_in_org FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns (id, org_id) ON DELETE CASCADE,
  CONSTRAINT campaign_steps_position_key UNIQUE (campaign_id, position),
  CONSTRAINT campaign_steps_position_is_after_the_opener CHECK (position BETWEEN 2 AND 10),
  CONSTRAINT campaign_steps_kind_check CHECK (kind IN ('message', 'call', 'visit')),
  CONSTRAINT campaign_steps_after_days_range CHECK (after_days BETWEEN 1 AND 90),
  -- A message has words and only a message does; a subject is a message's.
  CONSTRAINT campaign_steps_message_has_words CHECK ((kind = 'message') = (body IS NOT NULL)),
  CONSTRAINT campaign_steps_subject_is_a_message_s CHECK (kind = 'message' OR subject IS NULL),
  CONSTRAINT campaign_steps_body_is_bounded CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 4000),
  CONSTRAINT campaign_steps_subject_is_bounded CHECK (subject IS NULL OR length(btrim(subject)) BETWEEN 1 AND 200)
);

CREATE TABLE sequence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  -- When the opener went: a reply after this — before the run existed included — stops it.
  started_at timestamptz NOT NULL,
  -- The step to take next; past the campaign's last step the run is finished.
  next_position smallint NOT NULL DEFAULT 2,
  -- When the step before was taken: the moment its message was sent, or its task made.
  anchor_at timestamptz NOT NULL,
  -- A message step drafted and not yet sent: the clock waits for it.
  waiting_touch_id uuid,
  stopped_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT sequence_runs_campaign_in_org FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns (id, org_id) ON DELETE CASCADE,
  CONSTRAINT sequence_runs_contact_in_org FOREIGN KEY (contact_id, org_id) REFERENCES contacts (id, org_id) ON DELETE CASCADE,
  CONSTRAINT sequence_runs_waiting_touch_in_org
    FOREIGN KEY (waiting_touch_id, org_id) REFERENCES touches (id, org_id) ON DELETE SET NULL (waiting_touch_id),
  -- One run per person per campaign: a person is written to once by a campaign's sequence.
  CONSTRAINT sequence_runs_campaign_contact_key UNIQUE (campaign_id, contact_id),
  CONSTRAINT sequence_runs_next_position_range CHECK (next_position BETWEEN 2 AND 11),
  CONSTRAINT sequence_runs_stop_reason_check
    CHECK (stop_reason IN ('replied', 'paused', 'refused', 'deal_closed', 'campaign_ended', 'finished')),
  -- A stopped run says why, and only a stopped run does.
  CONSTRAINT sequence_runs_stopped_has_its_reason CHECK ((stopped_at IS NULL) = (stop_reason IS NULL)),
  -- A stopped run waits on nothing, and no step comes before the opener.
  CONSTRAINT sequence_runs_stopped_waits_on_nothing CHECK (stopped_at IS NULL OR waiting_touch_id IS NULL),
  CONSTRAINT sequence_runs_anchor_not_before_start CHECK (anchor_at >= started_at)
);

-- The advancer reads the live runs.
CREATE INDEX sequence_runs_live_idx ON sequence_runs (org_id, anchor_at) WHERE stopped_at IS NULL;
