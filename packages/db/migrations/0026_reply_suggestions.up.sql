-- 0026: a suggested answer waiting on every email reply.
--
-- A reply pauses the person, cancels their queue, moves the deal and is
-- classified — and then the inbox's composer opened empty. Now the worker's
-- model drafts a SUGGESTION from the reply's own words, the message it
-- answered, what the scan observed and the agency's playbook and catalogue,
-- and the suggestion waits here for a person to read, change and send
-- through the answer path they always used.
--
-- A suggestion is NOT a message: it is never a `touches` row, so nothing in
-- the send path, the approval queue, the resume rules or the daily cap can
-- see it, and nothing is resumed, queued or sent until a person presses
-- Answer and then Approve. One row per reply, written once and never
-- retried: a reply the readers refuse (an opt-out, an auto-reply, a
-- colleague's words, a suppressed sender) is recorded as SKIPPED with why,
-- so the sweep that drafts them does not ask again.
CREATE TABLE reply_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The reply it answers, in its own org (0024's pair), and gone with it.
  touch_id uuid NOT NULL,
  status text NOT NULL,
  -- The model's words, present exactly when drafted. Never sent as they are:
  -- the composer shows them for a person to change.
  body text,
  -- Which model wrote it, for /audit and the label beside it; 'deterministic' never — there is no fallback text.
  model text,
  -- Why nothing was drafted, as a code the readers return; present exactly when skipped.
  skipped_why text,
  used_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT reply_suggestions_touch_in_org
    FOREIGN KEY (touch_id, org_id) REFERENCES touches (id, org_id) ON DELETE CASCADE,
  CONSTRAINT reply_suggestions_one_per_reply UNIQUE (touch_id),
  CONSTRAINT reply_suggestions_status_is_known CHECK (status IN ('drafted', 'skipped')),
  CONSTRAINT reply_suggestions_drafted_has_words
    CHECK ((status = 'drafted') = (body IS NOT NULL AND model IS NOT NULL)),
  CONSTRAINT reply_suggestions_skipped_says_why
    CHECK ((status = 'skipped') = (skipped_why IS NOT NULL)),
  CONSTRAINT reply_suggestions_body_is_bounded CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
  CONSTRAINT reply_suggestions_skipped_why_is_bounded CHECK (skipped_why IS NULL OR length(skipped_why) BETWEEN 1 AND 40)
);
