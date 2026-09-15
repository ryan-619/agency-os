-- 0012_meetings_and_proposals — the two artefacts of closing (PROMPT.md §8.6).
--
-- Phase 5: "Kanban, calendar, proposals, meeting briefs. Done when: a replied
-- lead can be dragged to meeting, booked, and a proposal generated from its
-- findings." The kanban is `deals.stage`, which exists. The other two need a
-- row each.
--
-- ---------------------------------------------------------------------------
-- meetings
-- ---------------------------------------------------------------------------
--
-- A meeting is recorded here whether it was booked by hand, by the agent's
-- `book_meeting` tool, or by an inbound lead through the public booking page.
-- The calendar event itself lives wherever the calendar is — §8.6 puts that
-- behind the Google Calendar MCP connector — and `external_ref` points at it.
-- This row is what the brief is generated from and what moves the deal.
--
-- `time_zone` is stored with `starts_at` because a meeting is a wall-clock
-- commitment: "Thursday at 2" is what two people agreed, and the instant
-- alone loses which 2 they meant if either side moves.

CREATE TABLE meetings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- SET NULL: the meeting happened even if the person's row is later removed.
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  title         text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  time_zone     text NOT NULL,
  -- 'manual' | 'agent' | 'booking_page'
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'agent', 'booking_page')),
  -- The calendar event id, or the booking page's request id. Never a link
  -- that carries a credential.
  external_ref  text,
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,

  CONSTRAINT meetings_end_after_start CHECK (ends_at IS NULL OR ends_at > starts_at),
  -- The runtime's ICU data is the authority on zone names ('Japan' and 'GMT'
  -- are valid and have no slash); this only stops whitespace and junk. See
  -- 0013 for why the 0010 pattern was wrong.
  CONSTRAINT meetings_time_zone_looks_like_iana
    CHECK (time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$')
);

CREATE INDEX meetings_org_starts_idx ON meetings (org_id, starts_at);
CREATE INDEX meetings_company_idx ON meetings (company_id, starts_at DESC);
CREATE TRIGGER meetings_set_updated_at BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------
--
-- "Proposals generate from findings." The generated document is stored whole,
-- as JSON, together with the scan it was generated FROM — the same discipline
-- `scores.scan_id` follows (0006): a proposal names its evidence, so a page can
-- never show one scan's scope above another scan's findings.
--
-- `status` is the proposal's own life: drafted, sent, and what the buyer said.
-- Sending a proposal is Phase 4's send path's job, not this table's; 'sent'
-- here records that it happened.

CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  -- RESTRICT: the evidence a proposal was written from stays readable for as
  -- long as the proposal does.
  scan_id       uuid NOT NULL REFERENCES scans(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
  title         text NOT NULL,
  document      jsonb NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  total_low     integer,
  total_high    integer,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,

  -- A decision has a time, and nothing else does.
  CONSTRAINT proposals_decided_has_time
    CHECK ((status IN ('accepted', 'declined')) = (decided_at IS NOT NULL)),
  CONSTRAINT proposals_total_is_a_range
    CHECK ((total_low IS NULL) = (total_high IS NULL) AND (total_low IS NULL OR total_low <= total_high))
);

CREATE INDEX proposals_org_status_idx ON proposals (org_id, status, created_at DESC);
CREATE INDEX proposals_company_idx ON proposals (company_id, created_at DESC);
CREATE TRIGGER proposals_set_updated_at BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- One open deal per company
-- ---------------------------------------------------------------------------
--
-- `advanceDeal` is read-then-write: it looks for an open deal and creates one
-- if there is none. A send and a reply landing at the same moment both find
-- none and both insert, and the company has two open deals — one of which
-- the board shows and the other of which the next reply advances. Found by
-- review. The index makes the second insert fail, and `advanceDeal` catches
-- that and re-reads. Closed deals are excluded: a company can be lost and
-- later reopened, and both rows are history.

CREATE UNIQUE INDEX deals_one_open_per_company ON deals (org_id, company_id)
  WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- The public booking page
-- ---------------------------------------------------------------------------
--
-- §8.6: "Booking links land inbound leads with consent recorded at the form."
-- The link is /book/<slug>. A slug rather than the org id, because the org id
-- is used everywhere else and a public URL should not teach anyone what it
-- is. NULL means the org has no public booking page.

ALTER TABLE orgs
  ADD COLUMN booking_slug text UNIQUE,
  ADD CONSTRAINT orgs_booking_slug_is_url_safe
    CHECK (booking_slug IS NULL OR booking_slug ~ '^[a-z0-9][a-z0-9-]{2,62}$');
