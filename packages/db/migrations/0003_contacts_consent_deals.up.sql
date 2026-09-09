-- 0003_contacts_consent_deals — people, permission to contact them, and the deal.
--
-- Outreach compliance (PROMPT.md §2.1) is enforced structurally here:
--   * consents has UNIQUE (contact_id, channel) and no default row is ever created.
--     Absence of a row means NO. There is no "unknown" state to misread as consent.
--   * sms and voice consent are separate rows, each with its own source and
--     recorded_at, so one cannot imply the other.
--   * suppressions is org-scoped and uniquely keyed, so the send path can do a
--     single indexed lookup per address, number and domain.

CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name   text,
  last_name    text,
  title        text,
  email        text,
  phone        text,
  linkedin_url text,
  source       text NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('apollo', 'manual', 'import', 'agent', 'inbound')),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

CREATE INDEX contacts_company_idx ON contacts (company_id);
-- Partial unique index: many contacts may have no email, but an email that is
-- present must identify exactly one contact within the org.
CREATE UNIQUE INDEX contacts_org_email_key ON contacts (org_id, lower(email))
  WHERE email IS NOT NULL;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- consents — one row per channel per contact. Absence means NO (§4).
-- ---------------------------------------------------------------------------
CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- CASCADE is deliberate, and is the safe direction: consent is meaningful
  -- only in relation to a contact, and the send path looks it up BY contact.
  -- If the contact is deleted and later re-imported, the new row has no
  -- consent — which correctly reads as NO. An orphaned consent row would be
  -- unreachable evidence that something was once permitted; audit_log, which
  -- has no FK to contacts, is what survives as the record.
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'voice', 'whatsapp')),
  granted     boolean NOT NULL,
  -- Where the consent came from: the form, the reply, the call recording.
  -- A granted consent with no source is not evidence of anything.
  source      text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

CREATE UNIQUE INDEX consents_contact_channel_key ON consents (contact_id, channel);
CREATE TRIGGER consents_set_updated_at BEFORE UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- suppressions — wins over everything. One row here and no channel may ever
-- contact that address, number or domain again (§2.1). Checked in the send path.
-- `value` is stored already normalised (lower-cased, phone in E.164) by
-- packages/core; the index is a plain equality index on that normalised form.
-- ---------------------------------------------------------------------------
CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email', 'domain', 'phone')),
  value      text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE UNIQUE INDEX suppressions_org_kind_value_key ON suppressions (org_id, kind, value);
CREATE TRIGGER suppressions_set_updated_at BEFORE UPDATE ON suppressions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- deals
-- ---------------------------------------------------------------------------
CREATE TABLE deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage          text NOT NULL DEFAULT 'new'
                   CHECK (stage IN ('new', 'contacted', 'replied', 'meeting',
                                    'proposal', 'won', 'lost')),
  value_cents    bigint,
  currency       text NOT NULL DEFAULT 'USD',
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  next_action    text,
  next_action_at timestamptz,
  closed_at      timestamptz,
  lost_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

CREATE INDEX deals_org_stage_idx ON deals (org_id, stage);
CREATE INDEX deals_company_idx ON deals (company_id);
CREATE INDEX deals_next_action_idx ON deals (org_id, next_action_at)
  WHERE next_action_at IS NOT NULL;
CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
