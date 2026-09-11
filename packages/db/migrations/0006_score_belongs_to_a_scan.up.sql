-- 0006_score_belongs_to_a_scan — tie a score to the observations it came from.
--
-- `scores` recorded a company and a time and nothing else, so "the latest
-- score" and "the latest scan" were two independent lookups. A scan that fails
-- to write its score, a re-scan racing a page load, or simply two writers, and
-- the company page shows one scan's number above another scan's findings —
-- a score nobody computed from the evidence beside it. PROMPT.md §2.2 is that
-- a finding must carry the evidence that produced it; a score is a claim about
-- findings and needs the same link.
--
-- The composite FK is the same shape `findings` uses: it makes the denormalised
-- company_id and org_id agree with the scan's by construction, so a batch
-- writer with an off-by-one cannot file one company's score against another's
-- scan and still satisfy every constraint.

ALTER TABLE scores ADD COLUMN scan_id uuid;

-- Backfill: the scan a score was computed from is the most recent one for that
-- company at or before the score's own timestamp. recordScan writes both in one
-- transaction, so now() is identical for the pair and this is exact for every
-- row this application wrote.
UPDATE scores s
   SET scan_id = (
     SELECT sc.id FROM scans sc
      WHERE sc.company_id = s.company_id
        AND sc.org_id = s.org_id
        AND sc.ran_at <= s.computed_at
      ORDER BY sc.ran_at DESC
      LIMIT 1
   );

-- Deliberately NOT NULL, and deliberately after the backfill: a score whose
-- scan cannot be identified is exactly the orphan this migration exists to make
-- impossible, and the migration should fail loudly rather than leave one.
ALTER TABLE scores ALTER COLUMN scan_id SET NOT NULL;

ALTER TABLE scores
  ADD CONSTRAINT scores_scan_matches_company_and_org
  FOREIGN KEY (scan_id, company_id, org_id)
  REFERENCES scans (id, company_id, org_id) ON DELETE CASCADE;

CREATE INDEX scores_scan_idx ON scores (scan_id);
