-- 0005_agent_runtime — the runtime MCP connector registry, subagents as data,
-- and the chat transcript the product is built around.

-- ---------------------------------------------------------------------------
-- connectors — MCP servers addable from inside the app, no redeploy (§6).
-- secret_ref points at the encrypted credential; the ciphertext itself never
-- lives in config, and nothing here is ever handed to the agent (§2.3).
-- ---------------------------------------------------------------------------
CREATE TABLE connectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('stdio', 'http', 'sse')),
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref  text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  last_ok_at  timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,

  -- The MCP tool namespace is mcp__<server-name>__<tool-name>; a name with
  -- underscores or spaces makes allowedTools wildcards ambiguous.
  CONSTRAINT connectors_name_is_a_valid_mcp_server_name
    CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

CREATE UNIQUE INDEX connectors_org_name_key ON connectors (org_id, name);
CREATE INDEX connectors_org_enabled_idx ON connectors (org_id, enabled);
CREATE TRIGGER connectors_set_updated_at BEFORE UPDATE ON connectors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- agent_defs — subagents as data, mapped onto the SDK's `agents` option (§7).
-- §4 says `slug unique`; scoped to (org_id, slug) for the same reason as
-- companies.domain. Flagged in CLAUDE.md.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_defs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL,
  system_prompt text NOT NULL,
  tools         text[] NOT NULL DEFAULT '{}',
  model         text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,

  -- The slug becomes the key of the SDK `agents` record and is what the model
  -- names when delegating.
  CONSTRAINT agent_defs_slug_is_kebab_case
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

CREATE UNIQUE INDEX agent_defs_org_slug_key ON agent_defs (org_id, slug);
CREATE TRIGGER agent_defs_set_updated_at BEFORE UPDATE ON agent_defs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- chat_sessions / chat_messages
-- sdk_session_id is the id returned on the SDK's final `result` message and is
-- what a later request passes back as `resume` (§5.3).
-- ---------------------------------------------------------------------------
CREATE TABLE chat_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sdk_session_id text,
  title          text,
  archived       boolean NOT NULL DEFAULT false,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

CREATE INDEX chat_sessions_user_active_idx
  ON chat_sessions (user_id, last_active_at DESC) WHERE NOT archived;
CREATE INDEX chat_sessions_sdk_id_idx ON chat_sessions (sdk_session_id)
  WHERE sdk_session_id IS NOT NULL;
CREATE TRIGGER chat_sessions_set_updated_at BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content    jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_name  text,
  tokens_in  integer,
  tokens_out integer,
  cost_usd   numeric(12, 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX chat_messages_session_created_idx ON chat_messages (session_id, created_at);
CREATE TRIGGER chat_messages_set_updated_at BEFORE UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
