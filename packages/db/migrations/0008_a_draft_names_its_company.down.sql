-- Revert 0008_a_draft_names_its_company.

ALTER TABLE touches DROP CONSTRAINT IF EXISTS touches_names_a_subject;
DROP INDEX IF EXISTS touches_company_idx;
ALTER TABLE touches DROP COLUMN IF EXISTS company_id;
