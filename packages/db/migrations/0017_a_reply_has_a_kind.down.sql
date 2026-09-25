DROP INDEX IF EXISTS touches_org_reply_kind_idx;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_reply_kind_is_inbound_only;
ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_reply_kind_is_known;
ALTER TABLE touches DROP COLUMN IF EXISTS reply_kind;
