-- 0002_icp_and_companies — the ICP definition and the qualification data core.
--
-- Evidence integrity (PROMPT.md §2.2) is enforced structurally here:
--   * findings.observed is NOT NULL — a finding must state whether it was observed
--   * findings.gap is NULL when observed = false, forced by a CHECK constraint.
--     An unobserved signal cannot claim a gap. It is not "no gap", it is "unknown".
--   * findings.evidence is NOT NULL — a finding always carries what produced it.

CREATE TABLE icp_profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- firmographics, signal weights, qualify_at, tier boundaries, disqualifiers, outreach rules
  definition jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE UNIQUE INDEX icp_profiles_org_name_key ON icp_profiles (org_id, name);
CREATE TRIGGER icp_profiles_set_updated_at BEFORE UPDATE ON icp_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- companies
--
-- PROMPT.md §4 lists `domain unique`. Scoped to (org_id, domain) instead:
-- a globally unique domain would force exactly the migration that putting
-- org_id on every table was meant to avoid. Deliberate, flagged in CLAUDE.md.
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  name          text,
  country       text,
  stage         text,
  headcount     integer,
  title         text,
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('apollo', 'manual', 'import', 'agent')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

CREATE UNIQUE INDEX companies_org_domain_key ON companies (org_id, domain);
CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- scans — one row per run of the public-surface collector against one company.
-- raw holds the full response headers, TLS info and script srcs.
-- ---------------------------------------------------------------------------
CREATE TABLE scans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL,
  error      text,
  raw        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX scans_company_ran_idx ON scans (company_id, ran_at DESC);
-- Redundant against the primary key, but Postgres requires a unique constraint
-- on exactly these columns for findings' composite foreign key below.
ALTER TABLE scans ADD CONSTRAINT scans_id_company_org_key UNIQUE (id, company_id, org_id);
CREATE TRIGGER scans_set_updated_at BEFORE UPDATE ON scans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- findings — one row per signal per scan.
-- ---------------------------------------------------------------------------
CREATE TABLE findings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scan_id    uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  signal_key text NOT NULL,
  observed   boolean NOT NULL,
  gap        boolean,
  weight     integer NOT NULL DEFAULT 0 CHECK (weight >= 0),
  detail     text,
  evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  stale      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,

  -- §2.2: a fetch failure, timeout, WAF block or CDN quirk produces observed = false,
  -- which scores zero and is never rendered as a gap. Unobserved means unknown,
  -- so `gap` must be NULL — the database refuses to store "we did not see it,
  -- and also it is missing".
  CONSTRAINT findings_unobserved_has_no_gap
    CHECK ((observed AND gap IS NOT NULL) OR (NOT observed AND gap IS NULL)),

  -- §2.2: "Findings carry the raw evidence that produced them (the header
  -- value seen, the URL fetched, the timestamp)." A row asserting a gap with
  -- an empty evidence object is an unsupported claim, and unsupported claims
  -- are what this table exists to prevent. Not observing something is fine —
  -- that row carries no claim and needs no evidence.
  CONSTRAINT findings_a_claimed_gap_carries_evidence
    CHECK (gap IS NOT TRUE OR evidence <> '{}'::jsonb),

  -- The denormalised company_id is what the UI reads, so it must agree with
  -- the scan the finding came from. Without this, a batch scanner with an
  -- off-by-one can file victim.com's evidence under other.com's name and
  -- every constraint still passes. org_id is in the key for the same reason.
  CONSTRAINT findings_scan_matches_company_and_org
    FOREIGN KEY (scan_id, company_id, org_id)
    REFERENCES scans (id, company_id, org_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- §2.2, the rule the product's credibility rests on: "the app must never state
-- a security finding it did not actually observe."
--
-- The CHECK above only makes `observed` and `gap` agree with each other. It
-- cannot see the scan. This trigger closes the actual gap: a finding may not
-- claim it observed anything if the scan it came from did not complete. A
-- fetch failure, timeout, WAF block or CDN quirk is not an observation, and
-- the database — not the scanner's good intentions — is what says so.
--
-- Fires on UPDATE as well as INSERT, so an honest row cannot be edited into a
-- dishonest one afterwards.
-- ---------------------------------------------------------------------------
CREATE FUNCTION findings_refuse_claims_from_a_failed_scan() RETURNS trigger AS $$
DECLARE
  parent_scan_ok boolean;
BEGIN
  IF NEW.observed THEN
    SELECT ok INTO parent_scan_ok FROM scans WHERE id = NEW.scan_id;
    IF NOT parent_scan_ok THEN
      RAISE EXCEPTION
        'findings_observed_requires_a_successful_scan: signal "%" claims observed = true, but scan % did not complete',
        NEW.signal_key, NEW.scan_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER findings_observed_requires_a_successful_scan
  BEFORE INSERT OR UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION findings_refuse_claims_from_a_failed_scan();

CREATE UNIQUE INDEX findings_scan_signal_key ON findings (scan_id, signal_key);
CREATE INDEX findings_company_stale_idx ON findings (company_id, stale);
CREATE TRIGGER findings_set_updated_at BEFORE UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- scores — recomputed on every scan. History is kept, never overwritten (§4).
-- ---------------------------------------------------------------------------
CREATE TABLE scores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  icp_profile_id      uuid NOT NULL REFERENCES icp_profiles(id) ON DELETE RESTRICT,
  score               integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier                text,
  qualified           boolean NOT NULL DEFAULT false,
  disqualified_reason text,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz
);

CREATE INDEX scores_company_computed_idx ON scores (company_id, computed_at DESC);
CREATE INDEX scores_org_qualified_idx ON scores (org_id, qualified, score DESC);
CREATE TRIGGER scores_set_updated_at BEFORE UPDATE ON scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
