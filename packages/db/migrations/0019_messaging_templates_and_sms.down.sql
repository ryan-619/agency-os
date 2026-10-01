-- Revert 0019_messaging_templates_and_sms.
-- DATA LOSS, stated: every message template is DELETED with its table, every
-- touch loses the link to the template it was rendered from, and every SMS
-- delivery report (status, time, reason) is lost. Inbound SMS rows stay —
-- they are ordinary inbound touches — and only their uniqueness index goes.
--
-- An SMS or WhatsApp message that could still go out is SETTLED first,
-- because it is about to lose the link to the template it was checked
-- against, and no code before 0019 has a provider to send it with. Left in
-- place, a re-apply of 0019 would add back a CHECK that binds those statuses
-- with template_id NULL, and every later UPDATE of such a row — deleting its
-- contact included (ON DELETE SET NULL) — would fail. Review round 4, [11].
UPDATE touches
   SET status = 'refused', refusal_code = 'no_template',
       error = 'Migration 0019 was reverted, which removed the link to this message''s registered template. Nothing was sent; draft it again.'
 WHERE direction = 'out' AND channel IN ('sms', 'whatsapp')
   AND status IN ('awaiting_approval', 'approved', 'queued');
UPDATE touches
   SET status = 'failed',
       error = 'Migration 0019 was reverted while this message was being sent; it may or may not have gone. Check the DoveSoft console before drafting it again.'
 WHERE direction = 'out' AND channel IN ('sms', 'whatsapp') AND status = 'sending';
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_bounce_code_is_rfc3463;
DROP INDEX IF EXISTS touches_inbound_sms_provider_id_key;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_delivery_error_is_bounded;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_delivery_failure_has_its_reason;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_delivered_has_its_time;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_delivery_is_outbound_only;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_delivery_status_known;
ALTER TABLE touches DROP COLUMN IF EXISTS delivery_error;
ALTER TABLE touches DROP COLUMN IF EXISTS delivered_at;
ALTER TABLE touches DROP COLUMN IF EXISTS delivery_status;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_sms_and_whatsapp_name_a_template;
DROP INDEX IF EXISTS touches_template_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_template_is_in_the_same_org_and_channel;
ALTER TABLE touches DROP COLUMN IF EXISTS template_id;
DROP TRIGGER IF EXISTS message_templates_set_updated_at ON message_templates;
DROP TABLE IF EXISTS message_templates;
