-- 0029: where an address came from, and a connector that refused.
--
-- WHERE AN ADDRESS CAME FROM. The assistant stored addresses nobody had
-- shown it: emails composed from a first name and the company's domain
-- (akash@…, info@…) after a search returned only profiles, and whole people
-- invented to "test the features" — and an opener was mailed to one of them.
-- The prompt already said never to invent one; a sentence did not hold. So
-- every email and phone a writer stores now carries WHERE IT CAME FROM, and a
-- person reads that beside the address on /contacts, the company page and
-- /approvals:
--
--   person            a teammate typed it (a form on /contacts or a company page)
--   import            a contacts CSV a teammate imported
--   inbound           a form the person filled in themselves (booking, the free check)
--   chat              the person the assistant was helping typed it in chat
--   connector:<name>  a connector's result the assistant was shown
--   http(s)://…       a page the address was seen on, read by this system
--
-- The shape is packages/core's ADDRESS_SOURCE_PATTERN, character for
-- character — `contact-sources.test.ts` reads this file and holds the two
-- equal. A Postgres regex bound is capped at 255, so a page's length is its
-- own CHECK rather than a `{1,2048}` in the pattern.
--
-- Both columns are NULLABLE and stay NULL on every row written before 0029:
-- "not recorded" is the truth about those, and calling them `person` would be
-- a claim. Nothing here requires a source — a CHECK is evaluated on every
-- later UPDATE of a row (0018's trap), so "a contact with an email must have a
-- source" would make every older contact un-updatable, its reply pause and
-- its bounce included. The writers stamp one; the pairing CHECKs only keep a
-- source from outliving its address, so every writer that changes or clears
-- an address changes or clears its source in the same UPDATE, as the bounce
-- mark is cleared today.
ALTER TABLE contacts
  ADD COLUMN email_source text,
  ADD COLUMN phone_source text,
  ADD CONSTRAINT contacts_email_source_is_known
    CHECK (email_source IS NULL OR (email_source ~ '^(person|import|inbound|chat|connector:[a-z0-9][a-z0-9-]*|https?://\S+)$' AND length(email_source) <= 2048)),
  ADD CONSTRAINT contacts_phone_source_is_known
    CHECK (phone_source IS NULL OR (phone_source ~ '^(person|import|inbound|chat|connector:[a-z0-9][a-z0-9-]*|https?://\S+)$' AND length(phone_source) <= 2048)),
  ADD CONSTRAINT contacts_email_source_needs_an_email CHECK (email_source IS NULL OR email IS NOT NULL),
  ADD CONSTRAINT contacts_phone_source_needs_a_phone CHECK (phone_source IS NULL OR phone IS NOT NULL);

-- A CONNECTOR THAT REFUSED. Test connection lists a server's tools and calls
-- none, so a keyless research server passes it and then refuses every real
-- call (401, "keyless access is unavailable", 429) — and the assistant kept
-- calling it. The worker now records the moment a connector refused a call
-- and the KIND of refusal, from its own fixed vocabulary — never the server's
-- text, which carries URLs and the query — beside `last_ok_at` and
-- `last_error`, which stay Test connection's. A later call that answers
-- clears it, and so does a new key or endpoint.
ALTER TABLE connectors
  ADD COLUMN last_failure_at timestamptz,
  ADD COLUMN last_failure_kind text,
  ADD CONSTRAINT connectors_failure_kind_is_known
    CHECK (last_failure_kind IS NULL OR last_failure_kind IN ('auth', 'quota')),
  ADD CONSTRAINT connectors_failure_has_its_time
    CHECK ((last_failure_at IS NULL) = (last_failure_kind IS NULL));
