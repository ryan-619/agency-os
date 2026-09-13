-- Revert 0009_secrets_live_encrypted.
--
-- Dropping the table destroys every stored credential. That is correct for a
-- down migration — the ciphertext is worthless without the master key anyway —
-- but it is not recoverable, so a rollback past this point means re-entering
-- every connector credential by hand.

ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_secret_ref_points_at_a_secret;
ALTER TABLE connectors ALTER COLUMN secret_ref TYPE text USING secret_ref::text;
DROP TRIGGER IF EXISTS secrets_set_updated_at ON secrets;
DROP INDEX IF EXISTS secrets_org_idx;
DROP TABLE IF EXISTS secrets;
