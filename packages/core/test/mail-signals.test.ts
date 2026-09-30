/**
 * What an inbound mail says about itself (RFC 3834, RFC 3464, RFC 3463).
 *
 * The header readers are pure over headers and the delivery-status part, and
 * they never look at the body; the one body reader, the broad removal reader,
 * decides only whether an automatic mail may skip the pause. What is tested
 * here is the reading; what is DONE
 * with it — tying a bounce to a message this system sent, marking the
 * contact, letting an opt-out win over an auto-reply — is in
 * packages/db/test/outreach.test.ts, against a real engine.
 */
import { describe, expect, it } from 'vitest'
import {
  MAIL_SIGNAL_HEADERS, MAIL_SIGNAL_LIMITS, mailSignalInput, mentionsRemovalOrDeparture, ownWords, parseDsn,
  readMailSignals,
} from '../src/index.js'

/** A delivery-status part the way Postfix writes one. */
const dsn = (recipient: string[], perMessage: string[] = ['Reporting-MTA: dns; mx.rentman.io']): string =>
  [...perMessage, '', ...recipient, ''].join('\r\n')

const FAILED_511 = dsn([
  'Final-Recipient: rfc822; priya@rentman.io',
  'Original-Recipient: rfc822;priya@rentman.io',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <priya@rentman.io>: Recipient address rejected: User unknown',
])

describe('readMailSignals — auto-replies', () => {
  /** RFC 3834 §5: any value other than `no` says the mail was automatic. */
  it.each(['auto-generated', 'auto-replied', 'auto-notified', 'auto-replied; owner-email="x@y.test"', 'auto-replied (vacation)'])(
    'reads Auto-Submitted: %s as automatic',
    (value) => {
      expect(readMailSignals({ headers: { 'Auto-Submitted': value } })).toEqual({ kind: 'auto_reply', header: 'auto-submitted' })
    },
  )

  it('reads an extension value as automatic too — only `no` means a person', () => {
    expect(readMailSignals({ headers: { 'auto-submitted': 'x-some-robot' } })).toMatchObject({ kind: 'auto_reply' })
  })

  it('reads Auto-Submitted: no as a person, whatever Precedence says', () => {
    expect(readMailSignals({ headers: { 'Auto-Submitted': 'no' } })).toBeNull()
    expect(readMailSignals({ headers: { 'Auto-Submitted': 'No', Precedence: 'bulk' } })).toBeNull()
  })

  it('reads an empty Auto-Submitted as saying nothing', () => {
    expect(readMailSignals({ headers: { 'Auto-Submitted': '   ' } })).toBeNull()
  })

  it.each(['bulk', 'junk', 'list', 'auto_reply', 'BULK', ' Junk '])('reads Precedence: %s as automatic', (value) => {
    expect(readMailSignals({ headers: { Precedence: value } })).toEqual({ kind: 'auto_reply', header: 'precedence' })
  })

  it.each(['first-class', 'normal', ''])('does not read Precedence: %s as automatic', (value) => {
    expect(readMailSignals({ headers: { Precedence: value } })).toBeNull()
  })

  it.each([
    ['X-Auto-Response-Suppress', 'All', 'x-auto-response-suppress'],
    ['X-Auto-Response-Suppress', 'DR, OOF, AutoReply', 'x-auto-response-suppress'],
    ['X-Autoreply', 'yes', 'x-autoreply'],
    ['X-Autorespond', 'Out of office', 'x-autorespond'],
  ])('reads %s: %s as automatic', (name, value, header) => {
    expect(readMailSignals({ headers: { [name]: value } })).toEqual({ kind: 'auto_reply', header })
  })

  it('folds header names, so the spelling a provider chose does not matter', () => {
    for (const name of ['AUTO-SUBMITTED', 'auto-submitted', 'Auto-submitted']) {
      expect(readMailSignals({ headers: { [name]: 'auto-replied' } }), name).toMatchObject({ kind: 'auto_reply' })
    }
  })

  /** The whole point of the file: no headers, no signal — the body is never read. */
  it('says nothing without headers, and never reads a body', () => {
    expect(readMailSignals({})).toBeNull()
    expect(readMailSignals({ headers: null, dsn: null })).toBeNull()
    expect(readMailSignals({ headers: {} })).toBeNull()
    expect(readMailSignals({ headers: { Subject: 'Automatic reply: out of office', 'Content-Type': 'text/plain' } })).toBeNull()
  })
})

describe('readMailSignals — bounces', () => {
  it('reads Action: failed with a 5.x.x status as a permanent bounce, naming the recipient', () => {
    expect(readMailSignals({ dsn: FAILED_511 })).toEqual({
      kind: 'bounce',
      permanent: true,
      status: '5.1.1',
      recipient: 'priya@rentman.io',
      originalRecipient: 'priya@rentman.io',
      originalMessageId: null,
    })
  })

  it('reads a 4.x.x status as transient', () => {
    const s = readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 4.2.2']) })
    expect(s).toMatchObject({ kind: 'bounce', permanent: false, status: '4.2.2', recipient: 'priya@rentman.io' })
  })

  /**
   * RFC 3463 on X.2.2, mailbox full: "This code should be used as a
   * persistent transient failure." A full inbox is not a bad address, so it
   * never marks one — whatever its class digit says.
   */
  it('reads 5.2.2 (mailbox full) as transient, as RFC 3463 says to', () => {
    const s = readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 5.2.2']) })
    expect(s).toMatchObject({ kind: 'bounce', permanent: false, status: '5.2.2' })
  })

  it('reads a policy refusal (5.7.1) as permanent: retrying will not deliver it', () => {
    const s = readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 5.7.1']) })
    expect(s).toMatchObject({ kind: 'bounce', permanent: true, status: '5.7.1' })
  })

  it.each(['delayed', 'delivered', 'relayed', 'expanded'])('does not read Action: %s as a bounce', (action) => {
    expect(readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', `Action: ${action}`, 'Status: 4.4.7']) })).toBeNull()
  })

  it('does not read a failure with no status as a bounce — the status is the evidence', () => {
    expect(readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed']) })).toBeNull()
    expect(
      readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: permanent']) }),
    ).toBeNull()
  })

  /** A 2.x.x status with Action: failed contradicts itself. A contradiction is not evidence. */
  it('does not read a success status as a bounce', () => {
    expect(readMailSignals({ dsn: dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 2.0.0']) })).toBeNull()
  })

  it('reads a bounce ahead of the Auto-Submitted header every MTA also sets', () => {
    expect(readMailSignals({ headers: { 'Auto-Submitted': 'auto-replied' }, dsn: FAILED_511 })).toMatchObject({ kind: 'bounce' })
  })

  it('reads a delivery report that is not a failure by its headers, like any mail', () => {
    const delayed = dsn(['Final-Recipient: rfc822; priya@rentman.io', 'Action: delayed', 'Status: 4.4.7'])
    expect(readMailSignals({ headers: { 'Auto-Submitted': 'auto-replied' }, dsn: delayed })).toEqual({
      kind: 'auto_reply',
      header: 'auto-submitted',
    })
  })

  it('falls back to X-Failed-Recipients for the address, and to null when nothing names one', () => {
    const noFinal = dsn(['Action: failed', 'Status: 5.1.1'])
    expect(readMailSignals({ headers: { 'X-Failed-Recipients': 'priya@rentman.io, sam@rentman.io' }, dsn: noFinal })).toMatchObject({
      recipient: 'priya@rentman.io',
    })
    expect(readMailSignals({ dsn: noFinal })).toMatchObject({ kind: 'bounce', recipient: null })
  })

  it('carries the reporting MTA’s Original-Message-ID when it adds one', () => {
    const withId = dsn(
      ['Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 5.1.1'],
      ['Reporting-MTA: dns; mx.rentman.io', 'X-Original-Message-ID: <sent-1@agency.test>'],
    )
    expect(readMailSignals({ dsn: withId })).toMatchObject({ originalMessageId: '<sent-1@agency.test>' })
  })
})

describe('parseDsn', () => {
  it('reads the per-recipient fields, folding continuation lines and case', () => {
    const text = [
      'Reporting-MTA: dns;',
      '  mx.rentman.io',
      '',
      'FINAL-RECIPIENT: RFC822;',
      '\t<Priya@Rentman.IO>',
      'action: Failed',
      'status: 5.1.1 (bad destination mailbox address)',
      '',
    ].join('\n')
    expect(parseDsn(text)).toEqual({
      action: 'failed',
      status: '5.1.1',
      finalRecipient: 'Priya@Rentman.IO',
      originalRecipient: null,
      originalMessageId: null,
    })
  })

  it('prefers the failed recipient block over an earlier delayed one', () => {
    const text = dsn(
      ['Final-Recipient: rfc822; sam@rentman.io', 'Action: delayed', 'Status: 4.4.7', '', 'Final-Recipient: rfc822; priya@rentman.io', 'Action: failed', 'Status: 5.1.1'],
    )
    expect(parseDsn(text)).toMatchObject({ action: 'failed', finalRecipient: 'priya@rentman.io' })
  })

  it('answers nulls, never a guess, for text that is not a DSN', () => {
    const none = { action: null, status: null, finalRecipient: null, originalRecipient: null, originalMessageId: null }
    expect(parseDsn('')).toEqual(none)
    expect(parseDsn('I am out of the office until Monday.')).toEqual(none)
    expect(parseDsn('Status: 5.1.1')).toEqual(none)
  })

  it('refuses a status that is not an RFC 3463 code', () => {
    expect(parseDsn(dsn(['Action: failed', 'Status: 5.1.1234'])).status).toBeNull()
    expect(parseDsn(dsn(['Action: failed', 'Status: 6.1.1'])).status).toBeNull()
    expect(parseDsn(dsn(['Action: failed', 'Status: 5.1'])).status).toBeNull()
  })
})

describe('mailSignalInput — what a webhook body may hand the readers', () => {
  it('keeps only the headers the readers read, folded, as strings', () => {
    const r = mailSignalInput({
      headers: { 'Auto-Submitted': 'auto-replied', 'DKIM-Signature': 'v=1; a=rsa-sha256', Precedence: 7, Received: ['a', 'b'] },
      dsn: FAILED_511,
    })
    expect(r.headers).toEqual({ 'auto-submitted': 'auto-replied' })
    expect(r.dsn).toBe(FAILED_511)
    for (const name of Object.keys(r.headers ?? {})) expect(MAIL_SIGNAL_HEADERS as readonly string[]).toContain(name)
  })

  /**
   * It never refuses. A provider that forwards sixty headers, one of them a
   * long References, must not have the delivery rejected — it might be the
   * reply that says stop.
   */
  it('bounds rather than refuses: many headers, long values and a long DSN are all accepted', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 200; i += 1) many[`x-noise-${i}`] = 'n'
    many['precedence'] = 'bulk'.padEnd(5_000, ' ')
    const r = mailSignalInput({ headers: many, dsn: 'Action: failed\n'.padEnd(50_000, 'x') })
    expect(Object.keys(r.headers ?? {})).toEqual(['precedence'])
    expect(r.headers!['precedence']!.length).toBe(MAIL_SIGNAL_LIMITS.headerChars)
    expect(r.dsn!.length).toBe(MAIL_SIGNAL_LIMITS.dsnChars)
    expect(readMailSignals(r)).toEqual({ kind: 'auto_reply', header: 'precedence' })
  })

  it('treats anything that is not an object of strings as no headers, and a blank DSN as none', () => {
    for (const headers of [undefined, null, 'Auto-Submitted: auto-replied', ['auto-submitted'], 42]) {
      expect(mailSignalInput({ headers }).headers).toBeUndefined()
    }
    expect(mailSignalInput({ dsn: '   ' }).dsn).toBeNull()
    expect(mailSignalInput({ dsn: 12 }).dsn).toBeNull()
  })
})

/**
 * The broad reader. Found by review: a mail whose headers said "automatic"
 * skipped the pause whenever the NARROW opt-out reader missed it, and that
 * reader misses the very example the send path's own comment gives. The
 * broad one decides only that an automatic mail is handled like any reply —
 * paused — and never writes a suppression (packages/db/test/outreach.test.ts).
 */
describe('mentionsRemovalOrDeparture — the broad reader', () => {
  it.each([
    // The send path's own example, which the narrow reader misses.
    'I have left — remove me from your list',
    'remove me from your list',
    // An out-of-office whose last line asks to be removed.
    'Thank you for your message. I am out of the office until 21 September with no access to email.\n\n' +
      'Please remove me from your mailing list.',
    'Please take me off this list.',
    'UNSUBSCRIBE',
    'I would like to opt out.',
    'Please opt-out my address.',
    "Please don't email me again.",
    'Do not contact me.',
    'Stop emailing me, thanks.',
    'Priya is no longer with Rentman.',
    'I am no longer working on security.',
    'Priya has left the company; please contact Sam.',
    'I’ve left Rentman.',
    'She left the organisation in August.',
    'He left the organization last year.',
    'Please remove my address from your records.',
  ])('reads %j as removal or departure', (body) => {
    expect(mentionsRemovalOrDeparture(body)).toBe(true)
  })

  it.each([
    // An ordinary out-of-office: nothing in it asks for anything.
    'Thank you for your email. I am currently out of the office with limited access to email and will ' +
      'return on 21 September. For urgent matters please contact support@rentman.io.',
    'Automatic reply: I am on annual leave until Monday.',
    'Thanks — interested, can we book a call next week?',
    '',
  ])('reads %j as saying nothing of the kind', (body) => {
    expect(mentionsRemovalOrDeparture(body)).toBe(false)
  })

  it('reads nothing into an empty or missing body', () => {
    expect(mentionsRemovalOrDeparture(null)).toBe(false)
    expect(mentionsRemovalOrDeparture(undefined)).toBe(false)
    expect(mentionsRemovalOrDeparture('   \n  ')).toBe(false)
  })

  /**
   * The message they are replying to is ours, footer and all. Our own
   * "unsubscribe" line, quoted back, is not theirs.
   */
  it('reads only their own words, never the message they quote', () => {
    const quoted = [
      'I am out of the office until Monday.',
      '',
      'On Tue, 15 Sep 2026 at 12:00, Agency <hello@agency.test> wrote:',
      '> A gap on your security page.',
      '> Reply "unsubscribe" to stop hearing from us.',
    ].join('\n')
    expect(mentionsRemovalOrDeparture(quoted)).toBe(false)
    expect(mentionsRemovalOrDeparture('Out of office.\n> unsubscribe')).toBe(false)
    expect(mentionsRemovalOrDeparture('Out of office.\n-----Original Message-----\nunsubscribe')).toBe(false)
  })
})

describe('ownWords', () => {
  it('keeps everything above the first quote marker, and all of a body with none', () => {
    expect(ownWords('Stop\n> quoted')).toBe('Stop')
    expect(ownWords('Thanks!\r\nOn Mon, Priya wrote:\r\n> hi')).toBe('Thanks!')
    expect(ownWords('Line one\nLine two')).toBe('Line one\nLine two')
    expect(ownWords(null)).toBe('')
  })
})
