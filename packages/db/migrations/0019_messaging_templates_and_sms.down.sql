-- Revert 0019_messaging_templates_and_sms.
-- DATA LOSS, stated: every message template is DELETED with its table, every
-- touch loses the link to the template it was rendered from, and every SMS
-- delivery report (status, time, reason) is lost. Inbound SMS rows stay —
-- they are ordinary inbound touches — and only their uniqueness index goes.
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
