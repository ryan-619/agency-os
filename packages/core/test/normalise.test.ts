/**
 * Normalisation, and the failures it must refuse to guess at (§2.1).
 *
 * A suppression check is one indexed equality lookup, so equality has to MEAN
 * equality. `Stop@Example.com ` and `stop@example.com` are one person who
 * asked once to be left alone.
 *
 * The tests that matter most are the ones where normalisation FAILS. CLAUDE.md
 * records why: "a suppression insert that fails is an opt-out that was never
 * recorded — worse than the bug this constraint replaced. When `normalise()`
 * cannot parse an inbound number or address, the send path must fail loudly
 * and route it to a human, and must never fall through to sending."
 *
 * So nothing here may return a best guess, and nothing may return the input
 * unchanged. `null` means "I do not know what this is".
 */
import { describe, it, expect } from 'vitest'
import {
  normaliseDomainValue, normaliseEmail, normalisePhone, normaliseSuppressionValue,
} from '../src/index.js'

describe('normaliseEmail', () => {
  it.each([
    ['Stop@Example.com', 'stop@example.com'],
    ['  priya@rentman.io  ', 'priya@rentman.io'],
    ['PRIYA@RENTMAN.IO', 'priya@rentman.io'],
    ['first.last+tag@sub.example.co.uk', 'first.last+tag@sub.example.co.uk'],
  ])('folds %j to %j', (raw, expected) => {
    expect(normaliseEmail(raw)).toBe(expected)
  })

  /**
   * The local part is case-SENSITIVE per RFC 5321, and this lower-cases it
   * anyway. A deliberate, documented divergence: no provider in use treats
   * `Stop@` and `stop@` as different mailboxes, and the failure mode of
   * respecting the RFC here is emailing someone who opted out. Suppressing
   * more is the only safe direction.
   */
  it('lower-cases the local part, against the RFC, on purpose', () => {
    expect(normaliseEmail('Stop@example.com')).toBe(normaliseEmail('stop@example.com'))
  })

  it.each([
    '',
    '   ',
    'not an email',
    'priya@',
    '@rentman.io',
    'priya@rentman',
    'priya rentman.io',
    'priya@rent man.io',
    'two@at@signs.com',
    'priya@.io',
    'priya@rentman.',
    'a@b.c,d@e.f',
    '<priya@rentman.io>',
    'Priya <priya@rentman.io>',
  ])('refuses %j rather than guessing', (raw) => {
    expect(normaliseEmail(raw)).toBeNull()
  })

  it('refuses an address longer than any provider accepts', () => {
    expect(normaliseEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
  })
})

describe('normaliseDomainValue', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['  rentman.io ', 'rentman.io'],
    ['www.rentman.io', 'rentman.io'],
    ['someone@rentman.io', 'rentman.io'],
    ['https://www.rentman.io/pricing?x=1', 'rentman.io'],
    ['rentman.io:443', 'rentman.io'],
    ['a.b.c.example.co.uk', 'a.b.c.example.co.uk'],
  ])('reduces %j to %j', (raw, expected) => {
    expect(normaliseDomainValue(raw)).toBe(expected)
  })

  it.each(['', '   ', 'localhost', 'not a domain', '.com', 'example.', '-bad.com', 'exa mple.com'])(
    'refuses %j',
    (raw) => {
      expect(normaliseDomainValue(raw)).toBeNull()
    },
  )
})

describe('normalisePhone', () => {
  /**
   * Every geography the seeded ICP targets, because CLAUDE.md commits to
   * exactly that and because a country whose numbers cannot be normalised is
   * a country whose opt-outs never match.
   */
  it.each([
    ['+1 (415) 555-0100', '+14155550100', 'United States'],
    ['+1-415-555-0100', '+14155550100', 'United States'],
    ['+44 20 7946 0958', '+442079460958', 'United Kingdom'],
    ['+353 1 234 5678', '+35312345678', 'Ireland'],
    ['+49 30 901820', '+4930901820', 'Germany'],
    ['+31 20 794 0000', '+31207940000', 'Netherlands'],
    ['+33 1 42 68 53 00', '+33142685300', 'France'],
    ['+46 8 508 000 00', '+46850800000', 'Sweden'],
    ['+91 22 2266 1700', '+912222661700', 'India'],
    ['+61 2 9374 4000', '+61293744000', 'Australia'],
  ])('normalises %j to %j (%s)', (raw, expected) => {
    expect(normalisePhone(raw)).toBe(expected)
  })

  it('accepts 00 as the international prefix, which most of the world dials', () => {
    expect(normalisePhone('0044 20 7946 0958')).toBe('+442079460958')
  })

  /**
   * THE refusal. A number with no country code cannot be normalised without
   * knowing where it came from, and the guess that feels obvious — assume the
   * agency's own country — is how a US opt-out is stored as a UK number and
   * never matches again.
   */
  it.each(['4155550100', '020 7946 0958', '(415) 555-0100', '555-0100'])(
    'refuses %j rather than guessing a country',
    (raw) => {
      expect(normalisePhone(raw)).toBeNull()
    },
  )

  /**
   * A vanity number cannot be dialled as written, and silently dropping the
   * letters produces a number that is not the one on the page.
   */
  it('refuses a vanity number rather than mangling it', () => {
    expect(normalisePhone('+1-800-FLOWERS')).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['+', 'just a plus'],
    ['+0123456789', 'a zero country digit'],
    ['+12345', 'too short for E.164'],
    ['+1234567890123456', 'too long for E.164'],
    ['+1 415 555 0100 ext 22', 'an extension'],
    ['tel:+14155550100', 'a URI'],
  ])('refuses %j (%s)', (raw) => {
    expect(normalisePhone(raw)).toBeNull()
  })
})

describe('normaliseSuppressionValue', () => {
  it('dispatches on kind', () => {
    expect(normaliseSuppressionValue('email', 'Stop@Example.com')).toBe('stop@example.com')
    expect(normaliseSuppressionValue('domain', 'WWW.Example.com')).toBe('example.com')
    expect(normaliseSuppressionValue('phone', '+1 415 555 0100')).toBe('+14155550100')
  })

  /**
   * A kind nobody has taught it about is not a value it can normalise.
   * Returning the input would write an unnormalised row — which the database
   * rejects, which is an opt-out that was never recorded.
   */
  it('refuses a kind it does not know, rather than passing the value through', () => {
    expect(normaliseSuppressionValue('linkedin' as never, 'https://linkedin.com/in/x')).toBeNull()
  })

  /**
   * Everything this returns must satisfy `suppressions_value_is_normalised`,
   * which is the constraint in 0003. Asserted here in the same shape the SQL
   * uses, so a change to either side shows up as a failure rather than as a
   * rejected insert in production.
   */
  it('produces values the database constraint accepts', () => {
    const email = normaliseSuppressionValue('email', '  Stop@Example.COM ')!
    const domain = normaliseSuppressionValue('domain', 'WWW.Example.com')!
    const phone = normaliseSuppressionValue('phone', '+1 (415) 555-0100')!
    expect(email).toBe(email.toLowerCase().trim())
    expect(domain).toBe(domain.toLowerCase().trim())
    expect(phone).toMatch(/^\+[1-9][0-9]{6,14}$/)
    for (const v of [email, domain, phone]) expect(v.length).toBeGreaterThan(0)
  })

  /**
   * Normalising twice must not change anything. Otherwise a re-import writes a
   * second row for the same person and the first one stops being consulted.
   */
  it('is idempotent', () => {
    for (const [kind, raw] of [
      ['email', 'Stop@Example.com'],
      ['domain', 'WWW.Example.com'],
      ['phone', '+1 (415) 555-0100'],
    ] as const) {
      const once = normaliseSuppressionValue(kind, raw)!
      expect(normaliseSuppressionValue(kind, once)).toBe(once)
    }
  })
})
