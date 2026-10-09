-- 0028: research about a company, with its sources.
--
-- The assistant finds things out — through a research connector, a search,
-- a page it read — and until now could only put them in a note, where they
-- read as somebody's words with nothing behind them. A research row is a
-- CLAIM with the PAGE it came from: "Raised a Series A in March 2026",
-- https://…; a person reads the claim beside its source, opens the source,
-- and decides. It is research, never evidence (§2.2): nothing here is
-- observed by the scanner, nothing here is quoted in anything outbound, and
-- the company page says so above the list.
CREATE TABLE company_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  claim text NOT NULL,
  source_url text NOT NULL,
  source_title text,
  -- The person who recorded it, or NULL for the agent; the audit row names the actor either way.
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT company_research_company_in_org
    FOREIGN KEY (company_id, org_id) REFERENCES companies (id, org_id) ON DELETE CASCADE,
  CONSTRAINT company_research_recorded_by_in_org
    FOREIGN KEY (recorded_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (recorded_by),
  CONSTRAINT company_research_claim_is_bounded CHECK (length(btrim(claim)) BETWEEN 1 AND 500),
  -- A source is a page a person can open: https, with a host.
  CONSTRAINT company_research_source_is_a_page CHECK (source_url ~ '^https://[^/[:space:]]+' AND length(source_url) <= 2048),
  CONSTRAINT company_research_title_is_bounded CHECK (source_title IS NULL OR length(source_title) <= 300),
  CONSTRAINT company_research_one_claim_per_source UNIQUE (company_id, claim, source_url)
);
CREATE INDEX company_research_company_idx ON company_research (company_id, created_at DESC);
