-- 0023: quotes, the agency's own profile, the links a business opens, and
-- where a business is.
--
-- The agency sells websites, listings fixed, reviews earned, apps and
-- custom software to businesses of every kind (2026-10-08), and the one
-- priced document it could produce was a proposal DERIVED FROM A SECURITY
-- SCAN. Four things follow.
--
-- THE AGENCY'S PROFILE. What a quote prints about the seller: its legal
-- name, address, GSTIN, the GST it charges, the UPI ID an advance is paid
-- to, how long a quote is valid and its standard terms, and a brochure link
-- every email may carry. One row per org. GST is charged only by a seller
-- that is registered for it, so a rate above zero needs a GSTIN — a CHECK,
-- not a convention.
CREATE TABLE org_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  legal_name text,
  address text,
  phone text,
  email text,
  website text,
  gstin text,
  gst_rate numeric(5, 2) NOT NULL DEFAULT 0,
  upi_vpa text,
  upi_payee text,
  advance_percent smallint NOT NULL DEFAULT 50,
  quote_validity_days smallint NOT NULL DEFAULT 15,
  quote_terms text,
  brochure_url text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT org_profiles_updated_by_in_org
    FOREIGN KEY (updated_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (updated_by),
  CONSTRAINT org_profiles_legal_name_is_bounded CHECK (legal_name IS NULL OR length(btrim(legal_name)) BETWEEN 1 AND 200),
  CONSTRAINT org_profiles_address_is_bounded CHECK (address IS NULL OR length(address) BETWEEN 1 AND 500),
  CONSTRAINT org_profiles_phone_is_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT org_profiles_email_is_an_address CHECK (email IS NULL OR (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 200)),
  CONSTRAINT org_profiles_website_is_http CHECK (website IS NULL OR (website ~ '^https?://' AND length(website) <= 300)),
  CONSTRAINT org_profiles_gstin_shape CHECK (gstin IS NULL OR gstin ~ '^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT org_profiles_gst_rate_is_a_rate CHECK (gst_rate >= 0 AND gst_rate <= 28),
  -- Only a registered seller charges GST.
  CONSTRAINT org_profiles_gst_needs_a_gstin CHECK (gst_rate = 0 OR gstin IS NOT NULL),
  CONSTRAINT org_profiles_vpa_shape CHECK (upi_vpa IS NULL OR upi_vpa ~ '^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$'),
  CONSTRAINT org_profiles_payee_is_bounded CHECK (upi_payee IS NULL OR length(btrim(upi_payee)) BETWEEN 1 AND 100),
  CONSTRAINT org_profiles_advance_is_a_percent CHECK (advance_percent BETWEEN 0 AND 100),
  CONSTRAINT org_profiles_validity_is_bounded CHECK (quote_validity_days BETWEEN 1 AND 365),
  CONSTRAINT org_profiles_terms_are_bounded CHECK (quote_terms IS NULL OR length(quote_terms) BETWEEN 1 AND 4000),
  CONSTRAINT org_profiles_brochure_is_https CHECK (brochure_url IS NULL OR (brochure_url LIKE 'https://%' AND length(brochure_url) <= 500))
);
CREATE TRIGGER org_profiles_set_updated_at BEFORE UPDATE ON org_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- QUOTES. Line items a person chooses — prefilled from the services the
-- business's needs point at — with the totals the app computes, held to one
-- truth here: the total IS the subtotal plus the tax, and the advance never
-- exceeds it. Money is whole units of the currency, as the catalogue's is.
-- The needs it answers are snapshotted with their dated evidence, so the
-- document says what was true when it was written. The seller's details are
-- snapshotted when it is SENT, so a sent quote does not change under the
-- buyer when the profile does.
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  contact_id uuid,
  number text NOT NULL,
  title text NOT NULL,
  intro text,
  items jsonb NOT NULL DEFAULT '[]',
  currency text NOT NULL DEFAULT 'INR',
  subtotal bigint NOT NULL DEFAULT 0,
  tax_rate numeric(5, 2) NOT NULL DEFAULT 0,
  tax_amount bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  advance_percent smallint NOT NULL DEFAULT 0,
  advance_amount bigint NOT NULL DEFAULT 0,
  needs jsonb NOT NULL DEFAULT '[]',
  terms text,
  valid_until date NOT NULL,
  seller jsonb,
  status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz,
  accepted_at timestamptz,
  accepted_by_name text,
  declined_at timestamptz,
  decline_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT quotes_company_in_org FOREIGN KEY (company_id, org_id) REFERENCES companies (id, org_id) ON DELETE CASCADE,
  CONSTRAINT quotes_contact_in_org FOREIGN KEY (contact_id, org_id) REFERENCES contacts (id, org_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT quotes_created_by_in_org FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by),
  CONSTRAINT quotes_number_shape CHECK (number ~ '^Q-[0-9]{4}-[0-9]{4,}$'),
  CONSTRAINT quotes_title_is_bounded CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT quotes_intro_is_bounded CHECK (intro IS NULL OR length(intro) BETWEEN 1 AND 4000),
  CONSTRAINT quotes_items_are_a_list CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 30),
  CONSTRAINT quotes_needs_are_a_list CHECK (jsonb_typeof(needs) = 'array' AND jsonb_array_length(needs) <= 20),
  CONSTRAINT quotes_currency_is_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT quotes_amounts_are_amounts CHECK (subtotal >= 0 AND tax_amount >= 0 AND advance_amount >= 0),
  CONSTRAINT quotes_total_adds_up CHECK (total = subtotal + tax_amount),
  CONSTRAINT quotes_advance_within_total CHECK (advance_amount <= total),
  CONSTRAINT quotes_tax_rate_is_a_rate CHECK (tax_rate >= 0 AND tax_rate <= 28),
  CONSTRAINT quotes_advance_is_a_percent CHECK (advance_percent BETWEEN 0 AND 100),
  CONSTRAINT quotes_terms_are_bounded CHECK (terms IS NULL OR length(terms) BETWEEN 1 AND 4000),
  CONSTRAINT quotes_status_known CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
  -- Nothing leaves as a quote with no lines, and what was sent names its seller.
  CONSTRAINT quotes_sent_has_lines CHECK (status = 'draft' OR jsonb_array_length(items) >= 1),
  CONSTRAINT quotes_sent_has_its_seller CHECK (status = 'draft' OR seller IS NOT NULL),
  CONSTRAINT quotes_sent_has_its_time CHECK (status = 'draft' OR sent_at IS NOT NULL),
  CONSTRAINT quotes_accepted_has_its_time CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CONSTRAINT quotes_accepted_name_is_bounded
    CHECK (accepted_by_name IS NULL OR length(btrim(accepted_by_name)) BETWEEN 1 AND 120),
  CONSTRAINT quotes_declined_has_its_time CHECK ((status = 'declined') = (declined_at IS NOT NULL)),
  CONSTRAINT quotes_decline_reason_is_bounded CHECK (decline_reason IS NULL OR length(decline_reason) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX quotes_org_number_key ON quotes (org_id, number);
CREATE INDEX quotes_company_created_idx ON quotes (company_id, created_at DESC);
CREATE TRIGGER quotes_set_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- SHARE LINKS. A link a business opens: its quote, its own audit page, or a
-- preview of the website the agency would build it. As with a proposal's
-- link, only the sha256 of the token is stored, a link can be revoked and
-- expires, and a view is a count and two times. The kind decides what it
-- names: a quote link its quote, the others the company alone.
CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  company_id uuid NOT NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT share_links_company_in_org FOREIGN KEY (company_id, org_id) REFERENCES companies (id, org_id) ON DELETE CASCADE,
  CONSTRAINT share_links_created_by_in_org
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by),
  CONSTRAINT share_links_kind_known CHECK (kind IN ('quote', 'report', 'preview')),
  CONSTRAINT share_links_quote_iff_quote_kind CHECK ((kind = 'quote') = (quote_id IS NOT NULL)),
  CONSTRAINT share_links_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT share_links_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT share_links_views_are_a_count CHECK (view_count >= 0),
  CONSTRAINT share_links_viewed_has_its_times
    CHECK ((view_count = 0) = (first_viewed_at IS NULL) AND (first_viewed_at IS NULL) = (last_viewed_at IS NULL))
);
CREATE INDEX share_links_company_created_idx ON share_links (company_id, created_at DESC);
CREATE INDEX share_links_quote_idx ON share_links (quote_id) WHERE quote_id IS NOT NULL;
CREATE TRIGGER share_links_set_updated_at BEFORE UPDATE ON share_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- WHERE A BUSINESS IS. Google's coordinates for a listing, so "your nearest
-- competitors" means near, and a day's visits can be planned. A listing
-- fact like the rest, dated by `listing_checked_at`.
ALTER TABLE companies
  ADD COLUMN latitude double precision,
  ADD COLUMN longitude double precision,
  ADD CONSTRAINT companies_coordinates_are_a_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT companies_coordinates_are_on_earth
    CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
  ADD CONSTRAINT companies_coordinates_are_dated CHECK (latitude IS NULL OR listing_checked_at IS NOT NULL);
