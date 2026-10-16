-- 0021: what a company is, beyond its domain — and one active ICP per org.
--
-- FIRMOGRAPHICS. `companies` has carried `headcount` and `stage` since 0002
-- and nothing wrote or read them. The agent now researches companies — on
-- their own sites, on directories, through the search connectors — and the
-- team targets by market and size ("small to mid-size companies in India"),
-- so a company records what it is: its industry, its city, a one-line
-- description of what it sells, and its headcount WITH where that number came
-- from. A headcount is a claim from research, never an observation of the
-- scanner's, so it does not stand without its source: a source with no
-- headcount is refused, and every reader shows the number beside it.
--
-- `stage` keeps no CHECK here: nothing has ever written it, the vocabulary is
-- the application's (`COMPANY_STAGES`), and a CHECK on a column is evaluated
-- on every later UPDATE of the row — a value somebody stored by hand before
-- this migration would make that row un-updatable (0018's trap).
--
-- Scoring reads two of these (packages/core `scoreCompany`): a recorded
-- headcount above the active profile's `firmographics.headcount.max` is its
-- `enterprise_scale` disqualifier — written in the seeded profile and checked
-- by nothing until now — and a profile may also disqualify `too_small` and
-- `outside_geos`. Unknown is never a disqualifier: no headcount, or a country
-- that cannot be read, is not assessed.
ALTER TABLE companies
  ADD COLUMN industry text,
  ADD COLUMN city text,
  ADD COLUMN description text,
  ADD COLUMN headcount_source text,
  ADD CONSTRAINT companies_headcount_is_a_count
    CHECK (headcount IS NULL OR (headcount > 0 AND headcount <= 10000000)),
  ADD CONSTRAINT companies_industry_is_bounded CHECK (industry IS NULL OR length(industry) BETWEEN 1 AND 80),
  ADD CONSTRAINT companies_city_is_bounded CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  ADD CONSTRAINT companies_description_is_bounded
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 600),
  ADD CONSTRAINT companies_headcount_source_is_bounded
    CHECK (headcount_source IS NULL OR length(headcount_source) BETWEEN 1 AND 300),
  ADD CONSTRAINT companies_headcount_source_needs_a_headcount
    CHECK (headcount_source IS NULL OR headcount IS NOT NULL);

-- ONE ACTIVE PROFILE. `activeIcpProfile` reads `WHERE active LIMIT 1` with no
-- ORDER BY, so two active rows made every scan's score — and the profile it
-- names — a matter of which row the planner met first. Nothing wrote a second
-- profile until now; the agent's `create_icp` and `activate_icp` do, so the
-- rule is the database's. A database that somehow holds two keeps the newest.
UPDATE icp_profiles p
   SET active = false
 WHERE p.active
   AND EXISTS (
     SELECT 1 FROM icp_profiles q
      WHERE q.org_id = p.org_id
        AND q.active
        AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id))
   );

CREATE UNIQUE INDEX icp_profiles_one_active_per_org ON icp_profiles (org_id) WHERE active;
