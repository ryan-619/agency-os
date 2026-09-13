-- 0009_secrets_live_encrypted — a place for third-party credentials.
--
-- PROMPT.md §2.3: "Third-party credentials (Twilio, Apollo, SMTP, MCP server
-- tokens) live encrypted at rest in Postgres using a KMS key or a libsodium
-- sealed box with the master key in the environment. Decrypt at point of use
-- only."
--
-- `connectors.secret_ref` already exists and 0005 documents it as pointing at
-- an encrypted credential rather than holding one. This is the thing it points
-- at. Keeping it in a separate table rather than a jsonb field on `connectors`
-- is what makes that promise checkable: a connector row can be read, logged,
-- exported and shown in the UI in full, and it still contains no ciphertext and
-- no key — only an id.
--
-- The ciphertext column holds nonce, tag and body together, base64, produced by
-- AES-256-GCM under a master key that lives ONLY in the environment. The
-- database therefore never holds anything that decrypts itself: a dump of this
-- table without SECRETS_KEY is inert.

CREATE TABLE secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- What this credential is FOR, in words, so the settings screen can name it
  -- without decrypting anything. Never the value, never a fragment of it.
  label       text NOT NULL,
  -- nonce ‖ tag ‖ ciphertext, base64. Opaque to SQL on purpose.
  ciphertext  text NOT NULL,
  -- Which master key encrypted it. A rotation writes new rows under a new
  -- version and leaves the old ones readable until they are re-encrypted;
  -- without this, rotating the key silently bricks every stored credential.
  key_version integer NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,

  -- A label is how a person identifies a credential they cannot see. An empty
  -- one makes the settings screen a list of identical rows.
  CONSTRAINT secrets_label_is_not_blank CHECK (btrim(label) <> ''),
  -- Cheap shape check. Not proof of encryption — nothing in SQL can be — but
  -- it refuses an obviously-plaintext value written by a mistaken caller.
  CONSTRAINT secrets_ciphertext_looks_encrypted CHECK (length(ciphertext) >= 44)
);

CREATE INDEX secrets_org_idx ON secrets (org_id, created_at DESC);

CREATE TRIGGER secrets_set_updated_at BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Now that the target exists, make the pointer real.
--
-- 0005 declared secret_ref as `text` and documented it as pointing at an
-- encrypted credential, but nothing enforced that it pointed at anything: any
-- string was accepted, including — with grim irony — a credential pasted
-- directly into the column the comment says never holds one. The retype is
-- safe because nothing has ever written the column; if that stops being true,
-- this migration fails loudly on the cast rather than dropping data.
ALTER TABLE connectors
  ALTER COLUMN secret_ref TYPE uuid USING secret_ref::uuid;

-- RESTRICT, not CASCADE: deleting a credential a live connector still uses
-- should fail at the delete rather than silently leave a connector that cannot
-- authenticate and will not say why.
ALTER TABLE connectors
  ADD CONSTRAINT connectors_secret_ref_points_at_a_secret
  FOREIGN KEY (secret_ref) REFERENCES secrets(id) ON DELETE RESTRICT;
