-- Reverting 0024 deletes every campaign's follow-up steps and every run through
-- them; the messages and tasks the runs made stay, as any draft or task does.
DROP TABLE sequence_runs;
DROP TABLE campaign_steps;
ALTER TABLE touches DROP CONSTRAINT touches_id_org_key;
ALTER TABLE campaigns DROP CONSTRAINT campaigns_id_org_key;
