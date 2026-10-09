-- 0022: businesses as a customer finds them, the services the agency sells,
-- what Google's PageSpeed measured, and work done by phone or on foot.
--
-- The agency finds businesses of every kind that need help and offers them
-- whatever it can do (2026-10-08) — not security alone. Four things follow.
--
-- LISTINGS. A business is often found on Google Maps before anyone has seen
-- a website of its own, and many have none: a listing with no site, a
-- Facebook page or a directory entry instead. So a company records what its
-- listing says — the main phone line (E.164, as every phone here is), the
-- address, the place id, its rating and review count, its category, the
-- website the listing names, and WHEN all of that was read. A listing is a
-- third party's record, not an observation of ours, and it ages: every reader
-- dates it by `listing_checked_at`, which a place id may not exist without.
-- A business with no website at all keeps a reserved placeholder in `domain`
-- (`<slug>-<hash>.nosite.invalid` — `.invalid` can never resolve, RFC 6761),
-- because `domain` is how every page and tool names a company.
ALTER TABLE companies
  ADD COLUMN phone text,
  ADD COLUMN address text,
  ADD COLUMN google_place_id text,
  ADD COLUMN google_maps_url text,
  ADD COLUMN google_rating numeric(2, 1),
  ADD COLUMN google_review_count integer,
  ADD COLUMN google_category text,
  ADD COLUMN listing_website text,
  ADD COLUMN listing_checked_at timestamptz,
  ADD CONSTRAINT companies_phone_is_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT companies_address_is_bounded CHECK (address IS NULL OR length(address) BETWEEN 1 AND 300),
  ADD CONSTRAINT companies_place_id_is_bounded CHECK (google_place_id IS NULL OR length(google_place_id) BETWEEN 1 AND 300),
  ADD CONSTRAINT companies_maps_url_is_https
    CHECK (google_maps_url IS NULL OR (google_maps_url LIKE 'https://%' AND length(google_maps_url) <= 500)),
  ADD CONSTRAINT companies_rating_is_a_rating CHECK (google_rating IS NULL OR (google_rating >= 0 AND google_rating <= 5)),
  ADD CONSTRAINT companies_review_count_is_a_count CHECK (google_review_count IS NULL OR google_review_count >= 0),
  ADD CONSTRAINT companies_category_is_bounded CHECK (google_category IS NULL OR length(google_category) BETWEEN 1 AND 80),
  ADD CONSTRAINT companies_listing_website_is_bounded
    CHECK (listing_website IS NULL OR length(listing_website) BETWEEN 1 AND 500),
  -- A listing fact is dated, or it is not stored.
  ADD CONSTRAINT companies_listing_has_its_time
    CHECK (listing_checked_at IS NOT NULL OR (google_place_id IS NULL AND google_rating IS NULL
           AND google_review_count IS NULL AND listing_website IS NULL));

-- One company per listing in an org: two searches that meet the same place
-- file it once, and the second reads it as already present.
CREATE UNIQUE INDEX companies_org_place_key ON companies (org_id, google_place_id) WHERE google_place_id IS NOT NULL;

-- Which path a company came in by: 'google_maps' joins the five.
ALTER TABLE companies DROP CONSTRAINT companies_source_check;
ALTER TABLE companies ADD CONSTRAINT companies_source_check
  CHECK (source IN ('apollo', 'manual', 'import', 'agent', 'inbound', 'google_maps'));

-- A row that names a company names one in its own org: the pair, as 0018 gave
-- users and contacts.
ALTER TABLE companies ADD CONSTRAINT companies_id_org_key UNIQUE (id, org_id);

-- SERVICES. What the agency sells, in its own words, with a price range and
-- the NEEDS each answers (packages/core `NEED_KEYS`: no_website, slow_site,
-- no_whatsapp, few_reviews, security_gaps …). The opportunity read matches a
-- business's observed needs to these; a service with no need is still
-- offered by hand. Prices are whole units of the currency.
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  needs text[] NOT NULL DEFAULT '{}',
  price_from integer,
  price_to integer,
  currency text NOT NULL DEFAULT 'INR',
  price_unit text NOT NULL DEFAULT 'one_off',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT services_name_is_bounded CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT services_description_is_bounded CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1000),
  CONSTRAINT services_needs_are_bounded CHECK (cardinality(needs) <= 20),
  CONSTRAINT services_price_is_a_range CHECK (
    (price_from IS NULL OR price_from >= 0) AND (price_to IS NULL OR price_to >= 0)
    AND (price_from IS NULL OR price_to IS NULL OR price_to >= price_from)
  ),
  CONSTRAINT services_currency_is_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT services_price_unit_known CHECK (price_unit IN ('one_off', 'monthly', 'yearly', 'hourly', 'daily'))
);
CREATE UNIQUE INDEX services_org_name_key ON services (org_id, lower(btrim(name)));
CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- SITE AUDITS. What Google's PageSpeed Insights measured of a company's
-- homepage — run from Google's side, like any visitor, never by us. §2.2 holds
-- as it does for scans: an audit that failed (the site did not load for
-- Lighthouse, a quota, a timeout) carries its reason and NO score, so a
-- failure can never read as "a slow site".
CREATE TABLE site_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'pagespeed',
  strategy text NOT NULL,
  url text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  error text,
  performance smallint,
  accessibility smallint,
  best_practices smallint,
  seo smallint,
  lcp_ms integer,
  cls numeric(6, 3),
  tbt_ms integer,
  fcp_ms integer,
  field_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT site_audits_company_in_org FOREIGN KEY (company_id, org_id)
    REFERENCES companies (id, org_id) ON DELETE CASCADE,
  CONSTRAINT site_audits_source_known CHECK (source IN ('pagespeed')),
  CONSTRAINT site_audits_strategy_known CHECK (strategy IN ('mobile', 'desktop')),
  CONSTRAINT site_audits_url_is_bounded CHECK (url LIKE 'http%' AND length(url) <= 500),
  CONSTRAINT site_audits_failure_has_its_reason CHECK (ok = (error IS NULL)),
  CONSTRAINT site_audits_error_is_bounded CHECK (error IS NULL OR length(error) BETWEEN 1 AND 300),
  CONSTRAINT site_audits_failure_has_no_scores CHECK (ok OR (performance IS NULL AND accessibility IS NULL
    AND best_practices IS NULL AND seo IS NULL AND lcp_ms IS NULL AND cls IS NULL AND tbt_ms IS NULL
    AND fcp_ms IS NULL AND field_category IS NULL)),
  CONSTRAINT site_audits_scores_are_scores CHECK (
    (performance IS NULL OR performance BETWEEN 0 AND 100) AND (accessibility IS NULL OR accessibility BETWEEN 0 AND 100)
    AND (best_practices IS NULL OR best_practices BETWEEN 0 AND 100) AND (seo IS NULL OR seo BETWEEN 0 AND 100)
  ),
  CONSTRAINT site_audits_metrics_are_measures CHECK (
    (lcp_ms IS NULL OR lcp_ms >= 0) AND (cls IS NULL OR cls >= 0) AND (tbt_ms IS NULL OR tbt_ms >= 0)
    AND (fcp_ms IS NULL OR fcp_ms >= 0)
  ),
  CONSTRAINT site_audits_field_category_known CHECK (field_category IS NULL OR field_category IN ('FAST', 'AVERAGE', 'SLOW'))
);
CREATE INDEX site_audits_company_ran_idx ON site_audits (company_id, ran_at DESC);
CREATE TRIGGER site_audits_set_updated_at BEFORE UPDATE ON site_audits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- FIELD WORK. A call and a visit are a PERSON's acts, made from their own
-- phone or on foot, recorded as tasks — the system still places no call
-- (§2.1: there is no dialling code). Whether and when to call is the person's
-- decision, and a number on the suppression list is refused a call task.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_known;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_known
  CHECK (kind IN ('todo', 'linkedin_send', 'kickoff', 'renewal', 'call', 'visit'));
