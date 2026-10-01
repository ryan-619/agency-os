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
  COLD_CHANNELS, OPT_IN_ONLY_CHANNELS, classifyReply, decideSend, isQuiet, localMinutes, pauseReasonClass,
  suppressionKeysFor,
  type Channel, type PauseReasonClass, type SendFacts,
} from '../src/index.js'

/** Midday UTC on a Tuesday, which is midday in London and 08:00 in New York. */
const NOON_UTC = new Date('2026-09-15T12:00:00.000Z')

function facts(over: Partial<SendFacts> = {}): SendFacts {
  return {
    channel: 'email',
    recipient: 'priya@rentman.io',
    suppressed: false,
    consent: null,
    paused: false,
    evidenceStale: false,
    template: null,
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
    'allows %s once an opt-in is recorded (and, on SMS and WhatsApp, the words are a registered template — 0019)',
    (channel) => {
      const d = decideSend(
        facts({
          channel,
          recipient: '+14155550100',
          consent: { granted: true, source: 'signup form 2026-03-01' },
          recipientTimeZone: 'America/New_York',
          now: new Date('2026-09-15T18:00:00.000Z'), // 14:00 in New York.
          template: channel === 'voice' ? null : { active: true, matches: true, category: channel === 'sms' ? 'service_explicit' : 'utility' },
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

/**
 * A paused contact (§8.4: a reply "pauses the sequence for that contact
 * immediately"; a teammate may pause somebody by hand). It used to be
 * modelled as a revoked consent, so every pause — a teammate's hold
 * included — was logged `consent_revoked`, which enrolment then read as the
 * person's own no and never drafted them again. Found by review. A pause is
 * its own fact and its own code now: nobody approves past it, and a person
 * lifts it — by answering the reply from /inbox or resuming them on
 * /contacts — which is a decision that is audited where it is made.
 */
describe('a paused contact', () => {
  it('is refused as paused, and nobody may approve past it', () => {
    const d = decideSend(facts({ paused: true, pausedFor: 'manual' }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('paused')
    expect(d.humanCanResolve).toBe(false)
    expect(d.reason).toMatch(/Nothing was sent/)
    expect(d.reason).toMatch(/approving does not lift a pause/i)
  })

  it('changes nothing when the contact is not paused', () => {
    expect(decideSend(facts({ paused: false }))).toEqual({ allowed: true, code: 'send_now' })
  })

  it('is not lifted by a person approving the words, nor by auto-send', () => {
    for (const over of [{ autoSend: false, approvedByHuman: true }, { autoSend: true }]) {
      const d = decideSend(facts({ paused: true, pausedFor: 'replied', ...over }))
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('paused')
    }
  })

  /**
   * A pause is not a refusal of the channel. A person with SMS consent
   * GRANTED who is paused is refused as paused — before, the pause stood in
   * for a revoked consent and read as a cold SMS.
   */
  it('is not read as a missing opt-in on an opt-in channel', () => {
    const d = decideSend(
      facts({ channel: 'sms', recipient: '+14155550100', consent: { granted: true, source: 'form' }, paused: true, pausedFor: 'manual' }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('paused')
  })

  /**
   * The sentence names the pause's CLASS and what lifts it — never the
   * reason's text, which can carry a teammate's address and the contact's
   * words, and is logged nowhere. An opt-out the system could not record,
   * and an erasure that did not finish, are never "resume them".
   */
  it('says what lifts each class of pause, and never suggests resuming an opt-out or an erasure', () => {
    const say = (pausedFor: PauseReasonClass | undefined): string => {
      const d = decideSend(facts({ paused: true, pausedFor }))
      if (d.allowed) throw new Error('allowed')
      expect(d.code).toBe('paused')
      expect(d.reason).toMatch(/Nothing was sent/)
      expect(d.reason).toMatch(/[.]$/)
      return d.reason
    }
    expect(say('replied')).toMatch(/replied/)
    expect(say('replied')).toMatch(/\/inbox/)
    expect(say('manual')).toMatch(/teammate/)
    expect(say('manual')).toMatch(/\/contacts/)
    expect(say('manual')).not.toMatch(/\/inbox/)
    for (const cls of ['opt_out_not_recorded', 'erasure'] as const) {
      expect(say(cls), cls).not.toMatch(/resum/i)
    }
    expect(say('opt_out_not_recorded')).toMatch(/record the opt-out by hand/i)
    expect(say('erasure')).toMatch(/complete the erasure/i)
    expect(say('unsubscribed')).toMatch(/unsubscribed/)
    // No class at all reads as the careful generic sentence.
    expect(say(undefined)).toMatch(/\/contacts/)
    expect(say('other')).toBe(say(undefined))
  })

  it('classes each writer’s reason by its shape', () => {
    expect(pauseReasonClass('replied 2026-09-15T12:00:00.000Z')).toBe('replied')
    expect(pauseReasonClass('replied on the phone (by sam@agency.test)')).toBe('manual')
    expect(pauseReasonClass('opt-out not recorded: reply 2026-09-15T12:00:00.000Z')).toBe('opt_out_not_recorded')
    expect(pauseReasonClass('erasure requested 2026-09-15; not completed (Error)')).toBe('erasure')
    expect(pauseReasonClass('unsubscribed 2026-09-15T11:00:00.000Z')).toBe('unsubscribed')
    expect(pauseReasonClass('')).toBe('other')
    expect(pauseReasonClass(null)).toBe('other')
  })
})

/**
 * A permanent bounce is evidence about an ADDRESS (0018's
 * `contacts.email_bounced_at`, read from a delivery report that named a
 * message this system sent). It is not a suppression — a typo is not a
 * request to be left alone — so it is its own fact and its own code, and a
 * person resolves it by correcting the address. Never by approving.
 */
describe('a bounced address', () => {
  it('is refused as bounced, and a person can resolve it', () => {
    const d = decideSend(facts({ recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('bounced')
    expect(d.humanCanResolve).toBe(true)
    // It says what the fix is, and that approving is not it.
    expect(d.reason).toMatch(/correct the address/i)
    expect(d.reason).toMatch(/approving does not/i)
  })

  /** Absent is false. Every caller written before the fact existed is unchanged. */
  it('changes nothing when the fact is absent or false', () => {
    expect(decideSend(facts())).toEqual({ allowed: true, code: 'send_now' })
    expect(decideSend(facts({ recipientBounced: false }))).toEqual({ allowed: true, code: 'send_now' })
  })

  it('is not lifted by a person approving the message', () => {
    const d = decideSend(facts({ recipientBounced: true, autoSend: false, approvedByHuman: true }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('bounced')
  })

  it('is not lifted by auto-send either', () => {
    const d = decideSend(facts({ recipientBounced: true, autoSend: true }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('bounced')
  })
})

/**
 * §2.2: "Findings older than 14 days are marked stale and must be
 * re-verified before appearing in any outbound draft." A draft quotes the
 * scan that was current when it was written, and a deferral can hold it for
 * weeks — so the send path asks, at the moment of sending, whether the
 * evidence behind the words is still fresh. Found by review: an auto-send
 * row held by the cap or a paused campaign went out quoting weeks-old
 * findings with nobody reading it.
 */
describe('stale evidence', () => {
  it('is refused as stale_evidence, and nobody may approve past it', () => {
    const d = decideSend(facts({ evidenceStale: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('stale_evidence')
    expect(d.humanCanResolve).toBe(false)
    // It names the rule and the fix — a re-scan and a new draft — and that
    // approving is not the fix.
    expect(d.reason).toMatch(/§2\.2/)
    expect(d.reason).toMatch(/re-scan the company, then draft the message again/i)
    expect(d.reason).toMatch(/approving does not make them current/i)
  })

  it('changes nothing when the evidence is fresh', () => {
    expect(decideSend(facts({ evidenceStale: false }))).toEqual({ allowed: true, code: 'send_now' })
  })

  it('is not lifted by a person approving the words, nor by auto-send', () => {
    for (const over of [{ autoSend: false, approvedByHuman: true }, { autoSend: true }]) {
      const d = decideSend(facts({ evidenceStale: true, ...over }))
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('stale_evidence')
    }
  })

  /**
   * Refused, never deferred: the clock steps come after it, so a stale
   * message is not held until morning to go staler — and the sender puts
   * back only what the clock or the campaign refused.
   */
  it('is refused before quiet hours, the cap and a paused campaign could defer it', () => {
    const d = decideSend(
      facts({
        evidenceStale: true,
        now: new Date('2026-09-15T23:00:00.000Z'),
        sentToday: 99,
        campaignStatus: 'paused',
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('stale_evidence')
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
    ['a bounced address', { recipientBounced: true }, 'bounced'],
    ['a declined channel', { consent: { granted: false, source: 'reply' } }, 'consent_revoked'],
    ['a paused contact', { paused: true, pausedFor: 'manual' as const }, 'paused'],
    ['stale evidence', { evidenceStale: true }, 'stale_evidence'],
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
    ['a bounced address', { recipientBounced: true }, 'bounced'],
    ['a declined channel', { consent: { granted: false, source: 'reply' } }, 'consent_revoked'],
    ['a paused contact', { paused: true, pausedFor: 'manual' as const }, 'paused'],
    ['stale evidence', { evidenceStale: true }, 'stale_evidence'],
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
        recipientBounced: true,
        evidenceStale: true,
        paused: true,
        consent: { granted: false, source: 'reply' },
        now: new Date('2026-09-15T23:00:00.000Z'),
        sentToday: 99,
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('suppressed')
  })

  /**
   * The bounce sits after every refusal nobody may approve past:
   * suppression, a recorded refusal, a pause and stale evidence. Those must
   * be what is logged — reported as `bounced`, a declined contact read as
   * resolvable, so /approvals enabled Approve and the inbox resumed them;
   * and a stale draft whose address bounced read as "fix this first", then
   * flipped to a blocked stale_evidence once the address was corrected.
   * Both found by review. Before the clock, because a message held until
   * morning would bounce all the same.
   */
  it('reports suppression before a bounce', () => {
    const d = decideSend(facts({ suppressed: true, recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('suppressed')
  })

  it('reports a recorded refusal before a bounce: refused AND bounced is consent_revoked', () => {
    const d = decideSend(facts({ consent: { granted: false, source: 'reply' }, recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('consent_revoked')
    expect(d.humanCanResolve).toBe(false)
  })

  it('reports a recorded refusal before a pause: refused AND paused is consent_revoked', () => {
    const d = decideSend(facts({ consent: { granted: false, source: 'said no on a call' }, paused: true, pausedFor: 'replied' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('consent_revoked')
  })

  it('reports suppression before a pause', () => {
    const d = decideSend(facts({ suppressed: true, paused: true, pausedFor: 'unsubscribed' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('suppressed')
  })

  it('reports a pause before stale evidence and a bounce: paused AND stale AND bounced is paused', () => {
    const d = decideSend(facts({ paused: true, pausedFor: 'manual', evidenceStale: true, recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('paused')
    expect(d.humanCanResolve).toBe(false)
  })

  it('reports stale evidence before a bounce: stale AND bounced is stale_evidence, which nobody may approve past', () => {
    const d = decideSend(facts({ evidenceStale: true, recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.code).toBe('stale_evidence')
    expect(d.humanCanResolve).toBe(false)
  })

  it('reports a bounce before quiet hours, the cap, the campaign and approval', () => {
    const d = decideSend(
      facts({
        recipientBounced: true,
        now: new Date('2026-09-15T23:00:00.000Z'),
        sentToday: 99,
        campaignStatus: 'paused',
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('bounced')
  })

  it('reports a recorded refusal before stale evidence', () => {
    const d = decideSend(facts({ consent: { granted: false, source: 'reply' }, evidenceStale: true }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('consent_revoked')
  })

  it('reports stale evidence before an unknown timezone, quiet hours, the cap, the campaign and approval', () => {
    const d = decideSend(
      facts({
        evidenceStale: true,
        recipientTimeZone: null,
        sentToday: 99,
        campaignStatus: 'paused',
        autoSend: false,
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('stale_evidence')
  })

  it('reports an unparseable recipient before a bounce it could not have matched', () => {
    const d = decideSend(facts({ recipient: 'nope', recipientBounced: true }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('unparseable_recipient')
  })

  /** And the whole order, in one table: each row violates its rule and every rule after it. */
  it('fires in exactly this order', () => {
    const midnightInLondon = new Date('2026-09-15T23:00:00.000Z')
    const steps: [Partial<SendFacts>, string][] = [
      [{ channel: 'sms', recipient: '+14155550100' }, 'cold_channel_forbidden'],
      [{ recipient: 'nope' }, 'unparseable_recipient'],
      [{ suppressed: true }, 'suppressed'],
      [{ consent: { granted: false, source: 'reply' } }, 'consent_revoked'],
      [{ paused: true, pausedFor: 'manual' }, 'paused'],
      [{ evidenceStale: true }, 'stale_evidence'],
      [{ recipientBounced: true }, 'bounced'],
      [{ recipientTimeZone: null }, 'unknown_timezone'],
      [{ now: midnightInLondon }, 'quiet_hours'],
      [{ sentToday: 99 }, 'daily_cap'],
      [{ campaignStatus: 'paused' }, 'campaign_inactive'],
      [{ autoSend: false }, 'needs_approval'],
    ]
    // Every rule from row i onwards is violated at once; row i must win.
    for (let i = 0; i < steps.length; i += 1) {
      const over = Object.assign({}, ...steps.slice(i).map(([o]) => o), steps[i]![0]) as Partial<SendFacts>
      const d = decideSend(facts(over))
      expect(d.allowed, steps[i]![1]).toBe(false)
      if (!d.allowed) expect(d.code, steps[i]![1]).toBe(steps[i]![1])
    }
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

  /**
   * 0019. On SMS the two template steps sit after the bounce and before the
   * clock, and a promotional SMS outside TRAI's band is the clock — deferred
   * as `quiet_hours`, after the campaign's own quiet hours. A recorded
   * refusal of SMS is `cold_channel_forbidden` (step 0 needs a GRANTED
   * opt-in), so `consent_revoked` has no row here.
   */
  it('fires in exactly this order on SMS, the template steps included', () => {
    const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
    const ELEVEN_PM_IST = new Date('2026-09-15T17:30:00.000Z')
    const NINE_AM_IST = new Date('2026-09-15T03:30:00.000Z')
    const sms = (over: Partial<SendFacts>): SendFacts =>
      facts({
        channel: 'sms',
        recipient: '+919876543210',
        consent: { granted: true, source: 'booking form' },
        recipientTimeZone: 'Asia/Kolkata',
        template: { active: true, matches: true, category: 'service_explicit' },
        now: NOON_IST,
        ...over,
      })
    const promo = { active: true, matches: true, category: 'promotional' as const }
    const steps: [Partial<SendFacts>, string, RegExp?][] = [
      [{ consent: null }, 'cold_channel_forbidden'],
      [{ recipient: 'nope' }, 'unparseable_recipient'],
      [{ suppressed: true }, 'suppressed'],
      [{ paused: true, pausedFor: 'manual' }, 'paused'],
      [{ evidenceStale: true }, 'stale_evidence'],
      [{ recipientBounced: true }, 'bounced'],
      [{ template: null }, 'no_template'],
      [{ template: { active: true, matches: false, category: 'promotional' } }, 'template_mismatch'],
      [{ recipientTimeZone: null }, 'unknown_timezone'],
      [{ now: ELEVEN_PM_IST, template: promo }, 'quiet_hours', /^It is currently quiet hours/],
      [{ now: NINE_AM_IST, template: promo }, 'quiet_hours', /TRAI/],
      [{ sentToday: 99 }, 'daily_cap'],
      [{ campaignStatus: 'paused' }, 'campaign_inactive'],
      [{ autoSend: false }, 'needs_approval'],
    ]
    for (let i = 0; i < steps.length; i += 1) {
      const [own, code, words] = steps[i]!
      const over = Object.assign({}, ...steps.slice(i).map(([o]) => o), own) as Partial<SendFacts>
      const d = decideSend(sms(over))
      expect(d.allowed, code).toBe(false)
      if (d.allowed) continue
      expect(d.code, `row ${i}`).toBe(code)
      if (words) expect(d.reason, `row ${i}`).toMatch(words)
    }
    // And with nothing violated, it goes.
    expect(decideSend(sms({}))).toEqual({ allowed: true, code: 'send_now' })
  })
})

describe('the registered template (0019)', () => {
  const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
  const sms = (over: Partial<SendFacts> = {}): SendFacts =>
    facts({
      channel: 'sms',
      recipient: '+919876543210',
      consent: { granted: true, source: 'booking form' },
      recipientTimeZone: 'Asia/Kolkata',
      template: { active: true, matches: true, category: 'service_implicit' },
      now: NOON_IST,
      ...over,
    })

  it.each([
    ['no template at all', { template: null }, 'no_template'],
    ['a deactivated template', { template: { active: false, matches: true, category: 'service_implicit' as const } }, 'no_template'],
    ['words that are not the template', { template: { active: true, matches: false, category: 'service_implicit' as const } }, 'template_mismatch'],
  ])('refuses %s, and neither an approval nor auto-send gets past it', (_label, over, code) => {
    for (const who of [{ autoSend: false, approvedByHuman: true }, { autoSend: true }]) {
      const d = decideSend(sms({ ...over, ...who }))
      expect(d.allowed).toBe(false)
      if (d.allowed) continue
      expect(d.code).toBe(code)
      expect(d.humanCanResolve).toBe(false)
      expect(d.reason).toMatch(/Nothing was sent/)
      expect(d.reason).not.toContain('+919876543210')
    }
  })

  it('refuses a WhatsApp message with no template the same way', () => {
    const d = decideSend(sms({ channel: 'whatsapp', template: null }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('no_template')
  })

  it('does not read the template on email, LinkedIn or voice', () => {
    expect(decideSend(facts({ template: null }))).toEqual({ allowed: true, code: 'send_now' })
    expect(
      decideSend(facts({ template: { active: false, matches: false, category: 'promotional' } })),
    ).toEqual({ allowed: true, code: 'send_now' })
  })

  it('needs a granted opt-in before the template is read — a service-explicit template adds no second consent', () => {
    const d = decideSend(sms({ consent: null, template: { active: true, matches: true, category: 'service_explicit' } }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('cold_channel_forbidden')
  })

  it('reports the person before the words: a suppressed number with no template is suppressed', () => {
    const d = decideSend(sms({ suppressed: true, template: null }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.code).toBe('suppressed')
  })

  describe('a promotional SMS waits for TRAI’s band', () => {
    const promo = { active: true, matches: true, category: 'promotional' as const }
    it.each([
      ['09:59 IST', '2026-09-15T04:29:00.000Z', false],
      ['10:00 IST', '2026-09-15T04:30:00.000Z', true],
      ['20:59 IST', '2026-09-15T15:29:00.000Z', true],
    ])('at %s', (_label, at, goes) => {
      // A campaign whose own quiet hours are off, so the band alone decides.
      const d = decideSend(sms({ template: promo, now: new Date(at), quietStart: '00:00', quietEnd: '00:00' }))
      expect(d.allowed).toBe(goes)
    })

    it('is held at 21:00 IST and later, as quiet hours a person can wait out', () => {
      const d = decideSend(sms({ template: promo, now: new Date('2026-09-15T15:30:00.000Z'), quietStart: '00:00', quietEnd: '00:00' }))
      expect(d.allowed).toBe(false)
      if (d.allowed) return
      expect(d.code).toBe('quiet_hours')
      expect(d.humanCanResolve).toBe(true)
      expect(d.reason).toMatch(/TRAI/)
    })

    it('reads the band in India AND where the recipient is', () => {
      // 11:00 in India is 06:30 in London: inside the band, outside it locally.
      const d = decideSend(
        sms({ template: promo, recipientTimeZone: 'Europe/London', now: new Date('2026-09-15T05:30:00.000Z'), quietStart: '00:00', quietEnd: '00:00' }),
      )
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('quiet_hours')
    })

    it('does not hold a service or transactional SMS to the band', () => {
      for (const category of ['service_implicit', 'service_explicit', 'transactional'] as const) {
        const d = decideSend(
          sms({ template: { active: true, matches: true, category }, now: new Date('2026-09-15T03:30:00.000Z'), quietStart: '00:00', quietEnd: '00:00' }),
        )
        expect(d, category).toEqual({ allowed: true, code: 'send_now' })
      }
    })
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
      facts({ recipientBounced: true }),
      facts({ consent: { granted: false, source: 'reply' } }),
      facts({ paused: true, pausedFor: 'manual' }),
      facts({ evidenceStale: true }),
      facts({ recipientTimeZone: null }),
      facts({ now: new Date('2026-09-15T23:00:00.000Z') }),
      facts({ sentToday: 99 }),
      facts({ autoSend: false }),
      facts({ recipient: 'nope' }),
      facts({ channel: 'sms', recipient: '+14155550100' }),
      facts({ channel: 'sms', recipient: '+14155550100', consent: { granted: true, source: 'form' }, template: null }),
      facts({
        channel: 'sms', recipient: '+14155550100', consent: { granted: true, source: 'form' },
        template: { active: true, matches: false, category: 'service_implicit' },
      }),
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
    const noOverride = [
      'suppressed', 'consent_revoked', 'paused', 'stale_evidence', 'cold_channel_forbidden', 'no_template', 'template_mismatch',
    ]
    const smsWith = (template: SendFacts['template']) =>
      facts({ channel: 'sms', recipient: '+14155550100', consent: { granted: true, source: 'form' }, template })
    for (const f of [
      smsWith(null),
      smsWith({ active: true, matches: false, category: 'service_implicit' }),
      facts({ suppressed: true }),
      facts({ consent: { granted: false, source: 'reply' } }),
      facts({ paused: true, pausedFor: 'replied' }),
      facts({ evidenceStale: true }),
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

/**
 * §5.5's `classify_reply`, deterministic half. This is the fallback a model
 * improves on, and the thing that runs when no model is configured.
 */
describe('classifying a reply', () => {
  /**
   * THE rule. Opt-out is decided by the detector in the send path, passed in
   * as a fact — never re-read here, and never left to a model. Being wrong
   * about the others costs somebody a reading order; being wrong about this
   * one means contacting a person who asked not to be.
   */
  it('takes the opt-out decision as given and stops there', () => {
    expect(classifyReply('Anything at all', true)).toBe('opted_out')
    // Even text that reads enthusiastic — the fact wins over the words.
    expect(classifyReply('Sounds great, very interested!', true)).toBe('opted_out')
  })

  it('reads an out-of-office as an auto-reply', () => {
    for (const t of [
      'I am out of the office until Monday',
      'Automatic reply: on annual leave',
      'Away from my desk this week',
    ]) {
      expect(classifyReply(t, false), t).toBe('auto_reply')
    }
  })

  /**
   * Checked BEFORE interest, because "I've left, talk to Sam" reads as
   * enthusiastic to a keyword matcher and is the opposite of a lead.
   */
  it('reads a handover as the wrong person, not as interest', () => {
    expect(classifyReply('I no longer work at the company — speak to Sam instead', false)).toBe('wrong_person')
  })

  it('separates not-now from interested', () => {
    expect(classifyReply('Not right now, maybe next quarter', false)).toBe('not_now')
    expect(classifyReply('Interested — can you send me more detail?', false)).toBe('interested')
    expect(classifyReply('Happy to book a call', false)).toBe('interested')
  })

  /**
   * An out-of-office carrying boilerplate about not being interested is
   * still an out-of-office. The order is the meaning.
   */
  it('lets the earlier rule win when a reply matches two', () => {
    expect(classifyReply('Out of the office. Not interested in vendor mail.', false)).toBe('auto_reply')
  })

  /** Anything it cannot place is `other`, never a guess. */
  it('refuses to guess', () => {
    expect(classifyReply('ok', false)).toBe('other')
    expect(classifyReply('', false)).toBe('other')
    expect(classifyReply(null, false)).toBe('other')
  })
})