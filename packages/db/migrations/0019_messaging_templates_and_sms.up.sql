-- 0019_messaging_templates_and_sms
--
-- DoveSoft's foundation: the templates an Indian SMS (and, later, a WhatsApp
-- message) must be sent from, the link from a message to the template it was
-- rendered from, and what the operator said about delivering it. Every
-- enumerated column is text + CHECK (an enum migration is not reversible —
-- CLAUDE.md §4), and nothing here uses syntax newer than PG 15 (CI's
-- postgres:16 job is the gate).

-- (1) message_templates — the registered words. Under TRAI's TCCCPR 2018 every
--     commercial SMS to an Indian number must be a template registered on DLT:
--     the header (sender id) and the template id are a registered pair, and the
--     text must be the registered body with each {#var#} filled in. A message
--     that is not is scrubbed by the operator and never delivered. So a row is
--     the registration, copied in by a person (by hand, or from the DLT
--     portal's CSV export) — never written by a model.
--
--     The category is the DLT category for SMS and voice, and Meta's for
--     WhatsApp; it decides the sending window (a promotional SMS only between
--     10:00 and 21:00, TRAI's band) and nothing else here.
CREATE TABLE message_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel      text NOT NULL,
  provider     text NOT NULL DEFAULT 'dovesoft',
  -- The DLT content-template id for SMS and voice; Meta's template name for
  -- WhatsApp. Exactly what the provider is told, so it is never rewritten.
  external_id  text NOT NULL,
  -- The DLT header for SMS (six characters, stored upper-case), the WABA
  -- number for WhatsApp, the calling line for voice.
  sender_id    text NOT NULL,
  category     text NOT NULL,
  -- The registered text, {#var#} slots and all.
  body         text NOT NULL,
  -- What the DLT export or the person called it. Optional: the id is the key.
  name         text,
  language     text NOT NULL DEFAULT 'en',
  -- Deactivating is how a template stops being used; a row a sent message
  -- names cannot be deleted (touches' RESTRICT below), and need not be.
  active       boolean NOT NULL DEFAULT true,
  -- SET NULL names its column: a two-column key would otherwise null org_id
  -- too (0018's shape for tasks.created_by). Nullable for an import nobody
  -- signed.
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz,
  CONSTRAINT message_templates_creator_is_in_the_same_org
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by),
  CONSTRAINT message_templates_channel_known CHECK (channel IN ('sms', 'whatsapp', 'voice')),
  CONSTRAINT message_templates_provider_known CHECK (provider IN ('dovesoft')),
  CONSTRAINT message_templates_category_fits_channel CHECK (
    (channel IN ('sms', 'voice')
      AND category IN ('promotional', 'transactional', 'service_implicit', 'service_explicit'))
    OR (channel = 'whatsapp' AND category IN ('marketing', 'utility', 'authentication'))
  ),
  CONSTRAINT message_templates_external_id_shape
    CHECK (btrim(external_id) <> '' AND external_id !~ '\s' AND length(external_id) <= 128),
  -- A DLT header is six characters: letters for transactional and service
  -- headers, digits for promotional ones. Upper-case, so `acmein` and
  -- `ACMEIN` can never be two rows the provider treats as one.
  CONSTRAINT message_templates_sms_sender_is_a_dlt_header
    CHECK (channel <> 'sms' OR sender_id ~ '^[A-Z0-9]{6}$'),
  CONSTRAINT message_templates_sender_is_not_blank
    CHECK (btrim(sender_id) <> '' AND length(sender_id) <= 32),
  CONSTRAINT message_templates_body_is_not_blank
    CHECK (btrim(body) <> '' AND length(body) <= 4000),
  CONSTRAINT message_templates_name_is_bounded
    CHECK (name IS NULL OR (btrim(name) <> '' AND length(name) <= 200)),
  CONSTRAINT message_templates_language_is_bounded
    CHECK (btrim(language) <> '' AND length(language) <= 35),
  -- A re-import of the same export is idempotent on this key.
  CONSTRAINT message_templates_org_channel_external_key UNIQUE (org_id, channel, external_id),
  -- What touches.template_id references: the id, its org AND its channel, so
  -- a message can only name a template of its own org and its own channel —
  -- an SMS rendered from a WhatsApp template is unstorable.
  CONSTRAINT message_templates_id_org_channel_key UNIQUE (id, org_id, channel)
);
CREATE INDEX message_templates_org_active_idx ON message_templates (org_id, channel, active);
CREATE TRIGGER message_templates_set_updated_at BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- (2) touches.template_id — the template a message was rendered from.
--     RESTRICT: the registration a sent message was checked against must
--     outlive the message, or "it matched its template" is a claim with no
--     evidence. MATCH SIMPLE, so a NULL template_id (every email and LinkedIn
--     touch) is not checked against anything.
ALTER TABLE touches ADD COLUMN template_id uuid;
ALTER TABLE touches ADD CONSTRAINT touches_template_is_in_the_same_org_and_channel
  FOREIGN KEY (template_id, org_id, channel) REFERENCES message_templates (id, org_id, channel)
  ON DELETE RESTRICT;
CREATE INDEX touches_template_idx ON touches (template_id) WHERE template_id IS NOT NULL;

-- An outbound SMS or WhatsApp message that can still go out, or went out,
-- names its template. A REFUSED or FAILED one need not: neither status is one
-- `dispatchTouch` will send, and every transition back to one it will
-- (approved, queued, sending, sent) is an UPDATE this CHECK re-evaluates. That
-- escape is what lets the sender settle a pre-0019 row as `no_template`
-- rather than throw on it every tick.
--
-- NOT VALID: enforced for every new and updated row, never re-checked against
-- the rows already stored. Safe because nothing before 0019 could put an
-- outbound sms/whatsapp row in a sendable state that a provider would carry:
-- there was no SMS or WhatsApp provider, enrolment refuses a cold-forbidden
-- campaign whole, `queue_touch` is email and LinkedIn only, and nothing wrote
-- an inbound SMS the inbox could answer. A row that somehow exists is not
-- rejected by this migration; it is refused `no_template` by `decideSend`
-- (§2, "The send path") the first time anything tries to send it.
ALTER TABLE touches ADD CONSTRAINT touches_sms_and_whatsapp_name_a_template CHECK (
  channel NOT IN ('sms', 'whatsapp')
  OR direction <> 'out'
  OR template_id IS NOT NULL
  OR status IN ('refused', 'failed')
) NOT VALID;

-- (3) Delivery — what the operator said about an SMS after the provider
--     accepted it (a DLR). Three columns BESIDE `status`, never in it:
--     `status` stays the send path's word ('sent' means the provider took
--     it), which every reader of it — the daily cap, enrolment's duplicate
--     guard, the compliance page's WENT_OUT_STATUSES, erasure's — already
--     reads correctly. A DELIVRD report therefore does NOT move `status` to
--     'delivered': both readers that list 'delivered' list 'sent' too, so
--     nothing would read differently, and a status a second writer can
--     change is a status the sender's own predicates (`sending` → `sent`,
--     the stuck-send recovery) would have to arbitrate against.
--
--     pending   the operator has it and has not finished;
--     delivered the handset has it (`delivered_at` is the report's time);
--     failed    it will not arrive (`delivery_error` is the report's reason,
--               the evidence, bounded — never the message body).
--
--     Outbound only. A failed delivery is evidence about a NUMBER on one
--     attempt, not a person asking to be left alone: it is never a
--     suppression (as a bounce is not, 0018).
ALTER TABLE touches ADD COLUMN delivery_status text;
ALTER TABLE touches ADD COLUMN delivered_at timestamptz;
ALTER TABLE touches ADD COLUMN delivery_error text;
ALTER TABLE touches ADD CONSTRAINT touches_delivery_status_known
  CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'delivered', 'failed'));
ALTER TABLE touches ADD CONSTRAINT touches_delivery_is_outbound_only
  CHECK (delivery_status IS NULL OR direction = 'out');
-- IS NOT DISTINCT FROM, not =: a CHECK passes on NULL, so `(delivery_status =
-- 'delivered') = (delivered_at IS NOT NULL)` would accept a delivered_at with
-- no status at all.
ALTER TABLE touches ADD CONSTRAINT touches_delivered_has_its_time
  CHECK ((delivery_status IS NOT DISTINCT FROM 'delivered') = (delivered_at IS NOT NULL));
ALTER TABLE touches ADD CONSTRAINT touches_delivery_failure_has_its_reason
  CHECK ((delivery_status IS NOT DISTINCT FROM 'failed') = (delivery_error IS NOT NULL));
ALTER TABLE touches ADD CONSTRAINT touches_delivery_error_is_bounded
  CHECK (delivery_error IS NULL OR (btrim(delivery_error) <> '' AND length(delivery_error) <= 300));

-- (4) One inbound SMS, one row. A provider retries a webhook it did not see
--     answered, and the message id is the same each time; `recordInboundSms`
--     reads for it first, and this index is what decides the race between two
--     deliveries that both read "not seen". Partial and SMS-only: no inbound
--     SMS row existed before 0019, so it cannot fail on stored data, and
--     inbound email keeps its own (read-only) dedup as it was.
CREATE UNIQUE INDEX touches_inbound_sms_provider_id_key ON touches (provider_id)
  WHERE direction = 'in' AND channel = 'sms' AND provider_id IS NOT NULL;

-- (5) A bounce code IS an RFC 3463 status. 0018's `contacts_bounce_has_code`
--     pairs the two columns' NULLs and nothing more, so a script or a hand
--     UPDATE could store `email_bounce_code = 'bounced'` — a mark whose
--     evidence is not a status code. The one writer, `outreachRecordBounce`,
--     has refused anything but `^[45]\.\d{1,3}\.\d{1,3}$` since 0018 shipped,
--     so no stored row can fail this. Found by review.
ALTER TABLE contacts ADD CONSTRAINT contacts_bounce_code_is_rfc3463
  CHECK (email_bounce_code IS NULL OR email_bounce_code ~ '^[45]\.[0-9]{1,3}\.[0-9]{1,3}$');
