-- A LinkedIn profile can ask to be left alone (§2.1).
--
-- `suppressions.kind` held 'email', 'domain' and 'phone', so a LinkedIn
-- profile had no key: `suppressionKeysFor` returned an empty list, which
-- honestly meant "nothing to check" and dishonestly meant that somebody who
-- had told us to stop on LinkedIn could be messaged again the next day.
-- LinkedIn is one of the TWO cold channels §2.1 permits, so this was the one
-- channel where an opt-out could be asked for and not recorded.
--
-- The stored value is the profile's namespace and slug — `in/jane-doe` or
-- `company/acme` — lower-cased, with no scheme, host, query or trailing
-- slash. The namespace is kept because `in/acme` and `company/acme` are
-- different pages; normalising a bare handle to one of them would be a guess
-- that silently never matches.
ALTER TABLE suppressions DROP CONSTRAINT suppressions_kind_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_kind_check
  CHECK (kind IN ('email', 'domain', 'phone', 'linkedin'));

ALTER TABLE suppressions DROP CONSTRAINT suppressions_value_is_normalised;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_value_is_normalised CHECK (
  CASE kind
    -- E.164: a leading +, a non-zero country digit, 7-15 digits total.
    WHEN 'phone' THEN value ~ '^\+[1-9][0-9]{6,14}$'
    -- The same shape `normaliseLinkedIn()` produces, so a value that did not
    -- come through it cannot be stored.
    WHEN 'linkedin' THEN value ~ '^(in|company)/[a-z0-9._%~-]+$'
    -- Email and domain are case-insensitive in practice; store them folded
    -- and untrimmed-free so equality means equality.
    ELSE value = lower(btrim(value)) AND length(value) > 0
  END
);
