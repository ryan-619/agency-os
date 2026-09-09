-- 0004_outreach — campaigns, the single log of every message, calls, approvals.

CREATE TABLE campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name           text NOT NULL,
  icp_profile_id uuid REFERENCES icp_profiles(id) ON DELETE SET NULL,
  channel        text NOT NULL CHECK (channel IN ('email', 'linkedin', 'sms', 'voice', 'whatsapp')),
  -- Default OFF. Auto-send is a per-campaign opt-in a human must make (§2.4).
  auto_send      boolean NOT NULL DEFAULT false,
  daily_cap      integer NOT NULL DEFAULT 25 CHECK (daily_cap > 0),
  -- Quiet hours are stored as local wall-clock times and evaluated in the
  -- RECIPIENT's timezone at send time (§2.1), never the sender's.
  quiet_start    time NOT NULL DEFAULT '21:00',
  quiet_end      time NOT NULL DEFAULT '08:00',
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'active', 'paused', 'done')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,

  -- Cold outreach is email and LinkedIn only. A campaign cannot even be
  -- created on a cold-capable voice/SMS channel with auto_send on; the send
  -- path enforces per-contact consent as well (§2.1, §12).
  CONSTRAINT campaigns_no_auto_send_on_voice_or_sms
    CHECK (NOT auto_send OR channel IN ('email', 'linkedin'))
);

CREATE UNIQUE INDEX campaigns_org_name_key ON campaigns (org_id, name);
CREATE INDEX campaigns_org_status_idx ON campaigns (org_id, status);
CREATE TRIGGER campaigns_set_updated_at BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- touches — the single log of every message in either direction (§4).
-- ---------------------------------------------------------------------------
CREATE TABLE touches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'linkedin', 'sms', 'voice', 'whatsapp')),
  direction     text NOT NULL CHECK (direction IN ('out', 'in')),
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'awaiting_approval', 'approved', 'sent',
                                    'delivered', 'bounced', 'replied', 'failed')),
  subject       text,
  body          text,
  provider_id   text,
  scheduled_for timestamptz,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

CREATE INDEX touches_campaign_status_scheduled_idx
  ON touches (campaign_id, status, scheduled_for);
CREATE INDEX touches_contact_idx ON touches (contact_id, created_at DESC);
-- Daily-cap counting: sent outbound touches per org per day.
CREATE INDEX touches_org_sent_idx ON touches (org_id, sent_at)
  WHERE direction = 'out' AND sent_at IS NOT NULL;
CREATE TRIGGER touches_set_updated_at BEFORE UPDATE ON touches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- calls — inbound and opted-in only. Enforced in the dial path, not the UI (§8.5).
-- ---------------------------------------------------------------------------
CREATE TABLE calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  direction         text NOT NULL CHECK (direction IN ('out', 'in')),
  provider_call_sid text,
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_s        integer CHECK (duration_s IS NULL OR duration_s >= 0),
  recording_url     text,
  transcript        jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary           text,
  outcome           text,
  sentiment         text,
  handoff_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);

CREATE UNIQUE INDEX calls_provider_sid_key ON calls (provider_call_sid)
  WHERE provider_call_sid IS NOT NULL;
CREATE INDEX calls_contact_idx ON calls (contact_id, started_at DESC);
CREATE TRIGGER calls_set_updated_at BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- approvals — the human-in-the-loop gate the agent's canUseTool blocks on (§5.4).
-- requested_by is a users.id or the literal 'agent', so it is text, not a FK.
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  tool_name    text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk         text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz,

  -- A decided approval must record who decided it and when. A row cannot claim
  -- a human approved something without naming the human.
  CONSTRAINT approvals_decided_has_decider
    CHECK (status IN ('pending', 'expired')
           OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE INDEX approvals_org_status_idx ON approvals (org_id, status);
CREATE INDEX approvals_pending_expiry_idx ON approvals (expires_at)
  WHERE status = 'pending';
CREATE TRIGGER approvals_set_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
