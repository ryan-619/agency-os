-- 0025: the night shift.
--
-- Finding businesses was a person typing "dentists in Indiranagar" into chat
-- and waiting while each was filed, scanned and measured. The night shift
-- does it while the agency sleeps: once a night, at a time in the agency's
-- own zone, it runs the org's SAVED SEARCHES on Google Maps, files the
-- businesses that are new, scans the public pages of each one with a site of
-- its own and asks Google how it does on a phone — and leaves a ranked list
-- for the morning. It sends nothing and contacts nobody: everything it writes
-- is the agency's own records and evidence, as a person's search and scan are.

-- One row per org: whether it runs, when, and the day it last ran (its claim).
CREATE TABLE night_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  run_at text NOT NULL DEFAULT '02:00',
  time_zone text NOT NULL DEFAULT 'Asia/Kolkata',
  -- The zone's date of the last run: one run a night, claimed by one UPDATE.
  last_run_on date,
  -- "Run it now": due at the next look, whatever the clock says, and cleared by the claim.
  requested_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT night_shifts_updated_by_in_org
    FOREIGN KEY (updated_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (updated_by),
  CONSTRAINT night_shifts_run_at_is_a_wall_clock CHECK (run_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT night_shifts_time_zone_is_not_blank CHECK (length(btrim(time_zone)) BETWEEN 1 AND 64)
);

-- What it searches for, as a person would type it into Google Maps.
CREATE TABLE night_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  query text NOT NULL,
  -- Where Google searches from (two letters), and what the businesses found are filed as.
  region text,
  city text,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT night_searches_created_by_in_org
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by),
  CONSTRAINT night_searches_query_is_bounded CHECK (length(btrim(query)) BETWEEN 3 AND 200),
  CONSTRAINT night_searches_region_is_two_letters CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
  CONSTRAINT night_searches_city_is_bounded CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 80)
);

-- One search per wording per org, whatever its case or spacing at the ends.
CREATE UNIQUE INDEX night_searches_org_query_key ON night_searches (org_id, lower(btrim(query)));
