/**
 * The single send path (PROMPT.md §8.4), and §2.1's four rules.
 *
 * §9's Definition of Done for Phase 4 asks for "a test proving a send is
 * refused when suppression, consent, quiet hours, or cap would be violated —
 * one test per rule". This file is that, and then the cases that are actually
 * hard: the order the rules fire in, midnight-wrapping quiet windows, a
 * recipient nobody can parse, and every way "we do not know" could be mistaken
 * for "go ahead".
 *
 * These are the tests where a bug becomes a legal problem, so they are written
 * to fail loudly rather than to be convenient.
 */
import { describe, it, expect } from 'vitest'
import {
  COLD_CHANNELS, OPT_IN_ONLY_CHANNELS, decideSend, isQuiet, localMinutes, suppressionKeysFor,
  type Channel, type SendFacts,
} from '../src/index.js'

/** Midday UTC on a Tuesday, which is midday in London and 08:00 in New York. */
const NOON_UTC = new Date('2026-09-15T12:00:00.000Z')

function facts(over: Partial<SendFacts> = {}): SendFacts {
  return {
    channel: 'email',
    recipient: 'priya@rentman.io',
    suppressed: false,
    consent: null,
    recipientTimeZone: 'Europe/London',
    quietStart: '21:00',
    quietEnd: '08:00',
    sentToday: 0,
    dailyCap: 25,
    campaignStatus: 'active',
    autoSend: true,
    now: NOON_UTC,
    ...over,
  }
}

describe('the happy path', () => {
  it('allows a cold email inside working hours, under the cap, with auto-send', () => {
    expect(decideSend(facts())).toEqual({ allowed: true, code: 'send_now' })
  })

  /**
   * Cold email and LinkedIn do not need a prior opt-in — that is exactly what
   * makes them the cold channels (§2.1). A rule that demanded consent here
   * would make the product unable to do the thing it is for.
   */
  it('does not require a recorded opt-in for a cold email', () => {
    expect(decideSend(facts({ consent: null })).allowed).toBe(true)
  })

  it('allows LinkedIn on the same terms', () => {
    // The recipient is the profile, which is what `recipientFor` passes —
    // since 0016 an email address in that field is a data error rather than
    // something that sails through because the channel had no keys.
    expect(decideSend(facts({ channel: 'linkedin', recipient: 'linkedin.com/in/priya' })).allowed).toBe(true)
  })
})

describe('§2.1 rule 1 — suppression wins over everything', () => {
  it('refuses a suppressed recipient', () => {
    const d = decideSend(facts({ suppressed: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('suppressed')
  })

  /**
   * A suppression is somebody asking to be left alone. Offering it to an
   * approver turns a legal obligation into a habit of clicking yes.
   */
  it('does not let a human approve past it', () => {
    const d = decideSend(facts({ suppressed: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.humanCanResolve).toBe(false)
  })

  it('beats a granted consent, because the opt-out is the later statement', () => {
    const d = decideSend(facts({ suppressed: true, consent: { granted: true, source: 'webform' } }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('suppressed')
  })

  /**
   * An email is suppressed by its ADDRESS and by its DOMAIN. A caller that
   * looked up only the address would send to `priya@` after someone
   * suppressed the whole company.
   */
  it('produces both an address key and a domain key for an email', () => {
    expect(suppressionKeysFor('Priya@Rentman.IO', 'email')).toEqual([
      { kind: 'email', value: 'priya@rentman.io' },
      { kind: 'domain', value: 'rentman.io' },
    ])
  })

  it('produces a phone key for the opt-in channels', () => {
    for (const channel of ['sms', 'voice', 'whatsapp'] as const) {
      expect(suppressionKeysFor('+1 (415) 555-0100', channel)).toEqual([
        { kind: 'phone', value: '+14155550100' },
      ])
    }
  })

  /**
   * LinkedIn, since 0016. This used to return an empty list — "nothing to
   * check" — which was honest about the schema and wrong about the product:
   * LinkedIn is one of the two channels §2.1 lets us contact a stranger on,
   * so it was the ONE channel where somebody could ask to be left alone and
   * have nowhere to record it.
   */
  it('reads a LinkedIn profile however it was pasted', () => {
    for (const form of [
      'https://www.linkedin.com/in/priya',
      'https://linkedin.com/in/priya/',
      'http://uk.linkedin.com/in/priya?trk=nav',
      'linkedin.com/in/PRIYA',
      '/in/priya',
      'in/priya',
    ]) {
      expect(suppressionKeysFor(form, 'linkedin'), form).toEqual([{ kind: 'linkedin', value: 'in/priya' }])
    }
  })

  /**
   * The first version matched the slug with an UNANCHORED character class
   * and returned whatever prefix matched. A profile pasted as
   * `linkedin.com/in/josé-garcía` became `in/jos` — which matches nobody, so
   * an opt-out was recorded against nothing; and if some other real profile
   * IS `in/jos`, it suppressed the wrong person while the one who asked kept
   * being contacted. Found by probing inputs no test covered.
   */
  it('does not truncate a slug at the first character it does not recognise', () => {
    const key = suppressionKeysFor('https://www.linkedin.com/in/josé-garcía', 'linkedin')
    expect(key).toEqual([{ kind: 'linkedin', value: 'in/jos%c3%a9-garc%c3%ada' }])
    expect(key![0]!.value).not.toBe('in/jos')
  })

  /**
   * One person, one key. The address bar gives the percent-encoded form and a
   * rendered page gives the unicode; both are the same profile, so both have
   * to reach the same row or the second one silently creates a duplicate that
   * the first suppression never matches.
   */
  it('gives the encoded and the unicode spelling of one profile the same key', () => {
    const encoded = suppressionKeysFor('linkedin.com/in/jos%C3%A9-garc%C3%ADa', 'linkedin')
    const unicode = suppressionKeysFor('linkedin.com/in/josé-garcía', 'linkedin')
    expect(encoded).toEqual(unicode)
    expect(suppressionKeysFor('linkedin.com/in/андрей', 'linkedin'))
      .toEqual([{ kind: 'linkedin', value: 'in/%d0%b0%d0%bd%d0%b4%d1%80%d0%b5%d0%b9' }])
  })

  /** A sub-page belongs to the profile it hangs off. */
  it('drops a sub-page without dropping any of the slug', () => {
    expect(suppressionKeysFor('linkedin.com/in/priya/detail/recent-activity', 'linkedin'))
      .toEqual([{ kind: 'linkedin', value: 'in/priya' }])
  })

  /**
   * The legacy public-profile URL. Mapping `pub/priya/1/2/3` to a modern
   * slug would be a guess, and a guessed key never matches.
   */
  it('refuses a legacy /pub/ URL rather than guessing the modern slug', () => {
    expect(suppressionKeysFor('linkedin.com/pub/priya/1/2/3', 'linkedin')).toBeNull()
  })

  /** `in/acme` and `company/acme` are different pages. */
  it('keeps the namespace, so a person and a company are not the same key', () => {
    expect(suppressionKeysFor('linkedin.com/company/acme', 'linkedin'))
      .toEqual([{ kind: 'linkedin', value: 'company/acme' }])
    expect(suppressionKeysFor('linkedin.com/in/acme', 'linkedin'))
      .toEqual([{ kind: 'linkedin', value: 'in/acme' }])
  })

  /**
   * A bare handle is refused rather than guessed at. Guessing picks a
   * namespace, and the wrong one stores a key that never matches the person
   * who asked — which is worse than a visible refusal.
   */
  it('refuses a bare handle, and the send path refuses with it', () => {
    expect(suppressionKeysFor('priya', 'linkedin')).toBeNull()
    const d = decideSend(facts({ channel: 'linkedin', recipient: 'priya' }))
    expect(d.allowed).toBe(false)
    expect(d.allowed === false && d.code).toBe('unparseable_recipient')
  })
})

describe('a recipient nobody can parse', () => {
  /**
   * CLAUDE.md's stated obligation: "When `normalise()` cannot parse an inbound
   * number or address, the send path must fail loudly and route it to a human,
   * and must never fall through to sending."
   *
   * The reasoning matters more than the rule. If the address cannot be
   * normalised then NO suppression row could ever have matched it — so
   * `suppressed: false` means "unknown", not "clear".
   */
  it.each([
    'not an email',
    '',
    '   ',
    'priya@',
    '@rentman.io',
    'priya@rentman',
    'priya rentman.io',
    'priya@rent man.io',
  ])('refuses %j rather than treating it as unsuppressed', (recipient) => {
    const d = decideSend(facts({ recipient }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('unparseable_recipient')
    expect(d.humanCanResolve).toBe(true)
  })

  it('refuses an unparseable phone on an opt-in channel that has consent', () => {
    const d = decideSend(
      facts({ channel: 'sms', recipient: '555-0100', consent: { granted: true, source: 'webform' } }),
    )
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('unparseable_recipient')
  })
})

describe('§2.1 rule 2 — consent, where absence means no', () => {
  it.each(['sms', 'voice', 'whatsapp'] as const)(
    'refuses a cold %s outright, with nobody able to approve it',
    (channel) => {
      const d = decideSend(facts({ channel, recipient: '+14155550100', consent: null }))
      expect(d.allowed).toBe(false)
      if (d.allowed) return
      expect(d.code).toBe('cold_channel_forbidden')
      // §2.1: "structurally impossible". A human who could approve it would
      // make it possible.
      expect(d.humanCanResolve).toBe(false)
    },
  )

  it.each(['sms', 'voice', 'whatsapp'] as const)(
    'allows %s once an opt-in is recorded',
    (channel) => {
      const d = decideSend(
        facts({
          channel,
          recipient: '+14155550100',
          consent: { granted: true, source: 'signup form 2026-03-01' },
          recipientTimeZone: 'America/New_York',
          now: new Date('2026-09-15T18:00:00.000Z'), // 14:00 in New York.
        }),
      )
      expect(d.allowed).toBe(true)
    },
  )

  /**
   * A recorded refusal is different from no record, and it stops the cold
   * channels too. Someone who replied "stop emailing me" said so.
   */
  it('refuses a channel the contact has declined, even a cold one', () => {
    const d = decideSend(facts({ consent: { granted: false, source: 'reply 2026-08-02' } }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('consent_revoked')
    expect(d.humanCanResolve).toBe(false)
    expect(d.reason).toContain('reply 2026-08-02')
  })

  it('keeps the cold and opt-in channel sets disjoint and complete', () => {
    const all: Channel[] = ['email', 'linkedin', 'sms', 'voice', 'whatsapp']
    for (const c of all) {
      expect(COLD_CHANNELS.has(c) !== OPT_IN_ONLY_CHANNELS.has(c), c).toBe(true)
    }
  })
})

describe('§2.1 rule 3 — quiet hours, in the RECIPIENT’s timezone', () => {
  /**
   * The rule that is easiest to get subtly wrong, because it looks right from
   * the sender's desk. 02:00 UTC is a civil hour in London and the middle of
   * the night in New York; the same instant must be refused for one and
   * allowed for the other.
   */
  it('refuses at 02:00 local for the recipient, not for the sender', () => {
    const at = new Date('2026-09-15T06:00:00.000Z') // 02:00 New York, 07:00 London.
    const ny = decideSend(facts({ now: at, recipientTimeZone: 'America/New_York' }))
    expect(ny.allowed).toBe(false)
    if (!ny.allowed) expect(ny.code).toBe('quiet_hours')

    // Same instant, a recipient in Kolkata: 11:30 local, well inside the day.
    expect(decideSend(facts({ now: at, recipientTimeZone: 'Asia/Kolkata' })).allowed).toBe(true)
  })

  /**
   * The default window wraps midnight. A naive `start <= t && t < end` is not
   * merely wrong here — it is INVERTED, treating the whole working day as
   * quiet and every night as sendable.
   */
  it('handles a window that wraps midnight', () => {
    expect(isQuiet(22 * 60, '21:00', '08:00')).toBe(true) // 22:00
    expect(isQuiet(3 * 60, '21:00', '08:00')).toBe(true) // 03:00
    expect(isQuiet(7 * 60 + 59, '21:00', '08:00')).toBe(true) // 07:59
    expect(isQuiet(8 * 60, '21:00', '08:00')).toBe(false) // 08:00 exactly
    expect(isQuiet(12 * 60, '21:00', '08:00')).toBe(false) // midday
    expect(isQuiet(20 * 60 + 59, '21:00', '08:00')).toBe(false) // 20:59
    expect(isQuiet(21 * 60, '21:00', '08:00')).toBe(true) // 21:00 exactly
  })

  it('handles a window that does not wrap', () => {
    expect(isQuiet(3 * 60, '01:00', '06:00')).toBe(true)
    expect(isQuiet(12 * 60, '01:00', '06:00')).toBe(false)
    expect(isQuiet(0, '01:00', '06:00')).toBe(false)
  })

  it('treats a zero-length window as no quiet hours at all', () => {
    expect(isQuiet(3 * 60, '00:00', '00:00')).toBe(false)
  })

  /**
   * A configuration error must stall the campaign visibly, not send at 3am.
   * "I do not know when I may send" reads as "not now".
   */
  it.each([['25:00', '08:00'], ['21:00', '99:99'], ['', '08:00'], ['nine', 'five']])(
    'treats the unparseable window %j–%j as always quiet',
    (start, end) => {
      expect(isQuiet(12 * 60, start, end)).toBe(true)
    },
  )

  it('accepts the HH:MM:SS that Postgres `time` renders', () => {
    expect(isQuiet(22 * 60, '21:00:00', '08:00:00')).toBe(true)
    expect(isQuiet(12 * 60, '21:00:00', '08:00:00')).toBe(false)
  })

  /**
   * Not knowing where someone is is a reason to WAIT, not a reason to send.
   * The obvious shortcut — fall back to the sender's zone — is the exact
   * mistake §2.1 names.
   */
  it('refuses when the recipient has no timezone', () => {
    const d = decideSend(facts({ recipientTimeZone: null }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('unknown_timezone')
    expect(d.humanCanResolve).toBe(true)
  })

  it('refuses a timezone that is not real, rather than throwing', () => {
    const d = decideSend(facts({ recipientTimeZone: 'Mars/Olympus_Mons' }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('unknown_timezone')
  })

  it('reads the local clock from a real IANA zone', () => {
    expect(localMinutes(NOON_UTC, 'UTC')).toBe(12 * 60)
    expect(localMinutes(NOON_UTC, 'Asia/Kolkata')).toBe(17 * 60 + 30) // +05:30
    expect(localMinutes(NOON_UTC, 'America/New_York')).toBe(8 * 60) // DST
    expect(localMinutes(NOON_UTC, 'Not/AZone')).toBeNull()
  })

  /**
   * A half-hour offset is where an integer-hours shortcut breaks, and India is
   * in the seeded ICP's geography.
   */
  it('is right for a half-hour offset', () => {
    // 16:45 UTC is 22:15 in Kolkata — inside a 21:00–08:00 window.
    const d = decideSend(facts({ now: new Date('2026-09-15T16:45:00.000Z'), recipientTimeZone: 'Asia/Kolkata' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('quiet_hours')
  })
})

describe('§2.1 rule 4 — the daily cap', () => {
  it('refuses once the campaign has sent its quota', () => {
    const d = decideSend(facts({ sentToday: 25, dailyCap: 25 }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('daily_cap')
  })

  it('allows the last one under the cap', () => {
    expect(decideSend(facts({ sentToday: 24, dailyCap: 25 })).allowed).toBe(true)
  })

  it('refuses past the cap, not only exactly at it', () => {
    const d = decideSend(facts({ sentToday: 40, dailyCap: 25 }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('daily_cap')
  })

  it('refuses everything at a cap of zero, which is how a campaign is paused', () => {
    const d = decideSend(facts({ sentToday: 0, dailyCap: 0 }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('daily_cap')
  })
})

describe('the campaign’s own status', () => {
  /**
   * Found by review: the campaign form offered draft / active / paused / done
   * and the send path read none of them — a paused campaign kept sending.
   * Only `active` sends. A pause is a deferral, not a death: the sender puts
   * the message back and tries again after the campaign is reactivated.
   */
  it.each(['draft', 'paused', 'done'] as const)('refuses to send from a %s campaign', (campaignStatus) => {
    const d = decideSend(facts({ campaignStatus }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('campaign_inactive')
    expect(d.humanCanResolve).toBe(true)
    expect(d.reason).toContain(campaignStatus)
  })

  it('sends from an active one', () => {
    expect(decideSend(facts({ campaignStatus: 'active' })).allowed).toBe(true)
  })

  /**
   * After the per-person rules — a suppressed recipient in a paused campaign
   * is logged as suppressed, which is the reason that matters — and before
   * the approval gate, so nobody is asked to approve what will not send.
   */
  it('reports the person’s rule first, and the campaign before the gate', () => {
    const suppressed = decideSend(facts({ campaignStatus: 'paused', suppressed: true }))
    expect(suppressed.allowed).toBe(false)
    if (!suppressed.allowed) expect(suppressed.code).toBe('suppressed')
    const paused = decideSend(facts({ campaignStatus: 'paused', autoSend: false }))
    expect(paused.allowed).toBe(false)
    if (!paused.allowed) expect(paused.code).toBe('campaign_inactive')
  })
})

describe('§2.4 — the approval gate is the default', () => {
  it('queues for a human when the campaign has no auto-send', () => {
    const d = decideSend(facts({ autoSend: false }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('needs_approval')
    expect(d.humanCanResolve).toBe(true)
  })

  /**
   * A person who has read this message and said yes satisfies the gate the
   * same way auto-send does — and ONLY the gate. The human decided the message
   * was right, not that the recipient had not opted out in the hour since.
   */
  it('lets a human-approved message through a campaign without auto-send', () => {
    expect(decideSend(facts({ autoSend: false, approvedByHuman: true }))).toEqual({
      allowed: true,
      code: 'send_now',
    })
  })

  it.each([
    ['suppression', { suppressed: true }, 'suppressed'],
    ['a declined channel', { consent: { granted: false, source: 'reply' } }, 'consent_revoked'],
    ['quiet hours', { now: new Date('2026-09-15T22:30:00.000Z') }, 'quiet_hours'],
    ['the daily cap', { sentToday: 25 }, 'daily_cap'],
    ['an unknown timezone', { recipientTimeZone: null }, 'unknown_timezone'],
  ])('does not let a human approval past %s either', (_label, over, code) => {
    const d = decideSend(facts({ autoSend: false, approvedByHuman: true, ...over }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe(code)
  })

  /**
   * Auto-send is the ONLY check it skips. A campaign with auto-send on is
   * still subject to every §2.1 rule — that switch is about who decides, not
   * about which rules apply.
   */
  it.each([
    ['suppression', { suppressed: true }, 'suppressed'],
    ['a declined channel', { consent: { granted: false, source: 'reply' } }, 'consent_revoked'],
    ['quiet hours', { now: new Date('2026-09-15T22:30:00.000Z') }, 'quiet_hours'],
    ['the daily cap', { sentToday: 25 }, 'daily_cap'],
  ])('does not let auto-send past %s', (_label, over, code) => {
    const d = decideSend(facts({ autoSend: true, ...over }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe(code)
  })
})

describe('the ORDER the rules fire in', () => {
  /**
   * §8.4 fixes the order, and the order is not cosmetic: the refusal code is
   * what gets logged and what someone reads six months later. "Refused: over
   * the daily cap" about a person who had opted out is a wrong answer to a
   * question that matters.
   */
  it('reports suppression even when every other rule is also violated', () => {
    const d = decideSend(
      facts({
        suppressed: true,
        consent: { granted: false, source: 'reply' },
        now: new Date('2026-09-15T23:00:00.000Z'),
        sentToday: 99,
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('suppressed')
  })

  it('reports consent before quiet hours, the cap, and approval', () => {
    const d = decideSend(
      facts({
        consent: { granted: false, source: 'reply' },
        now: new Date('2026-09-15T23:00:00.000Z'),
        sentToday: 99,
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('consent_revoked')
  })

  it('reports quiet hours before the cap and approval', () => {
    const d = decideSend(
      facts({ now: new Date('2026-09-15T23:00:00.000Z'), sentToday: 99, autoSend: false }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('quiet_hours')
  })

  it('reports the cap before approval', () => {
    const d = decideSend(facts({ sentToday: 99, autoSend: false }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('daily_cap')
  })

  it('reports an unparseable recipient before anything it could not have checked', () => {
    const d = decideSend(facts({ recipient: 'nope', sentToday: 99, autoSend: false }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('unparseable_recipient')
  })
})

describe('what a refusal says', () => {
  /**
   * §2.3: logs never carry message bodies, and a refusal is logged. The reason
   * names the RULE and what to do about it, never the content.
   */
  it('always says what happened and what was not done', () => {
    const cases: SendFacts[] = [
      facts({ suppressed: true }),
      facts({ consent: { granted: false, source: 'reply' } }),
      facts({ recipientTimeZone: null }),
      facts({ now: new Date('2026-09-15T23:00:00.000Z') }),
      facts({ sentToday: 99 }),
      facts({ autoSend: false }),
      facts({ recipient: 'nope' }),
      facts({ channel: 'sms', recipient: '+14155550100' }),
    ]
    for (const f of cases) {
      const d = decideSend(f)
      expect(d.allowed).toBe(false)
      if (d.allowed) continue
      expect(d.reason.length, d.code).toBeGreaterThan(30)
      expect(d.reason, d.code).toMatch(/[.]$/)
      expect(d.reason, d.code).not.toContain(f.recipient)
    }
  })

  it('says plainly which refusals nobody can approve past', () => {
    const noOverride = ['suppressed', 'consent_revoked', 'cold_channel_forbidden']
    for (const f of [
      facts({ suppressed: true }),
      facts({ consent: { granted: false, source: 'reply' } }),
      facts({ channel: 'voice', recipient: '+14155550100' }),
    ]) {
      const d = decideSend(f)
      expect(d.allowed).toBe(false)
      if (d.allowed) continue
      expect(noOverride).toContain(d.code)
      expect(d.humanCanResolve).toBe(false)
    }
  })
})
