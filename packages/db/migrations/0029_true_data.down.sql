-- Revert 0029_true_data.
-- DATA LOSS, stated: where every contact's email and phone came from is
-- DELETED with its column, so a page the address was seen on, or the
-- connector that returned it, is no longer known anywhere — the addresses
-- themselves stay. Every connector's last refusal (when, and whether it was a
-- key or a quota) is deleted too; `last_ok_at` and `last_error`, Test
-- connection's, predate 0029 and stay. Code before 0029 reads none of them.
ALTER TABLE connectors
  DROP CONSTRAINT connectors_failure_has_its_time,
  DROP CONSTRAINT connectors_failure_kind_is_known,
  DROP COLUMN last_failure_kind,
  DROP COLUMN last_failure_at;

ALTER TABLE contacts
  DROP CONSTRAINT contacts_phone_source_needs_a_phone,
  DROP CONSTRAINT contacts_email_source_needs_an_email,
  DROP CONSTRAINT contacts_phone_source_is_known,
  DROP CONSTRAINT contacts_email_source_is_known,
  DROP COLUMN phone_source,
  DROP COLUMN email_source;
