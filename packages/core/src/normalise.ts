/**
 * Turning an address or a number into the one form the suppression table
 * stores (PROMPT.md §2.1).
 *
 * "A `suppression` table wins over everything. One row there and no channel
 * may ever contact that address, number, or domain again. Check it in the send
 * path, not the campaign builder."
 *
 * A suppression check is one indexed equality lookup, so equality has to MEAN
 * equality — `Stop@Example.com ` and `stop@example.com` are one person who
 * asked once to be left alone, and a lookup that treats them as two rows
 * contacts them again. `suppressions_value_is_normalised` makes the shape a
 * database constraint rather than a convention; this is the same rule stated
 * where the send path can use it.
 *
 * ## Every function here can FAIL, and that is the point
 *
 * CLAUDE.md records the obligation this module was written to meet:
 *
 * > A suppression insert that fails is an opt-out that was never recorded —
 * > worse than the bug this constraint replaced. When `normalise()` cannot
 * > parse an inbound number or address, the send path must fail loudly and
 * > route it to a human, and must never fall through to sending.
 *
 * So nothing here returns a best guess, and nothing returns the input
 * unchanged when it cannot be understood. A `null` means "I do not know what
 * this is", and the send path treats that as a refusal — because the
 * alternative is contacting someone whose opt-out could not be matched.
 *
 * No I/O, no zod, no environment. `packages/core/test/no-io.test.ts` enforces
 * that by reading this file.
 */

export type SuppressionKind = 'email' | 'domain' | 'phone' | 'linkedin'

/**
 * An email address, folded to the form the table stores.
 *
 * The local part of an address is CASE-SENSITIVE per RFC 5321, and this
 * lower-cases it anyway. That is a deliberate, documented divergence from the
 * standard, and it is the right one here: no mail provider in use treats
 * `Stop@` and `stop@` as different mailboxes, and the failure mode of
 * respecting the RFC is emailing someone who opted out. Erring toward
 * suppressing more is the only direction that is safe.
 */
export function normaliseEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  // Deliberately strict rather than RFC-complete. A pattern that accepts
  // everything the RFC allows also accepts things no provider will deliver to,
  // and every one of those becomes a suppression row that never matches.
  if (!/^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/.test(trimmed)) return null
  if (trimmed.length > 254) return null
  return trimmed
}

/**
 * The domain part of an address, or a bare domain.
 *
 * Suppressing a domain is how "never contact anyone at this company again"
 * is recorded, so this accepts both `example.com` and `someone@example.com`
 * and answers with the domain either way.
 */
export function normaliseDomainValue(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null
  const at = value.lastIndexOf('@')
  if (at !== -1) value = value.slice(at + 1)
  // A URL pasted into the field, which happens.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0] ?? ''
  value = value.split(':')[0] ?? ''
  if (value.startsWith('www.')) value = value.slice(4)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null
  if (value.length > 253) return null
  return value
}

/**
 * A phone number in E.164, which is the only form the table accepts.
 *
 * This does NOT guess a country. A number with no `+` and no country code
 * cannot be normalised without knowing where it came from, and the guess that
 * feels obvious — assume the agency's own country — is how a US opt-out ends
 * up stored as a UK number and never matches again.
 *
 * §2.1 makes this less painful than it sounds: cold voice and SMS do not exist
 * in this product, so a phone number reaches the send path only for a contact
 * who gave an explicit opt-in, and an opt-in flow can ask for the country.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // `00` is the international prefix in most of the world and means the same
  // thing as `+`. Anything else without a `+` is ambiguous and refused.
  let rest: string
  if (trimmed.startsWith('+')) rest = trimmed.slice(1)
  else if (trimmed.startsWith('00')) rest = trimmed.slice(2)
  else return null

  // Spaces, hyphens, brackets and dots are formatting. A letter is not: a
  // vanity number like +1-800-FLOWERS cannot be dialled as written, and
  // silently dropping the letters would produce a number that is not the one
  // on the page.
  if (/[^\d\s().-]/.test(rest)) return null
  const digits = rest.replace(/[\s().-]/g, '')

  // E.164: a non-zero country digit, then 7 to 15 digits in total. The same
  // rule `suppressions_value_is_normalised` enforces.
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null
  return `+${digits}`
}

/**
 * A LinkedIn profile, folded to the form the table stores.
 *
 * LinkedIn is one of the two cold channels §2.1 permits, which makes it the
 * one channel where somebody could ask to be left alone and have nowhere to
 * record it. The stored value is the namespace and the slug — `in/jane-doe`
 * or `company/acme` — because `in/acme` and `company/acme` are different
 * pages and collapsing them would suppress the wrong one.
 *
 * A BARE handle is refused on purpose. `jane-doe` could be either namespace,
 * and picking one would store a key that silently never matches the person
 * who asked — the exact failure this module exists to prevent. A refusal is
 * visible: the operator is told to paste the profile URL.
 */
export function normaliseLinkedIn(raw: string): string | null {
  let text = raw.trim().toLowerCase()
  if (!text) return null
  // A URL, with or without a scheme, with or without the host.
  text = text.replace(/^https?:\/\//, '')
  text = text.replace(/^([a-z]{2,3}\.)?linkedin\.com\//, '')
  text = text.replace(/^\/+/, '')
  // Everything after the slug is tracking, a sub-page or a locale switch.
  text = text.split(/[?#]/)[0] ?? ''
  text = text.replace(/\/+$/, '')

  const segments = text.split('/')
  const namespace = segments[0] ?? ''
  // school and showcase are real LinkedIn namespaces but not ones this
  // product messages, and the CHECK constraint does not accept them — so
  // they are refused here rather than stored and rejected by the database.
  // `pub/` is the legacy public-profile URL and is refused for the same
  // reason: mapping one to a modern slug would be a guess.
  if (namespace !== 'in' && namespace !== 'company') return null
  // Only the first segment after the namespace. Anything further is a
  // sub-page — /detail/recent-activity — and belongs to the same profile.
  const raw_slug = segments[1] ?? ''
  if (!raw_slug) return null

  /**
   * The slug is canonicalised through percent-encoding, and validated
   * WHOLE.
   *
   * The first version matched the slug with an unanchored character class
   * and returned whatever prefix matched, which silently truncated: a
   * profile pasted as `linkedin.com/in/josé-garcía` became `in/jos`. That
   * is the exact failure this module exists to prevent, twice over — the
   * key matches nobody, so an opt-out is recorded against nothing; and if
   * some other real profile IS `in/jos`, it suppresses the wrong person
   * while the one who asked keeps being contacted. It also meant the two
   * ways of writing one profile — the address bar's percent-encoded form
   * and the rendered unicode — produced different keys for one person.
   *
   * Decoding first and re-encoding after makes both forms land on the same
   * value. Anything still outside the stored class after that is REFUSED
   * rather than trimmed away, so the JS and the SQL CHECK accept exactly
   * the same set.
   */
  let slug = raw_slug
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // A stray `%` is not an escape sequence. Keep it; encoding below will
    // turn it into %25, which is lossless.
  }
  slug = encodeURIComponent(slug.toLowerCase()).toLowerCase()
  if (!/^[a-z0-9._%~-]+$/.test(slug)) return null
  return `${namespace}/${slug}`
}

/**
 * Normalise a value for the suppression table.
 *
 * The one entry point the send path and the suppression writer both use, so
 * neither can develop its own idea of what a value looks like — which is the
 * failure this whole module exists to prevent.
 */
export function normaliseSuppressionValue(kind: SuppressionKind, raw: string): string | null {
  switch (kind) {
    case 'email':
      return normaliseEmail(raw)
    case 'domain':
      return normaliseDomainValue(raw)
    case 'phone':
      return normalisePhone(raw)
    case 'linkedin':
      return normaliseLinkedIn(raw)
    default:
      // An unknown kind is not a value we can normalise, and guessing is how a
      // new channel silently stops being suppressible.
      return null
  }
}

/**
 * Every suppression key a recipient matches.
 *
 * An email address is suppressed by the address AND by its domain, so the send
 * path looks up both rather than the caller remembering to. Returned as pairs
 * so one `IN` query can answer all of them.
 */
export function suppressionKeysFor(
  recipient: string,
  channel: 'email' | 'linkedin' | 'sms' | 'voice' | 'whatsapp',
): readonly { kind: SuppressionKind; value: string }[] | null {
  if (channel === 'email') {
    const email = normaliseEmail(recipient)
    if (!email) return null
    const domain = normaliseDomainValue(email)
    // A parseable address always yields a domain; if it somehow does not, the
    // address alone is still a real key and better than refusing the send for
    // a reason nobody can act on.
    return domain
      ? [
          { kind: 'email', value: email },
          { kind: 'domain', value: domain },
        ]
      : [{ kind: 'email', value: email }]
  }

  if (channel === 'sms' || channel === 'voice' || channel === 'whatsapp') {
    const phone = normalisePhone(recipient)
    return phone ? [{ kind: 'phone', value: phone }] : null
  }

  // LinkedIn, since 0016. This used to return an empty list — "nothing to
  // check" — which was honest about the schema and wrong about the product:
  // LinkedIn is one of the two channels §2.1 lets us contact a stranger on,
  // so it was the one channel where an opt-out could be asked for and not
  // recorded. A profile that cannot be read is null, and the send path
  // refuses, because no row could ever have matched it.
  const profile = normaliseLinkedIn(recipient)
  return profile ? [{ kind: 'linkedin', value: profile }] : null
}
