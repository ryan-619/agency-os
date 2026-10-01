/**
 * The words /contacts puts on §2.1's record (lib/consent-view.ts).
 *
 * The failure these guard against is a sentence that reads as permission:
 * a never-asked SMS channel that looks blank, an unreadable address that
 * says "clear", a company's timezone passed off as the person's own.
 */
import { describe, expect, it } from 'vitest'
import {
  consentStateClass, consentStateLabel, maskRecipient, maskSuppressionKey, sendCheckSentence,
  shortDate, suppressionClass, suppressionLabel, zoneLabel, type SuppressionStandingName,
} from '../src/lib/consent-view'

const AT = new Date('2026-09-12T15:04:00.000Z')

describe('consentStateLabel', () => {
  it('says where a grant came from and when', () => {
    expect(consentStateLabel({ state: 'granted', source: 'booking page', recordedAt: AT }, 'sms')).toBe(
      'granted (booking page, 12 Sep 2026)',
    )
  })

  it('does not repeat a date the source already carries', () => {
    expect(consentStateLabel({ state: 'granted', source: 'booking page, 2026-09-12', recordedAt: AT.toISOString() }, 'email')).toBe(
      'granted (booking page, 12 Sep 2026)',
    )
  })

  it('bounds a long source rather than letting it take the row', () => {
    const label = consentStateLabel({ state: 'granted', source: 'x'.repeat(300), recordedAt: AT }, 'voice')
    expect(label.length).toBeLessThan(110)
    expect(label).toContain('…')
  })

  it('says a refusal is final', () => {
    expect(consentStateLabel({ state: 'refused', source: 'reply', recordedAt: AT }, 'sms')).toBe('refused — will not be asked again')
  })

  it('words never-asked by channel: cold email is allowed, the opt-in channels cannot be used', () => {
    const never = { state: 'never_asked' as const, source: null, recordedAt: null }
    expect(consentStateLabel(never, 'email')).toBe('never asked — cold email allowed')
    for (const channel of ['sms', 'voice', 'whatsapp']) {
      expect(consentStateLabel(never, channel)).toBe('never asked — cannot be used')
    }
  })

  it('colours never-asked as a stop on the opt-in channels, and as neutral on email', () => {
    expect(consentStateClass({ state: 'never_asked' }, 'sms')).toBe('none')
    expect(consentStateClass({ state: 'never_asked' }, 'email')).toBe('unknown')
    expect(consentStateClass({ state: 'refused' }, 'email')).toBe('no')
    expect(consentStateClass({ state: 'granted' }, 'voice')).toBe('yes')
  })
})

describe('suppressionLabel', () => {
  it('has words for every standing', () => {
    expect(suppressionLabel('suppressed')).toBe('on the suppression list')
    expect(suppressionLabel('clear')).toBe('clear')
    expect(suppressionLabel('unparseable')).toBe('could not be parsed — treated as suppressed')
    expect(suppressionLabel('none')).toBe('nothing on file')
  })

  /** §2.1: "we could not parse it" is not "they never asked us to stop". */
  it('never calls an unparseable value clear, in words or in colour', () => {
    expect(suppressionLabel('unparseable')).not.toMatch(/clear/)
    expect(suppressionClass('unparseable')).toBe('no')
    const allowed: SuppressionStandingName[] = ['clear', 'suppressed', 'unparseable', 'none']
    expect(allowed.filter((s) => suppressionClass(s) === 'yes')).toEqual(['clear'])
  })
})

describe('zoneLabel', () => {
  it('shows the person’s own zone', () => {
    expect(zoneLabel('America/New_York', 'Europe/London')).toBe('America/New_York')
  })

  it('names the company fallback as a fallback', () => {
    expect(zoneLabel(null, 'Europe/London')).toBe('falls back to Europe/London from the company')
  })

  it('says what having no zone means', () => {
    expect(zoneLabel(null, null)).toBe('no timezone — nothing can be sent until one is set')
  })
})

describe('masking what leaves the server', () => {
  it('keeps only the domain of an address', () => {
    expect(maskRecipient('priya@rentman.io')).toBe('…@rentman.io')
    expect(maskRecipient('+14155550100')).toBeNull()
    expect(maskRecipient('linkedin.com/in/priya')).toBeNull()
    expect(maskRecipient(null)).toBeNull()
    expect(maskRecipient('@')).toBeNull()
  })

  it('masks a suppression key the same way, and leaves a domain alone', () => {
    expect(maskSuppressionKey({ kind: 'email', value: 'priya@rentman.io' })).toEqual({ kind: 'email', value: '…@rentman.io' })
    expect(maskSuppressionKey({ kind: 'domain', value: 'rentman.io' })).toEqual({ kind: 'domain', value: 'rentman.io' })
    expect(maskSuppressionKey({ kind: 'phone', value: '+14155550100' })).toEqual({ kind: 'phone', value: null })
    expect(maskSuppressionKey({ kind: 'linkedin', value: 'in/priya' })).toEqual({ kind: 'linkedin', value: null })
  })
})

describe('sendCheckSentence', () => {
  it('puts the code in the words every screen uses, then the reason, then who can act', () => {
    expect(
      sendCheckSentence({
        decision: { allowed: false, code: 'suppressed', reason: 'This recipient is on the suppression list.', humanCanResolve: false },
        wouldNeedApproval: true,
      }),
    ).toBe('On the suppression list — This recipient is on the suppression list. Nobody may approve past this.')
    expect(
      sendCheckSentence({
        decision: { allowed: false, code: 'unknown_timezone', reason: 'No timezone.', humanCanResolve: true },
        wouldNeedApproval: true,
      }),
    ).toMatch(/^No timezone on the contact — .*A person can resolve this\.$/)
  })

  it('says an allowed message would still wait for a person when it would', () => {
    expect(sendCheckSentence({ decision: { allowed: true, code: 'send_now' }, wouldNeedApproval: true })).toMatch(/approve/)
    expect(sendCheckSentence({ decision: { allowed: true, code: 'send_now' }, wouldNeedApproval: false })).toMatch(/without a per-message approval/)
  })
})

describe('shortDate', () => {
  it('is the same on any machine: UTC and a fixed month name', () => {
    expect(shortDate('2026-09-01T00:30:00.000Z')).toBe('1 Sep 2026')
    expect(shortDate('not a date')).toBe('an unknown date')
  })
})
