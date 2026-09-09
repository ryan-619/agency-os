-- 0001_foundation — organisation, auth, users, audit log.
--
-- Conventions used by every migration in this directory (PROMPT.md §4):
--   * id uuid primary key default gen_random_uuid()   (gen_random_uuid is core since PG13; no pgcrypto needed)
--   * created_at timestamptz not null default now()
--   * updated_at timestamptz, maintained by the set_updated_at() trigger below
--   * org_id uuid not null on every BUSINESS table, even though exactly one org exists today
--
-- Enumerated columns are `text` + a CHECK constraint rather than a Postgres ENUM type.
-- Chosen deliberately: adding/removing a value in a CHECK is an ordinary reversible DDL
-- statement, whereas ALTER TYPE ... ADD VALUE cannot be rolled back in a transaction.
-- Every migration here must be reversible (PROMPT.md §10).

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

-- Maintains updated_at on UPDATE. Attached to every table that has the column.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- users — the agency's own team. Doubles as the Auth.js adapter's user table,
-- extended with org_id and role. role gates connector/credential editing (§4).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  -- Auth.js adapter columns
  email_verified timestamptz,
  image          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,

  -- Auth.js normalises the sign-in identifier to a trimmed, lower-cased
  -- address before any lookup, and @auth/drizzle-adapter then matches on
  -- users.email EXACTLY. A row stored as 'Priya@Agency.com' would be invisible
  -- to that lookup, so Auth.js would try to create a second user — which fails
  -- on org_id NOT NULL and locks the person out with an opaque error. Storing
  -- only the normalised form makes the two agree by construction.
  CONSTRAINT users_email_is_normalised CHECK (email = lower(btrim(email)))
);

CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_org_id_idx ON users (org_id);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Auth.js adapter tables. Shapes are dictated by @auth/drizzle-adapter.
-- accounts is unused by the magic-link flow but the adapter contract requires it.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                text NOT NULL,
  provider            text NOT NULL,
  provider_account_id text NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          integer,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  PRIMARY KEY (provider, provider_account_id)
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE sessions (
  session_token text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires       timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Magic-link tokens. Rows here are short-lived credentials: never log them.
CREATE TABLE verification_tokens (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- ---------------------------------------------------------------------------
-- audit_log — every state change that touches a person outside the company (§4).
-- actor is a users.id or the literal string 'agent', so it is text, not a FK.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor        text NOT NULL,
  action       text NOT NULL,
  subject_type text,
  subject_id   uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id);
