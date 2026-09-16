-- 0014_calls — down. Back to 0004's column list.
DROP INDEX IF EXISTS calls_company_idx;
DROP INDEX IF EXISTS calls_org_started_idx;

ALTER TABLE calls
  DROP CONSTRAINT IF EXISTS calls_outbound_names_its_touch,
  DROP CONSTRAINT IF EXISTS calls_ended_after_started,
  DROP CONSTRAINT IF EXISTS calls_sentiment_known,
  DROP CONSTRAINT IF EXISTS calls_outcome_known,
  DROP CONSTRAINT IF EXISTS calls_status_known;

ALTER TABLE calls
  DROP COLUMN IF EXISTS touch_id,
  DROP COLUMN IF EXISTS opted_out_at,
  DROP COLUMN IF EXISTS disclosed_ai_at,
  DROP COLUMN IF EXISTS handoff_reason,
  DROP COLUMN IF EXISTS answered_at,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS to_number,
  DROP COLUMN IF EXISTS from_number,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS company_id;
