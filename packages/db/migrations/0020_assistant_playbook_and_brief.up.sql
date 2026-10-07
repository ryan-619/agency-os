-- 0020: what the AI is told about the agency, and its morning brief.
--
-- One row per org, written from Settings → Assistant.
--
-- The PLAYBOOK is the agency's own words — services, prices, past work, the
-- voice it writes in — and the worker appends it to the AI's instructions on
-- every turn, after its rules, labelled as a description of the agency and
-- never as a rule. Bounded, because every character is sent with every
-- message, and an unbounded field is an unbounded bill.
--
-- The MORNING BRIEF is one unattended turn a day, started by the worker at a
-- wall-clock time in a declared zone (never the server's), in the name of the
-- person who switched it on and in a thread of theirs. Nothing that needs a
-- person's approval runs in it (the gate declines it, apps/agent). The day it
-- last ran is stored as the zone's own DATE, and the worker claims a day with
-- one UPDATE that matches only while that day has not run — so two workers,
-- or one that restarts, start one brief a day. An owner may also ask for one
-- now (brief_requested_at), which the same claim starts once and clears.
CREATE TABLE assistant_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  playbook            text NOT NULL DEFAULT '',
  -- Who last saved the playbook, and when; SET NULL names its column, so the
  -- NOT NULL org_id is never nulled with it (0018's shape). Its own time,
  -- because updated_at moves on every write to the row, the worker's daily
  -- claim included.
  playbook_updated_by uuid,
  playbook_updated_at timestamptz,
  brief_enabled       boolean NOT NULL DEFAULT false,
  -- In whose name the brief runs, and whose thread it lands in. A brief with
  -- nobody to run as is skipped by the worker, with a reason in its log.
  brief_user_id       uuid,
  -- A wall-clock time, HH:MM, read in brief_time_zone.
  brief_at            text NOT NULL DEFAULT '08:30',
  brief_time_zone     text NOT NULL DEFAULT 'Asia/Kolkata',
  -- The zone's own date of the last brief, written by the worker's claim.
  brief_last_run_on   date,
  -- "Run it now": a brief somebody asked for, started by the worker's next
  -- look whatever the clock says, and cleared by the same claim.
  brief_requested_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  CONSTRAINT assistant_settings_one_per_org UNIQUE (org_id),
  CONSTRAINT assistant_settings_playbook_editor_is_in_the_same_org
    FOREIGN KEY (playbook_updated_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (playbook_updated_by),
  CONSTRAINT assistant_settings_brief_user_is_in_the_same_org
    FOREIGN KEY (brief_user_id, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (brief_user_id),
  CONSTRAINT assistant_settings_playbook_is_bounded CHECK (length(playbook) <= 20000),
  CONSTRAINT assistant_settings_brief_at_is_a_wall_clock
    CHECK (brief_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- The same shape 0013 gives contacts' and companies' zones; whether the
  -- runtime knows the zone is checked where it is written.
  CONSTRAINT assistant_settings_brief_time_zone_looks_like_iana
    CHECK (brief_time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$')
);

CREATE TRIGGER assistant_settings_set_updated_at BEFORE UPDATE ON assistant_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
