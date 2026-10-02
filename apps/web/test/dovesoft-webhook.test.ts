/**
 * DoveSoft's two pushes (0019): the delivery report and the text a contact
 * sends back.
 *
 * The routes cannot be imported here (they reach `server-only` through
 * `@/lib/db`), so everything that decides anything lives in
 * `app/api/inbound/dovesoft/webhook.ts` with the database, the audit writer,
 * the logger and Slack handed in — and this file drives THAT, with fakes
 * that record what they were asked. The last block reads the routes' source
 * to pin that they are the few lines that wire it up.
 *
 * What matters most is the failure direction. The formats are not public,
 * so a payload this code cannot read is the likely failure on day one — and
 * an inbound text it cannot read may have been a STOP. That must never be a
 * 200: it is a 400 DoveSoft retries, an audit row and an error line, and
 * none of the three may carry the number or the words.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  SmsOptOutNotRecorded, SmsRedeliveryIncomplete, appendAudit, contactResumeByHand, pauseContactOverriding, pauseReasonClass,
  recordInboundSms, schema,
  type AgencyDb, type InboundSmsOutcome, type SmsDeliveryOutcome,
} from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { failOnce } from '../../../packages/db/test/fault-db.js'
import {
  DELIVERED_WORDS, DLR_ID_FIELDS, DLR_STATUS_FIELDS, DOVESOFT_MAX_BODY_BYTES, FAILED_WORDS, MO_FROM_FIELDS, MO_ID_FIELDS,
  MO_TEXT_FIELDS, MO_TIME_FIELDS, MO_TO_FIELDS, ROLLED_BACK_OPT_OUT_LINE, authoriseDoveSoft, handleDoveSoftDlr, handleDoveSoftMo,
  keepingRolledBackSmsOptOut, logRefusalOnce, rawQueryValue, readDlr, readDoveSoftRequest, readFields, readMo, readReceivedAt,
  readSender, tokenFrom,
  type DoveSoftRoute, type FieldsRead,
} from '../src/app/api/inbound/dovesoft/webhook'
import { smsOptOutAlarms, smsReplyNotification } from '../src/app/api/inbound/dovesoft/notification'
import { slackMessage, type NotificationEvent } from '../src/lib/slack-message'

const SECRET = 'd'.repeat(40)
const ORG = '00000000-0000-4000-8000-00000000000a'
const NOW = new Date('2026-10-01T10:00:00.000Z')
const NUMBER = '+919876543210'
const WORDS = 'STOP sending me these DECOY-WORDS'

const fields = (o: Record<string, string>): FieldsRead => ({ ok: true, fields: new Map(Object.entries(o)) })
const shape = { bytes: 120, contentType: 'application/x-www-form-urlencoded' }

/** What a handler wrote, logged, paused and announced. */
function world(orgId: string | null = ORG) {
  const audits: { action: string; detail: Record<string, unknown> }[] = []
  /** The same rows, with where they were filed and what about. */
  const filed: { orgId: string; action: string; subjectType: string | null; subjectId: string | null }[] = []
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = []
  const paused: { orgId: string; contactId: string; reason: string }[] = []
  return {
    audits,
    filed,
    logs,
    paused,
    deps: {
      orgId,
      audit: async (e: { orgId: string; action: string; subjectType: string | null; subjectId: string | null; detail: Record<string, unknown> }) => {
        audits.push({ action: e.action, detail: e.detail })
        filed.push({ orgId: e.orgId, action: e.action, subjectType: e.subjectType, subjectId: e.subjectId })
      },
      pause: async (p: { orgId: string; contactId: string; reason: string }) => {
        paused.push({ orgId: p.orgId, contactId: p.contactId, reason: p.reason })
      },
      log: {
        error: (message: string, f: Record<string, unknown> = {}) => logs.push({ level: 'error', message, fields: f }),
        warn: (message: string, f: Record<string, unknown> = {}) => logs.push({ level: 'warn', message, fields: f }),
      },
    },
    /** Everything written anywhere, as one string, for the "never the number, never the words" checks. */
    everything: () => JSON.stringify({ audits, logs }),
  }
}

describe('who may post', () => {
  it('refuses everything while the secret is unset — 503, whatever is sent', () => {
    expect(authoriseDoveSoft(undefined, { query: SECRET, header: SECRET })).toEqual({
      ok: false, status: 503, error: 'DoveSoft webhooks are not configured',
    })
  })

  it('refuses a wrong, short, blank or absent token — 401', () => {
    for (const given of [
      { query: 'x'.repeat(40), header: null },
      { query: null, header: SECRET.slice(1) },
      { query: '', header: '' },
      { query: null, header: null },
    ]) {
      expect(authoriseDoveSoft(SECRET, given)).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    }
  })

  it('takes the token from the query string, since DoveSoft may not send headers, or from x-dovesoft-token', () => {
    expect(authoriseDoveSoft(SECRET, { query: SECRET, header: null })).toEqual({ ok: true })
    expect(authoriseDoveSoft(SECRET, { query: null, header: SECRET })).toEqual({ ok: true })
    expect(authoriseDoveSoft(SECRET, { query: 'wrong', header: SECRET })).toEqual({ ok: true })
  })

  /**
   * About half of all `openssl rand -base64 32` secrets carry a `+`, and the
   * query parser reads `+` as a space: a secret pasted raw into `?token=` —
   * as the registration instructions said — refused every push, STOPs
   * included, with nothing logged. Now raw, percent-encoded and header all
   * match.
   */
  describe('a base64 secret with + and /', () => {
    const B64 = 'q+7Lw/9ZpXo3+Rk1vY2u/HnTe8mJc4A6dG0sF5bE1iU='
    const at = (query: string, header?: string) =>
      tokenFrom(new Request(`https://x.test/api/inbound/dovesoft/sms${query}`, header ? { headers: { 'x-dovesoft-token': header } } : {}))

    it('matches it pasted raw into the URL', () => {
      expect(authoriseDoveSoft(B64, at(`?token=${B64}`))).toEqual({ ok: true })
      expect(authoriseDoveSoft(B64, at(`?mobile=919876543210&token=${B64}&message=hi`))).toEqual({ ok: true })
    })

    it('matches it percent-encoded in the URL, and in the header', () => {
      expect(authoriseDoveSoft(B64, at(`?token=${encodeURIComponent(B64)}`))).toEqual({ ok: true })
      expect(authoriseDoveSoft(B64, at('', B64))).toEqual({ ok: true })
    })

    it('still refuses a near miss, in any of the three places', () => {
      const near = B64.replace(/\+/g, ' ')
      expect(authoriseDoveSoft(B64, at(`?token=${encodeURIComponent(near)}`))).toMatchObject({ ok: false, status: 401 })
      expect(authoriseDoveSoft(B64, at(`?token=${B64.slice(1)}`, B64.slice(1)))).toMatchObject({ ok: false, status: 401 })
      expect(authoriseDoveSoft(B64, at(''))).toMatchObject({ ok: false, status: 401 })
    })

    it('reads the raw value without + as a space, and an escape that does not decode as nothing', () => {
      expect(rawQueryValue(`?token=${B64}`, 'token')).toBe(B64)
      expect(rawQueryValue('?token=a%2Bb%2Fc', 'token')).toBe('a+b/c')
      expect(rawQueryValue('?tokens=x&token=y&token=z', 'token')).toBe('y')
      expect(rawQueryValue('?token=%E0%A4', 'token')).toBeNull()
      expect(rawQueryValue('?mobile=1', 'token')).toBeNull()
      expect(rawQueryValue('', 'token')).toBeNull()
    })
  })

  /** A 401 used to be silent; now the first one per route says so, by the route's name alone. */
  it('logs a refused token once per route per process, naming the route and nothing sent', () => {
    const w = world()
    const logged = new Set<DoveSoftRoute>()
    const refused = authoriseDoveSoft(SECRET, { query: 'WRONG-TOKEN-VALUE', header: null })
    logRefusalOnce('sms', refused, w.deps.log, logged)
    logRefusalOnce('sms', refused, w.deps.log, logged)
    logRefusalOnce('dlr', refused, w.deps.log, logged)
    // Not a refusal of a token: an unset secret is the deployment page's to say, and a match is fine.
    logRefusalOnce('sms', authoriseDoveSoft(undefined, { query: null, header: null }), w.deps.log, new Set())
    logRefusalOnce('sms', { ok: true }, w.deps.log, new Set())
    expect(w.logs.map((l) => [l.level, l.fields])).toEqual([['error', { route: 'sms' }], ['error', { route: 'dlr' }]])
    expect(w.logs[0]!.message).toContain('percent-encoded')
    expect(w.everything()).not.toContain('WRONG-TOKEN-VALUE')
  })
})

describe('reading a payload — query, form or JSON', () => {
  const q = (s = '') => new URLSearchParams(s)

  it('reads the query string, lower-cases names, and never keeps the token', () => {
    const r = readFields({ query: q(`token=${SECRET}&MessageID=abc&ErrorStatus=DELIVRD`), contentType: null, body: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.fields.entries()]).toEqual([['messageid', 'abc'], ['errorstatus', 'DELIVRD']])
  })

  it('reads a form body, and the body wins over the query', () => {
    const r = readFields({
      query: q('messageid=from-query'),
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'messageid=from-body&status=UNDELIV',
    })
    expect(r.ok && Object.fromEntries(r.fields)).toEqual({ messageid: 'from-body', status: 'UNDELIV' })
  })

  it('reads a JSON object, with numbers as their text', () => {
    const r = readFields({ query: q(), contentType: 'application/json', body: '{"msgid":12345,"status":"DELIVRD","nested":{"x":1}}' })
    expect(r.ok && Object.fromEntries(r.fields)).toEqual({ msgid: '12345', status: 'DELIVRD' })
  })

  it.each([
    ['bad JSON', 'application/json', '{"messageid":'],
    ['a JSON array — a batch is not read as if it were one report', 'application/json', '[{"messageid":"a"}]'],
    ['multipart', 'multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--'],
  ])('refuses %s whole, rather than reading half of it', (_name, contentType, body) => {
    expect(readFields({ query: q('messageid=a&status=DELIVRD'), contentType, body })).toEqual({ ok: false, why: 'unreadable_body' })
  })

  it('bounds the body before it is read', async () => {
    const big = new Request('https://x.test/api/inbound/dovesoft/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `message=${'a'.repeat(DOVESOFT_MAX_BODY_BYTES)}`,
    })
    expect((await readDoveSoftRequest(big)).read).toEqual({ ok: false, why: 'too_large' })
    const get = new Request(`https://x.test/api/inbound/dovesoft/sms?token=${SECRET}&mobile=919876543210&message=hi`)
    const r = await readDoveSoftRequest(get)
    expect(r.read.ok && Object.fromEntries(r.read.fields)).toEqual({ mobile: '919876543210', message: 'hi' })
  })
})

describe('a delivery report', () => {
  it('names its fields in one-line lists', () => {
    expect(DLR_ID_FIELDS).toEqual(['messageid', 'msgid'])
    expect(DLR_STATUS_FIELDS).toEqual(['errorstatus', 'status'])
  })

  /** A spelled-out "Delivered" was stored as pending, while the failure list took spelled-out words. */
  it('maps DELIVRD and the spelled-out Delivered to delivered, whatever its case', () => {
    for (const word of ['DELIVRD', 'delivrd', 'Delivered', 'DELIVERED', ' delivered ']) {
      expect(readDlr(new Map([['messageid', 'm-1'], ['errorstatus', word]]))).toEqual({
        ok: true, providerMessageId: 'm-1', status: 'delivered', reason: null,
      })
    }
    expect([...DELIVERED_WORDS]).toEqual(['delivrd', 'delivered'])
    expect(readDlr(new Map([['messageid', 'm'], ['errorstatus', 'UNDELIVERABLE']]))).toMatchObject({ status: 'failed' })
    // No word is both.
    expect([...DELIVERED_WORDS].filter((w) => FAILED_WORDS.has(w))).toEqual([])
  })

  it('maps a final failure word to failed, with the operator’s reason — or its word when it gave none', () => {
    expect(readDlr(new Map([['msgid', 'm-2'], ['status', 'UNDELIV'], ['errorreason', 'Absent subscriber']]))).toEqual({
      ok: true, providerMessageId: 'm-2', status: 'failed', reason: 'Absent subscriber',
    })
    for (const word of ['EXPIRED', 'REJECTD', 'Rejected', 'FAILED', 'DELETED']) {
      expect(readDlr(new Map([['messageid', 'm'], ['errorstatus', word]]))).toMatchObject({ status: 'failed', reason: word })
    }
  })

  /** Pending claims nothing, and a later final word can still land over it (`recordSmsDelivery`). */
  it('maps an intermediate or unrecognised word to pending, never to a final one', () => {
    for (const word of ['ENROUTE', 'ACCEPTD', 'UNKNOWN', 'SUBMITTED', 'Delivered-ish']) {
      expect(readDlr(new Map([['messageid', 'm'], ['errorstatus', word]]))).toMatchObject({ status: 'pending', reason: null })
    }
  })

  it('says which required field was missing', () => {
    expect(readDlr(new Map([['errorstatus', 'DELIVRD']]))).toEqual({ ok: false, missing: ['messageid'] })
    expect(readDlr(new Map([['messageid', ' ']]))).toEqual({ ok: false, missing: ['messageid', 'status'] })
  })

  it('records what it read, and answers 200 whether or not it matched a message', async () => {
    const w = world()
    const seen: unknown[] = []
    const record = async (args: unknown): Promise<SmsDeliveryOutcome> => {
      seen.push(args)
      return { matched: false, why: 'unknown_id' }
    }
    const answer = await handleDoveSoftDlr(fields({ messageid: 'm-9', errorstatus: 'DELIVRD' }), shape, { ...w.deps, record })
    expect(seen).toEqual([{ providerMessageId: 'm-9', status: 'delivered', reason: null, orgId: ORG }])
    expect(answer).toEqual({ status: 200, body: { matched: false, why: 'unknown_id' } })
    expect(w.audits).toEqual([])
  })

  it('answers an unreadable report 400, audits sms.dlr_unreadable and logs the names it carried — no values', async () => {
    const w = world()
    const record = async (): Promise<SmsDeliveryOutcome> => {
      throw new Error('must not be called')
    }
    const answer = await handleDoveSoftDlr(fields({ id: 'VALUE-1', state: 'VALUE-2' }), shape, { ...w.deps, record })
    expect(answer.status).toBe(400)
    expect(w.audits).toEqual([{ action: 'sms.dlr_unreadable', detail: { why: 'missing_fields', missing: ['messageid', 'status'] } }])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatchObject({ level: 'error', fields: { fields: ['id', 'state'], audited: true } })
    expect(w.everything()).not.toContain('VALUE-')
  })

  it('still answers 400, and says nothing was audited, where no org is named', async () => {
    const w = world(null)
    const record = async (): Promise<SmsDeliveryOutcome> => ({ matched: false, why: 'blank_id' })
    const answer = await handleDoveSoftDlr({ ok: false, why: 'unreadable_body' }, shape, { ...w.deps, record })
    expect(answer.status).toBe(400)
    expect(w.audits).toEqual([])
    expect(w.logs[0]).toMatchObject({ level: 'error', fields: { why: 'unreadable_body', audited: false } })
  })
})

describe('an inbound text', () => {
  /** One line each, so a spelling DoveSoft turns out to use is one string. */
  it('reads the common names for each field', () => {
    expect(MO_FROM_FIELDS).toEqual(['mobile', 'from', 'sender', 'msisdn'])
    expect(MO_TEXT_FIELDS).toEqual(['message', 'text', 'sms', 'content'])
    expect(MO_TO_FIELDS).toEqual(['to', 'longcode', 'vmn', 'shortcode'])
    expect(MO_ID_FIELDS).toEqual(['messageid', 'msgid', 'id'])
    expect(MO_TIME_FIELDS).toEqual(['receivedat', 'time'])
  })

  it.each([
    ['mobile', 'message', 'to', 'messageid'],
    ['from', 'text', 'longcode', 'msgid'],
    ['sender', 'sms', 'vmn', 'id'],
    ['msisdn', 'content', 'shortcode', 'id'],
  ])('reads %s / %s / %s / %s', (from, text, to, id) => {
    const r = readMo(new Map([[from, NUMBER], [text, 'Yes please'], [to, '+919000000000'], [id, 'mo-1']]), NOW)
    expect(r).toEqual({ ok: true, from: NUMBER, text: 'Yes please', to: '+919000000000', providerMessageId: 'mo-1', receivedAt: null })
  })

  it('reads a present but empty text, and refuses an absent one or an absent sender', () => {
    expect(readMo(new Map([['mobile', NUMBER], ['message', '']]), NOW)).toMatchObject({ ok: true, text: '' })
    expect(readMo(new Map([['mobile', NUMBER]]), NOW)).toEqual({ ok: false, missing: ['text'] })
    expect(readMo(new Map([['message', 'STOP']]), NOW)).toEqual({ ok: false, missing: ['from'] })
    expect(readMo(new Map([['mobile', '  '], ['msg', 'STOP']]), NOW)).toEqual({ ok: false, missing: ['from', 'text'] })
  })

  /** Some gateways decode GSM-7 `@` as U+0000, which Postgres refuses: every retry failed. */
  it('hands over U+0000 as U+FFFD, in the words and the message id', () => {
    expect(readMo(new Map([['mobile', NUMBER], ['message', 'STOP\u0000 jo'], ['msgid', 'mo\u00001']]), NOW)).toMatchObject({
      ok: true, text: 'STOP\uFFFD jo', providerMessageId: 'mo\uFFFD1',
    })
  })

  /** `normalisePhone` guesses no country, and neither does this — except the one bare form that is unambiguous. */
  it('reads a twelve-digit 91 mobile number as +91, and passes everything else as it came', () => {
    expect(readSender('919876543210')).toBe('+919876543210')
    expect(readSender('91 98765-43210')).toBe('+919876543210')
    expect(readSender('+44 20 7946 0000')).toBe('+44 20 7946 0000')
    expect(readSender('0044 20 7946 0000')).toBe('0044 20 7946 0000')
    // A ten-digit national number names no country: not guessed.
    expect(readSender('9876543210')).toBe('9876543210')
    // Twelve digits from 91 that is not an Indian mobile: not guessed either.
    expect(readSender('911234567890')).toBe('911234567890')
  })

  it('reads a time only when it cannot be misread, and never in the future', () => {
    expect(readReceivedAt('2026-10-01T09:58:00Z', NOW)).toEqual(new Date('2026-10-01T09:58:00Z'))
    expect(readReceivedAt('2026-10-01T15:28:00+05:30', NOW)).toEqual(new Date('2026-10-01T09:58:00Z'))
    expect(readReceivedAt('1759312680', NOW)).toEqual(new Date(1759312680 * 1000))
    expect(readReceivedAt('1759312680000', NOW)).toEqual(new Date(1759312680000))
    // No zone: five and a half hours either way. Not read.
    expect(readReceivedAt('2026-10-01 15:28:00', NOW)).toBeNull()
    expect(readReceivedAt('2026-10-02T00:00:00Z', NOW)).toBeNull()
    expect(readReceivedAt('yesterday', NOW)).toBeNull()
    expect(readReceivedAt(null, NOW)).toBeNull()
  })
})

describe('what an inbound text is answered with', () => {
  const filed = (over: Partial<Extract<InboundSmsOutcome, { matched: 'contact' }>> = {}): InboundSmsOutcome => ({
    matched: 'contact',
    orgId: ORG,
    contactId: '00000000-0000-4000-8000-000000000001',
    touchId: '00000000-0000-4000-8000-000000000002',
    duplicate: false,
    paused: true,
    suppressed: false,
    cancelled: 0,
    replyKind: 'interested',
    optOutNotRecorded: false,
    optOutNotRecordedIn: [],
    companyId: '00000000-0000-4000-8000-00000000000c',
    companyDomain: 'acme.example',
    ...over,
  })

  function run(
    outcome: InboundSmsOutcome | (() => Promise<InboundSmsOutcome>),
    read: FieldsRead = fields({ mobile: '919876543210', message: WORDS }),
    orgId: string | null = ORG,
  ) {
    const w = world(orgId)
    const recorded: unknown[] = []
    const alarms: NotificationEvent[] = []
    const later: NotificationEvent[] = []
    let releaseAlarm: () => void = () => {}
    const alarmGate = new Promise<void>((resolve) => {
      releaseAlarm = resolve
    })
    let answered = false
    const answer = handleDoveSoftMo(read, shape, NOW, {
      ...w.deps,
      record: async (args) => {
        recorded.push(args)
        return typeof outcome === 'function' ? outcome() : outcome
      },
      alarm: async (event) => {
        alarms.push(event)
        await alarmGate
      },
      later: (event) => {
        later.push(event)
      },
    }).then((a) => {
      answered = true
      return a
    })
    return { w, recorded, alarms, later, answer, releaseAlarm, answered: () => answered }
  }

  it('hands the recorder the number as E.164, the words, and the deployment’s org', async () => {
    const r = run(filed())
    await r.answer
    expect(r.recorded).toEqual([
      expect.objectContaining({ from: NUMBER, text: WORDS, to: null, providerMessageId: null, orgId: ORG }),
    ])
  })

  it('answers a text filed under a contact 200, and announces it after the answer, by ids only', async () => {
    const r = run(filed())
    const answer = await r.answer
    expect(answer).toEqual({ status: 200, body: { matched: 'contact', duplicate: false, paused: true, suppressed: false } })
    expect(r.alarms).toEqual([])
    expect(r.later).toHaveLength(1)
    expect(r.later[0]).toMatchObject({ kind: 'reply', touchId: '00000000-0000-4000-8000-000000000002', companyDomain: 'acme.example' })
  })

  /**
   * §2.1's Phase 4 obligation: a STOP whose suppression could not be written
   * reaches a person. AWAITED — the answer does not leave until the alarm
   * has been posted (or has failed), because a host without `waitUntil`
   * drops anything scheduled after it. And refused (review round 7): the
   * redelivery a 500 brings re-attempts the suppression; a 200 never did.
   */
  it('awaits the opt_out_not_recorded alarm before it answers 500, in place of the reply notice', async () => {
    const r = run(filed({ replyKind: 'opted_out', optOutNotRecorded: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.alarms).toEqual([
      {
        kind: 'opt_out_not_recorded',
        orgId: ORG,
        touchId: '00000000-0000-4000-8000-000000000002',
        contactId: '00000000-0000-4000-8000-000000000001',
        path: 'reply',
      },
    ])
    expect(r.answered()).toBe(false)
    r.releaseAlarm()
    expect(await r.answer).toEqual({
      status: 500,
      body: { error: 'opt-out not recorded', matched: 'contact', duplicate: false, paused: true, suppressed: false },
    })
    expect(r.later).toEqual([])
    expect(r.w.logs).toEqual([
      {
        level: 'error',
        message:
          'OPT-OUT NOT RECORDED — a STOP filed under a contact could not be suppressed in every org holding the number; it was refused so DoveSoft retries',
        fields: { duplicate: false, orgs: 1, alarm: 'raised' },
      },
    ])
  })

  it('raises nothing for a retried push', async () => {
    const r = run(filed({ duplicate: true, optOutNotRecorded: false }))
    expect((await r.answer).status).toBe(200)
    expect(r.alarms).toEqual([])
    expect(r.later).toEqual([])
  })

  /** The retry the 500 asked for, whose re-attempt failed again: alarmed again, refused again, announced never. */
  it('answers 500 again, and raises the alarm again, for a retry whose re-attempt failed again', async () => {
    const ORG_B = '00000000-0000-4000-8000-00000000000b'
    const CONTACT_B = '00000000-0000-4000-8000-0000000000b1'
    const r = run(filed({ duplicate: true, replyKind: 'opted_out', suppressed: true, optOutNotRecordedIn: [{ orgId: ORG_B, contactId: CONTACT_B }] }))
    r.releaseAlarm()
    expect(await r.answer).toMatchObject({ status: 500, body: { duplicate: true } })
    expect(r.alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: ORG_B, touchId: null, contactId: CONTACT_B, path: 'reply' }])
    expect(r.later).toEqual([])
    expect(r.w.logs[0]!.fields).toEqual({ duplicate: true, orgs: 1, alarm: 'raised' })
  })

  /**
   * Review round 6, findings [3] and [6]: a STOP filed under a contact in
   * one org, whose suppression failed in ANOTHER org holding the number,
   * raised one alarm naming the filed contact — whose number IS suppressed
   * — and dropped the filed org's reply notice. Now the other org gets the
   * alarm, naming its own contact, and the filed org keeps its notice.
   *
   * Review round 7, [1]/[3]/[9]: it was answered 200, so DoveSoft never
   * redelivered and the missing suppression was never written. It is a 500
   * now, after the alarm and the notice.
   */
  it('alarms the org whose suppression failed, naming its contact, keeps the filed org’s reply notice, and answers 500', async () => {
    const ORG_B = '00000000-0000-4000-8000-00000000000b'
    const CONTACT_B = '00000000-0000-4000-8000-0000000000b1'
    const r = run(filed({ replyKind: 'opted_out', suppressed: true, optOutNotRecordedIn: [{ orgId: ORG_B, contactId: CONTACT_B }] }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: ORG_B, touchId: null, contactId: CONTACT_B, path: 'reply' }])
    expect(r.answered()).toBe(false)
    r.releaseAlarm()
    expect(await r.answer).toMatchObject({ status: 500, body: { error: 'opt-out not recorded', matched: 'contact', suppressed: true } })
    expect(r.later).toEqual([expect.objectContaining({ kind: 'reply', orgId: ORG, suppressed: true })])
    // Its record holds the number: the message names the contact and links /suppressions.
    const wire = JSON.stringify(slackMessage(r.alarms[0]!, 'https://x.test'))
    expect(wire).toContain(`contact ${CONTACT_B}`)
    expect(wire).toContain('https://x.test/suppressions')
    expect(wire).not.toContain('Nothing in the app holds')
    expect(wire).not.toContain('9876543210')
  })

  it('raises one alarm per org when both the filed contact’s and another org’s suppression failed', async () => {
    const ORG_B = '00000000-0000-4000-8000-00000000000b'
    const r = run(filed({ replyKind: 'opted_out', optOutNotRecorded: true, optOutNotRecordedIn: [{ orgId: ORG_B, contactId: null }] }))
    r.releaseAlarm()
    expect((await r.answer).status).toBe(500)
    expect(r.alarms.map((a) => a.kind === 'opt_out_not_recorded' && [a.orgId, a.touchId, a.contactId])).toEqual([
      [ORG, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
      [ORG_B, null, null],
    ])
    expect(r.later).toEqual([])
  })

  it('alarms each org a STOP from a shared number could not be suppressed in, naming a contact there', async () => {
    const ORG_B = '00000000-0000-4000-8000-00000000000b'
    const r = run({
      matched: 'none', why: 'ambiguous', optOut: true, suppressed: false, optOutNotRecorded: true,
      optOutNotRecordedIn: [{ orgId: ORG, contactId: 'c-a' }, { orgId: ORG_B, contactId: 'c-b' }],
    })
    r.releaseAlarm()
    expect(await r.answer).toMatchObject({ status: 500 })
    expect(r.alarms).toEqual([
      { kind: 'opt_out_not_recorded', orgId: ORG, touchId: null, contactId: 'c-a', path: 'reply' },
      { kind: 'opt_out_not_recorded', orgId: ORG_B, touchId: null, contactId: 'c-b', path: 'reply' },
    ])
    expect(r.w.logs[0]!.fields).toEqual({ why: 'ambiguous', orgConfigured: true, alarm: 'raised', orgs: 2 })
  })

  it('still answers 200 when the host cannot schedule the notice', async () => {
    const w = world()
    const answer = await handleDoveSoftMo(fields({ mobile: NUMBER, message: 'hi' }), shape, NOW, {
      ...w.deps,
      record: async () => filed(),
      alarm: async () => {},
      later: () => {
        throw new Error('no waitUntil')
      },
    })
    expect(answer.status).toBe(200)
    expect(w.logs).toEqual([{ level: 'warn', message: 'reply notification not scheduled', fields: { error: 'Error' } }])
  })

  /** The alarm a STOP filed under nobody raises: no message row, so no touch and no contact. */
  const UNPLACED_ALARM = { kind: 'opt_out_not_recorded', orgId: ORG, touchId: null, contactId: null, path: 'reply' } as const
  /** Where the recorder could not suppress it: the deployment's org, holding no contact at the number. */
  const IN_ORG = [{ orgId: ORG, contactId: null }]

  it('answers a number it could not read 400, so DoveSoft retries — the recorder has taken the loud path', async () => {
    const r = run({ matched: 'none', why: 'unreadable_number', optOut: true, suppressed: false, optOutNotRecorded: true, optOutNotRecordedIn: IN_ORG })
    r.releaseAlarm()
    expect(await r.answer).toMatchObject({ status: 400, body: { why: 'unreadable_number' } })
    expect(r.w.logs[0]).toMatchObject({ level: 'error', fields: { optOut: true, optOutNotRecorded: true, alarm: 'raised' } })
    expect(r.alarms).toEqual([UNPLACED_ALARM])
    expect(r.w.everything()).not.toContain('9876543210')
  })

  it('answers a STOP nobody could suppress 500, so the retry re-attempts it', async () => {
    const r = run({ matched: 'none', why: 'no_contact', optOut: true, suppressed: false, optOutNotRecorded: true, optOutNotRecordedIn: IN_ORG })
    r.releaseAlarm()
    expect(await r.answer).toMatchObject({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(r.w.logs[0]!.message).toContain('OPT-OUT NOT RECORDED')
  })

  /**
   * The follow-up: the alarm needed a touch, so a STOP from a number no
   * single contact holds — nobody, or several people — reached nobody in
   * real time. It is AWAITED as the filed one is, the 500 is kept, and the
   * message it posts names no number and links to /compliance.
   */
  it.each(['no_contact', 'ambiguous'] as const)(
    'awaits the alarm for a %s STOP nobody could suppress before it answers 500',
    async (why) => {
      const r = run({ matched: 'none', why, optOut: true, suppressed: false, optOutNotRecorded: true, optOutNotRecordedIn: IN_ORG })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(r.alarms).toEqual([UNPLACED_ALARM])
      expect(r.answered()).toBe(false)
      r.releaseAlarm()
      expect(await r.answer).toMatchObject({ status: 500, body: { error: 'opt-out not recorded', why } })
      expect(r.later).toEqual([])
      expect(r.w.logs).toEqual([
        {
          level: 'error',
          message: 'OPT-OUT NOT RECORDED — a STOP from a number no single contact holds could not be suppressed',
          fields: { why, orgConfigured: true, alarm: 'raised' },
        },
      ])
      const wire = JSON.stringify(slackMessage(r.alarms[0]!, 'https://x.test'))
      expect(wire).toContain('https://x.test/compliance')
      expect(wire).not.toContain('9876543210')
      expect(wire).not.toContain('DECOY')
    },
  )

  /** Without DOVESOFT_ORG_ID there is no org to file the alarm under; the line says it was not raised. */
  it('says no alarm was raised when the deployment names no org, and still answers 500', async () => {
    const r = run({ matched: 'none', why: 'no_contact', optOut: true, suppressed: false, optOutNotRecorded: true, optOutNotRecordedIn: [] }, undefined, null)
    expect(await r.answer).toMatchObject({ status: 500 })
    expect(r.alarms).toEqual([])
    expect(r.w.logs[0]!.fields).toEqual({ why: 'no_contact', orgConfigured: false, alarm: 'not_raised_no_org' })
  })

  it('raises nothing for a STOP filed under nobody that WAS suppressed, or for words that were not a STOP', async () => {
    for (const outcome of [
      { matched: 'none', why: 'no_contact', optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] },
      { matched: 'none', why: 'no_contact', optOut: false, suppressed: false, optOutNotRecorded: false, optOutNotRecordedIn: [] },
      { matched: 'none', why: 'unreadable_number', optOut: false, suppressed: false, optOutNotRecorded: false, optOutNotRecordedIn: [] },
    ] as const) {
      const r = run(outcome)
      await r.answer
      expect(r.alarms).toEqual([])
      expect(JSON.stringify(r.w.logs)).not.toContain('"alarm"')
    }
  })

  it('answers a text it filed under nobody 200 — the answer to a delivery, not a failure of one', async () => {
    for (const why of ['no_contact', 'ambiguous', 'duplicate'] as const) {
      const r = run({ matched: 'none', why, optOut: true, suppressed: true, optOutNotRecorded: false, optOutNotRecordedIn: [] })
      expect(await r.answer).toEqual({ status: 200, body: { matched: 'none', why, optOut: true, suppressed: true } })
    }
  })

  it('answers an unreadable text 400 with sms.inbound_unreadable, and the words and the number go nowhere', async () => {
    // The words are here, under a name nobody listed; the number is missing.
    const r = run(filed(), fields({ phone: NUMBER, msg: WORDS }))
    const answer = await r.answer
    expect(answer).toEqual({
      status: 400,
      body: { error: 'unreadable inbound text', why: 'missing_fields', missing: ['from', 'text'] },
    })
    expect(r.recorded).toEqual([])
    expect(r.w.audits).toEqual([{ action: 'sms.inbound_unreadable', detail: { why: 'missing_fields', missing: ['from', 'text'] } }])
    expect(r.w.logs).toHaveLength(1)
    expect(r.w.logs[0]!.message).toContain('it may have been a STOP')
    expect(r.w.logs[0]!.fields).toMatchObject({ fields: ['phone', 'msg'], audited: true, bytes: 120 })
    const all = r.w.everything()
    expect(all).not.toContain('DECOY-WORDS')
    expect(all).not.toContain('9876543210')
  })

  it('answers a body it could not parse 400 too', async () => {
    const r = run(filed(), { ok: false, why: 'unreadable_body' })
    expect(await r.answer).toMatchObject({ status: 400, body: { why: 'unreadable_body' } })
    expect(r.w.audits).toEqual([{ action: 'sms.inbound_unreadable', detail: { why: 'unreadable_body' } }])
  })

  /** Too large to read is still a text nobody read — loud, and never a silent 413. */
  it('answers a text too large to read 413, audited and logged like any unreadable one', async () => {
    const r = run(filed(), { ok: false, why: 'too_large' })
    expect(await r.answer).toMatchObject({ status: 413, body: { why: 'too_large' } })
    expect(r.w.audits).toEqual([{ action: 'sms.inbound_unreadable', detail: { why: 'too_large' } }])
    expect(r.w.logs[0]!.level).toBe('error')
    expect(r.recorded).toEqual([])
  })
})

/**
 * A fault while recording. drizzle's error message lists every bound
 * parameter — the number and the words — and Next `console.error`s an
 * escaping error whole, so it used to reach the platform log; and a STOP
 * that failed this way left no audit row and raised no alarm.
 */
describe('a fault while recording', () => {
  /** Shaped like drizzle's DrizzleQueryError: the SQL, then every parameter. */
  class DrizzleQueryError extends Error {
    override name = 'DrizzleQueryError'
  }
  const fault = (words: string) =>
    new DrizzleQueryError(`Failed query: insert into "touches" … params: org,contact,sms,in,replied,,${words},${NUMBER},mo-1`)

  const UNPLACED_ALARM = { kind: 'opt_out_not_recorded', orgId: ORG, touchId: null, contactId: null, path: 'reply' } as const

  function mo(words: string, orgId: string | null = ORG) {
    const w = world(orgId)
    const alarms: NotificationEvent[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let answered = false
    const answer = handleDoveSoftMo(fields({ mobile: '919876543210', message: words }), shape, NOW, {
      ...w.deps,
      record: async () => {
        throw fault(words)
      },
      alarm: async (event) => {
        alarms.push(event)
        await gate
      },
      later: () => {
        throw new Error('no reply notice for a text nobody recorded')
      },
    }).then((a) => {
      answered = true
      return a
    })
    return { w, alarms, answer, release, answered: () => answered }
  }

  it('answers a delivery report 500, so DoveSoft retries, and logs the fault’s class only', async () => {
    const w = world()
    const answer = await handleDoveSoftDlr(fields({ messageid: 'm-9', errorstatus: 'UNDELIV', errorreason: WORDS }), shape, {
      ...w.deps,
      record: async () => {
        throw fault(WORDS)
      },
    })
    expect(answer).toEqual({ status: 500, body: { error: 'delivery report not recorded' } })
    expect(w.logs).toEqual([
      {
        level: 'error',
        message: 'DoveSoft delivery report could not be recorded; it was refused so DoveSoft retries',
        fields: { error: 'DrizzleQueryError', status: 'failed' },
      },
    ])
    expect(w.everything()).not.toContain('DECOY')
    expect(w.everything()).not.toContain('9876543210')
  })

  it('answers an ordinary text 500 and logs the fault’s class only — never the number or the words', async () => {
    const r = mo(WORDS.replace('STOP', 'Thanks for'))
    expect(await r.answer).toEqual({ status: 500, body: { error: 'inbound text not recorded' } })
    expect(r.alarms).toEqual([])
    expect(r.w.audits).toEqual([])
    expect(r.w.logs).toEqual([
      {
        level: 'error',
        message: 'DoveSoft inbound text could not be recorded; it was refused so DoveSoft retries',
        fields: { error: 'DrizzleQueryError', bytes: 120, contentType: 'application/x-www-form-urlencoded' },
      },
    ])
    expect(r.w.everything()).not.toContain('DECOY')
    expect(r.w.everything()).not.toContain('9876543210')
  })

  it('takes the loud path for a STOP: audits it, awaits the alarm, then answers 500', async () => {
    const r = mo('STOP')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.alarms).toEqual([UNPLACED_ALARM])
    expect(r.answered()).toBe(false)
    r.release()
    expect(await r.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(r.w.audits).toEqual([{ action: 'contact.opt_out_not_recorded', detail: { channel: 'sms', why: 'record_failed' } }])
    expect(r.w.logs).toEqual([
      {
        level: 'error',
        message: 'OPT-OUT NOT RECORDED — a text that asked to stop could not be recorded; follow up by hand',
        fields: { error: 'DrizzleQueryError', orgConfigured: true, audited: true, alarm: 'raised' },
      },
    ])
    expect(r.w.everything()).not.toContain('9876543210')
  })

  it('says no alarm was raised for such a STOP when no org is named, and still answers 500', async () => {
    const r = mo('Please stop texting me', null)
    expect(await r.answer).toMatchObject({ status: 500 })
    expect(r.alarms).toEqual([])
    expect(r.w.audits).toEqual([])
    expect(r.w.logs[0]!.fields).toEqual({ error: 'DrizzleQueryError', orgConfigured: false, audited: false, alarm: 'not_raised_no_org' })
  })

  /**
   * Review round 6, finding [18]: the recorder's rolled-back line names the
   * contact it was filing the STOP under, and the route threw it away — so a
   * known contact's STOP was alarmed as "nothing in the app holds the number"
   * and audited in DOVESOFT_ORG_ID, or nowhere.
   */
  const THEIR_ORG = '00000000-0000-4000-8000-0000000000f1'
  const THEIR_CONTACT = '00000000-0000-4000-8000-0000000000f2'
  function placedMo(lines: readonly { message: string; fields: Record<string, unknown> }[], orgId: string | null = ORG, pauseFails = false) {
    const w = world(orgId)
    const alarms: NotificationEvent[] = []
    const answer = handleDoveSoftMo(fields({ mobile: '919876543210', message: 'Not interested. STOP' }), shape, NOW, {
      ...w.deps,
      ...(pauseFails ? { pause: async () => { throw new Error('Connection terminated') } } : {}),
      record: async (args) => {
        for (const l of lines) args.log.error(l.message, l.fields)
        throw fault('Not interested. STOP')
      },
      alarm: async (event) => {
        alarms.push(event)
      },
      later: () => {
        throw new Error('no reply notice for a text nobody recorded')
      },
    })
    return { w, alarms, answer }
  }
  const rolledBack = {
    message: `${ROLLED_BACK_OPT_OUT_LINE}; a provider retry records it, otherwise follow up by hand`,
    fields: { contactId: THEIR_CONTACT, orgId: THEIR_ORG, inReplyTo: null, why: 'DrizzleQueryError' },
  }

  it.each([ORG, null])('audits, pauses and alarms under the contact the recorder named, in THEIR org (DOVESOFT_ORG_ID %s)', async (orgId) => {
    const r = placedMo([rolledBack], orgId)
    expect(await r.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(r.w.filed).toEqual([{ orgId: THEIR_ORG, action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: THEIR_CONTACT }])
    expect(r.w.audits).toEqual([{ action: 'contact.opt_out_not_recorded', detail: { channel: 'sms', why: 'record_failed' } }])
    expect(r.w.paused).toEqual([{ orgId: THEIR_ORG, contactId: THEIR_CONTACT, reason: `opt-out not recorded: reply ${NOW.toISOString()} (record_failed)` }])
    expect(pauseReasonClass(r.w.paused[0]!.reason)).toBe('opt_out_not_recorded')
    expect(r.alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: THEIR_ORG, touchId: null, contactId: THEIR_CONTACT, path: 'reply' }])
    const wire = JSON.stringify(slackMessage(r.alarms[0]!, 'https://x.test'))
    expect(wire).toContain('https://x.test/suppressions')
    expect(wire).not.toContain('Nothing in the app holds')
    expect(r.w.logs.at(-1)).toEqual({
      level: 'error',
      message: 'OPT-OUT NOT RECORDED — a text that asked to stop could not be recorded; follow up by hand',
      fields: { error: 'DrizzleQueryError', orgId: THEIR_ORG, contactId: THEIR_CONTACT, audited: true, paused: true, alarm: 'raised' },
    })
    expect(r.w.everything()).not.toContain('9876543210')
  })

  it('still raises the alarm when the pause fails too, and says so', async () => {
    const r = placedMo([rolledBack], ORG, true)
    expect(await r.answer).toMatchObject({ status: 500 })
    expect(r.alarms).toHaveLength(1)
    expect(r.w.logs.at(-1)!.fields).toMatchObject({ paused: false, alarm: 'raised' })
  })

  /** Another org's failed suppression names THAT org's contact; it is no evidence of whose this text was. */
  it('ignores every other OPT-OUT NOT RECORDED line, and takes the subject-less path when nothing named the filed contact', async () => {
    const r = placedMo([
      { message: 'OPT-OUT NOT RECORDED — follow up by hand', fields: { channel: 'sms', orgId: THEIR_ORG, contactId: THEIR_CONTACT, why: 'Error' } },
    ])
    expect(await r.answer).toMatchObject({ status: 500 })
    expect(r.w.filed).toEqual([{ orgId: ORG, action: 'contact.opt_out_not_recorded', subjectType: null, subjectId: null }])
    expect(r.w.paused).toEqual([])
    expect(r.alarms).toEqual([UNPLACED_ALARM])
  })

  /**
   * Review round 7, [0]/[4]/[8]: the recorder now says what it had written
   * when a STOP's recording threw. The contact it was filing under takes
   * the placed path — from the error, with no rolled-back line needed — and
   * every other org it had already taken the loud path in gets an alarm.
   */
  function typedMo(err: Error, orgId: string | null = ORG) {
    const w = world(orgId)
    const alarms: NotificationEvent[] = []
    const answer = handleDoveSoftMo(fields({ mobile: '919876543210', message: 'Wrong number. STOP' }), shape, NOW, {
      ...w.deps,
      record: async () => {
        throw err
      },
      alarm: async (event) => {
        alarms.push(event)
      },
      later: () => {
        throw new Error('no reply notice for a text nobody recorded')
      },
    })
    return { w, alarms, answer }
  }
  const ORG_B = '00000000-0000-4000-8000-0000000000b0'
  const CONTACT_B = '00000000-0000-4000-8000-0000000000b1'

  it('takes the placed path for the contact a STOP was being filed under, and alarms every other org the recorder named', async () => {
    const r = typedMo(new SmsOptOutNotRecorded('DrizzleQueryError', { orgId: THEIR_ORG, contactId: THEIR_CONTACT }, [{ orgId: ORG_B, contactId: CONTACT_B }], [ORG_B]))
    expect(await r.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(r.w.filed).toEqual([{ orgId: THEIR_ORG, action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: THEIR_CONTACT }])
    expect(r.w.paused).toEqual([{ orgId: THEIR_ORG, contactId: THEIR_CONTACT, reason: `opt-out not recorded: reply ${NOW.toISOString()} (record_failed)` }])
    expect(r.alarms).toEqual([
      { kind: 'opt_out_not_recorded', orgId: THEIR_ORG, touchId: null, contactId: THEIR_CONTACT, path: 'reply' },
      { kind: 'opt_out_not_recorded', orgId: ORG_B, touchId: null, contactId: CONTACT_B, path: 'reply' },
    ])
    expect(r.w.logs.at(-1)!.fields).toEqual({
      error: 'DrizzleQueryError', orgId: THEIR_ORG, contactId: THEIR_CONTACT, audited: true, paused: true, alarm: 'raised', otherOrgs: 1,
    })
  })

  it('never says nothing was written when the recorder held and loud-pathed contacts before the fault', async () => {
    const r = typedMo(new SmsOptOutNotRecorded('DrizzleQueryError', null, [{ orgId: THEIR_ORG, contactId: THEIR_CONTACT }, { orgId: ORG_B, contactId: CONTACT_B }], [THEIR_ORG]))
    expect(await r.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    // No subject-less row in DOVESOFT_ORG_ID: the recorder wrote each one under its contact.
    expect(r.w.filed).toEqual([])
    expect(r.w.paused).toEqual([])
    expect(r.alarms).toEqual([
      { kind: 'opt_out_not_recorded', orgId: THEIR_ORG, touchId: null, contactId: THEIR_CONTACT, path: 'reply' },
      { kind: 'opt_out_not_recorded', orgId: ORG_B, touchId: null, contactId: CONTACT_B, path: 'reply' },
    ])
    expect(r.w.logs).toEqual([
      {
        level: 'error',
        message: 'OPT-OUT NOT RECORDED — a text that asked to stop could not be recorded; follow up by hand',
        fields: { error: 'DrizzleQueryError', heldIn: 1, orgs: 2, alarm: 'raised' },
      },
    ])
    expect(JSON.stringify(r.alarms.map((a) => slackMessage(a, 'https://x.test')))).not.toContain('Nothing in the app holds')
  })

  /** Review round 7, [8]: a redelivery whose finishing faulted is not a STOP nobody recorded. */
  it('refuses a redelivery it could not finish 500, with no opt_out_not_recorded row and no alarm', async () => {
    for (const [orgId, contactId] of [[THEIR_ORG, THEIR_CONTACT], [null, null]] as const) {
      const r = typedMo(new SmsRedeliveryIncomplete('DrizzleQueryError', orgId, contactId))
      expect(await r.answer).toEqual({ status: 500, body: { error: 'inbound text not finished' } })
      expect(r.w.audits).toEqual([])
      expect(r.w.paused).toEqual([])
      expect(r.alarms).toEqual([])
      expect(r.w.logs).toEqual([
        {
          level: 'error',
          message: 'DoveSoft redelivered a text already recorded, and finishing it failed; it was refused so DoveSoft retries',
          fields: { error: 'DrizzleQueryError', orgId, contactId, bytes: 120, contentType: 'application/x-www-form-urlencoded' },
        },
      ])
      expect(r.w.everything()).not.toContain('9876543210')
    }
  })

  it('keeps the rolled-back line, and forwards every line it is handed', () => {
    const forwarded: string[] = []
    const kept = keepingRolledBackSmsOptOut({ error: (m) => forwarded.push(m) })
    expect(kept.rolledBack()).toBeNull()
    kept.error('OPT-OUT NOT RECORDED — follow up by hand', { orgId: 'o', contactId: 'c' })
    expect(kept.rolledBack()).toBeNull()
    kept.error(rolledBack.message, { orgId: 'o', contactId: null })
    expect(kept.rolledBack()).toBeNull()
    kept.error(rolledBack.message, rolledBack.fields)
    expect(kept.rolledBack()).toEqual({ orgId: THEIR_ORG, contactId: THEIR_CONTACT })
    expect(forwarded).toHaveLength(3)
  })
})

/**
 * The same, through the REAL recorder and a fault the engine raises: the
 * line the route keeps is the one `recordInboundReply` actually writes, so a
 * rewording there fails here rather than going quiet.
 */
describe('a STOP whose recording threw, through the real recorder', () => {
  let test: TestDb
  let db: AgencyDb
  let theirOrg: string
  let deploymentOrg: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [o] = await db.insert(schema.orgs).values({ name: 'Their agency' }).returning({ id: schema.orgs.id })
    theirOrg = o!.id
    const [d] = await db.insert(schema.orgs).values({ name: 'The DoveSoft account’s org' }).returning({ id: schema.orgs.id })
    deploymentOrg = d!.id
    const [co] = await db.insert(schema.companies).values({ orgId: theirOrg, domain: 'acme.example' }).returning({ id: schema.companies.id })
    const [c] = await db.insert(schema.contacts).values({ orgId: theirOrg, companyId: co!.id, phone: NUMBER }).returning({ id: schema.contacts.id })
    contactId = c!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const deliver = async (alarms: NotificationEvent[]) => {
    const w = world(deploymentOrg)
    const answer = await handleDoveSoftMo(fields({ mobile: '919876543210', message: 'Not interested. Stop', messageid: 'mo-1' }), shape, NOW, {
      ...w.deps,
      audit: async (entry) => {
        await appendAudit(db, entry)
      },
      log: w.deps.log,
      record: (args) => recordInboundSms(db, args),
      pause: (p) => pauseContactOverriding(db, p.orgId, p.contactId, p.reason, p.now),
      alarm: async (event) => {
        alarms.push(event)
      },
      later: () => {},
    })
    return { answer, w }
  }

  it('files the loud path under the contact in their org, then the retry records the STOP', async () => {
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const alarms: NotificationEvent[] = []
    const first = await deliver(alarms)
    expect(first.answer.status).toBe(500)
    const rows = (await db.select().from(schema.auditLog)).filter((r) => r.action === 'contact.opt_out_not_recorded')
    expect(rows.map((r) => [r.orgId, r.subjectType, r.subjectId, r.detail])).toEqual([
      [theirOrg, 'contact', contactId, { channel: 'sms', why: 'record_failed' }],
    ])
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
    expect(pauseReasonClass(c!.pausedReason)).toBe('opt_out_not_recorded')
    expect(alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: theirOrg, touchId: null, contactId, path: 'reply' }])
    // DoveSoft retries; the fault is gone, and the STOP is recorded with its suppression.
    const again = await deliver([])
    expect(again.answer).toMatchObject({ status: 200, body: { matched: 'contact', suppressed: true } })
    expect((await db.select().from(schema.suppressions)).map((r) => [r.orgId, r.value])).toEqual([[theirOrg, NUMBER]])
  })
})

/**
 * Review round 7, through the REAL recorder and faults the engine raises:
 * a number two orgs hold, a STOP filed under the one this system texted.
 */
describe('a STOP from a number two orgs hold, through the real recorder', () => {
  let test: TestDb
  let db: AgencyDb
  let orgA: string
  let orgB: string
  let deploymentOrg: string
  let work: string
  let inB: string

  async function contactIn(orgId: string, firstName: string): Promise<string> {
    const [co] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'acme.example' })
      .onConflictDoNothing()
      .returning({ id: schema.companies.id })
    const companyId = co?.id ?? (await db.select().from(schema.companies).where(eq(schema.companies.orgId, orgId)))[0]!.id
    const [c] = await db.insert(schema.contacts).values({ orgId, companyId, firstName, phone: NUMBER }).returning({ id: schema.contacts.id })
    return c!.id
  }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const org = async (name: string) => (await db.insert(schema.orgs).values({ name }).returning({ id: schema.orgs.id }))[0]!.id
    orgA = await org('Agency A')
    orgB = await org('Agency B')
    deploymentOrg = await org('The DoveSoft account’s org')
    work = await contactIn(orgA, 'Jo (work)')
    inB = await contactIn(orgB, 'Jo')
    // This system texted `work`: the evidence a reply from the number is theirs.
    await db.insert(schema.touches).values({
      orgId: orgA, contactId: work, channel: 'sms', direction: 'out', status: 'sent', body: 'Hi Jo', recipient: NUMBER,
      sentAt: new Date(NOW.getTime() - 86_400_000), providerId: 'ds-work',
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  async function deliver(recorderDb: AgencyDb = db) {
    const w = world(deploymentOrg)
    const alarms: NotificationEvent[] = []
    const later: NotificationEvent[] = []
    const answer = await handleDoveSoftMo(fields({ mobile: '919876543210', message: 'Wrong number. STOP', messageid: 'mo-1' }), shape, NOW, {
      ...w.deps,
      audit: async (entry) => {
        w.filed.push({ orgId: entry.orgId, action: entry.action, subjectType: entry.subjectType, subjectId: entry.subjectId })
        await appendAudit(db, entry)
      },
      record: (args) => recordInboundSms(recorderDb, args),
      pause: (p) => pauseContactOverriding(db, p.orgId, p.contactId, p.reason, p.now),
      alarm: async (event) => {
        alarms.push(event)
      },
      later: (event) => {
        later.push(event)
      },
    })
    return { answer, w, alarms, later }
  }
  const suppressedIn = async () =>
    (await db.select().from(schema.suppressions)).filter((r) => r.kind === 'phone' && r.value === NUMBER).map((r) => r.orgId).sort()
  const notRecorded = async () =>
    (await db.select().from(schema.auditLog))
      .filter((r) => r.action === 'contact.opt_out_not_recorded')
      .map((r) => [r.orgId, r.subjectId])
      .sort()
  const contact = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!

  /** Review round 7, [1]/[3]/[9]: the 500 brings the redelivery, and the redelivery writes what was missing. */
  it('answers 500 when another org’s suppression failed, and the redelivery writes it and answers 200', async () => {
    await failOnce(test.pg, { table: 'suppressions', event: 'INSERT', when: `NEW.org_id = '${orgB}'` })
    const first = await deliver()
    expect(first.answer).toMatchObject({ status: 500, body: { error: 'opt-out not recorded', matched: 'contact', duplicate: false, suppressed: true } })
    expect(first.alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: orgB, touchId: null, contactId: inB, path: 'reply' }])
    // Org A's reply was recorded whole: its notice stands.
    expect(first.later).toEqual([expect.objectContaining({ kind: 'reply', orgId: orgA, contactId: work, suppressed: true })])
    expect(await suppressedIn()).toEqual([orgA])

    const again = await deliver()
    expect(again.answer).toEqual({ status: 200, body: { matched: 'contact', duplicate: true, paused: false, suppressed: true } })
    expect(again.alarms).toEqual([])
    expect(again.later).toEqual([])
    expect(await suppressedIn()).toEqual([orgA, orgB].sort())
  })

  /**
   * Review round 7, [0]/[4], the reviewer's probe: a twin of `work` in org
   * A, and the STOP's inbound insert faults. The twin and inB were left
   * with a hold a teammate could lift; org B had no suppression and no row.
   */
  it('leaves the twin unresumable and org B suppressed when the STOP’s recording throws, and alarms only org A', async () => {
    const twin = await contactIn(orgA, 'Jo (personal)')
    await failOnce(test.pg, { table: 'touches', event: 'INSERT', when: `NEW.direction = 'in'` })
    const first = await deliver()
    expect(first.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(first.alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId: orgA, touchId: null, contactId: work, path: 'reply' }])
    expect(await suppressedIn()).toEqual([orgB])
    expect(await notRecorded()).toEqual([[orgA, twin], [orgA, work]].sort())
    // No subject-less row: whose it was is known.
    expect(first.w.filed.filter((f) => f.orgId === deploymentOrg)).toEqual([])
    for (const id of [work, twin]) expect(pauseReasonClass((await contact(id)).pausedReason)).toBe('opt_out_not_recorded')
    const t = await contact(twin)
    expect(await contactResumeByHand(db, { orgId: orgA, contact: { id: twin }, expectedReason: t.pausedReason, actor: 'someone' })).toMatchObject({ ok: false })
    // DoveSoft retries; the STOP is recorded in both orgs.
    const again = await deliver()
    expect(again.answer).toMatchObject({ status: 200, body: { matched: 'contact', duplicate: false, suppressed: true } })
    expect(await suppressedIn()).toEqual([orgA, orgB].sort())
  })

  /**
   * Review round 7, [8], the probe: the STOP was recorded, and a redelivery's
   * finishing read faults. It took the subject-less path — "nothing was
   * written … nobody was paused" in DOVESOFT_ORG_ID, and an alarm saying
   * nothing in the app holds the number — while both stood.
   */
  it('refuses a redelivery whose finishing faulted, with no false row and no alarm', async () => {
    expect((await deliver()).answer.status).toBe(200)
    let selects = 0
    const faulty = new Proxy(db as object, {
      get(t, p, r) {
        if (p === 'select') {
          return (...args: unknown[]) => {
            if (++selects === 2) throw Object.assign(new Error(`Failed query … params: ${NUMBER},STOP`), { name: 'DrizzleQueryError' })
            return (Reflect.get(t, p, r) as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        return Reflect.get(t, p, r)
      },
    }) as AgencyDb
    const again = await deliver(faulty)
    expect(again.answer).toEqual({ status: 500, body: { error: 'inbound text not finished' } })
    expect(again.alarms).toEqual([])
    expect(await notRecorded()).toEqual([])
    expect(again.w.logs).toEqual([
      expect.objectContaining({ level: 'error', fields: expect.objectContaining({ error: 'DrizzleQueryError', orgId: orgA, contactId: work }) }),
    ])
    expect(again.w.everything()).not.toContain('9876543210')
    // The truth it no longer contradicts.
    expect(await suppressedIn()).toEqual([orgA, orgB].sort())
    expect((await contact(work)).pausedAt).not.toBeNull()
  })

  /** Review round 7, [8]'s second route: holds that committed in one org before the next one's faulted. */
  it('alarms each org, and files no subject-less row, when the holds of a STOP filed under nobody fail part way', async () => {
    // Nobody texted: the STOP is filed under nobody, and both are held — the first org's hold commits, the second's faults.
    await db.delete(schema.touches)
    await test.pg.exec(`
      CREATE SEQUENCE second_contact_update_seq;
      CREATE FUNCTION second_contact_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('second_contact_update_seq') = 2 THEN RAISE EXCEPTION 'injected fault on UPDATE contacts'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER second_contact_update BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION second_contact_update();
    `)
    const first = await deliver()
    expect(first.answer).toEqual({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(first.alarms.map((a) => a.kind === 'opt_out_not_recorded' && [a.orgId, a.contactId]).sort()).toEqual([[orgA, work], [orgB, inB]].sort())
    expect(first.w.filed).toEqual([])
    expect(await notRecorded()).toEqual([[orgA, work], [orgB, inB]].sort())
    expect(first.w.logs.at(-1)!.fields).toMatchObject({ heldIn: 1, orgs: 2, alarm: 'raised' })
    const again = await deliver()
    expect(again.answer).toMatchObject({ status: 200, body: { matched: 'none', why: 'ambiguous', suppressed: true } })
  })
})

describe('the Slack events an inbound text raises', () => {
  const outcome: InboundSmsOutcome & { decoy: string } = {
    matched: 'contact',
    orgId: ORG,
    contactId: '00000000-0000-4000-8000-000000000001',
    touchId: '00000000-0000-4000-8000-000000000002',
    duplicate: false,
    paused: true,
    suppressed: true,
    cancelled: 2,
    replyKind: 'opted_out',
    optOutNotRecorded: false,
    optOutNotRecordedIn: [],
    companyId: '00000000-0000-4000-8000-00000000000c',
    companyDomain: 'acme.example',
    decoy: `${NUMBER} ${WORDS}`,
  }

  it('names ids, the domain and the kind — never the number or the words', () => {
    const event = smsReplyNotification(outcome)
    expect(event).toEqual({
      kind: 'reply', orgId: ORG, contactId: outcome.contactId, touchId: outcome.touchId,
      companyDomain: 'acme.example', replyKind: 'opted_out', paused: true, suppressed: true,
    })
    const wire = JSON.stringify(slackMessage(event!, 'https://x.test'))
    expect(wire).not.toContain('9876543210')
    expect(wire).not.toContain('DECOY')
  })

  it('raises the alarm only for a STOP that could not be recorded', () => {
    expect(smsOptOutAlarms(outcome)).toEqual([])
    expect(smsOptOutAlarms({ ...outcome, optOutNotRecorded: true })).toEqual([
      { kind: 'opt_out_not_recorded', orgId: ORG, touchId: outcome.touchId, contactId: outcome.contactId, path: 'reply' },
    ])
    expect(smsReplyNotification({ ...outcome, optOutNotRecorded: true })).toBeNull()
    // A duplicate says it only when its re-attempt failed again (review
    // round 7), and that is raised again, as the first delivery's was.
    expect(smsOptOutAlarms({ ...outcome, duplicate: true })).toEqual([])
    expect(smsOptOutAlarms({ ...outcome, optOutNotRecorded: true, duplicate: true })).toEqual([
      { kind: 'opt_out_not_recorded', orgId: ORG, touchId: outcome.touchId, contactId: outcome.contactId, path: 'reply' },
    ])
    expect(smsReplyNotification({ ...outcome, optOutNotRecorded: true, duplicate: true })).toBeNull()
  })

  /** Filed under nobody: no touch, no contact, in the org where it failed — and none with no org. */
  it('raises it for a STOP filed under nobody, in the org the recorder could not suppress it in', () => {
    const unplaced = {
      matched: 'none', why: 'no_contact', optOut: true, suppressed: false, optOutNotRecorded: true,
      optOutNotRecordedIn: [{ orgId: ORG, contactId: null }], decoy: `${NUMBER} ${WORDS}`,
    } as const
    const [event, ...more] = smsOptOutAlarms(unplaced)
    expect(more).toEqual([])
    expect(event).toEqual({ kind: 'opt_out_not_recorded', orgId: ORG, touchId: null, contactId: null, path: 'reply' })
    expect(smsOptOutAlarms({ ...unplaced, optOutNotRecordedIn: [] })).toEqual([])
    expect(smsOptOutAlarms({ ...unplaced, optOutNotRecorded: false, suppressed: true, optOutNotRecordedIn: [] })).toEqual([])
    const wire = JSON.stringify(slackMessage(event!, 'https://x.test'))
    expect(wire).not.toContain('9876543210')
    expect(wire).not.toContain('DECOY')
  })
})

describe('the routes are the wiring and nothing more', () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const DLR = read('../src/app/api/inbound/dovesoft/dlr/route.ts')
  const SMS = read('../src/app/api/inbound/dovesoft/sms/route.ts')

  it.each([['dlr', DLR], ['sms', SMS]])('%s answers GET and POST, authenticates before it reads, and logs no request', (_n, src) => {
    expect(src).toMatch(/^export async function POST\(/m)
    expect(src).toMatch(/^export async function GET\(/m)
    expect(src.indexOf('authoriseDoveSoft(')).toBeLessThan(src.indexOf('readDoveSoftRequest('))
    expect(src).toContain('e.DOVESOFT_WEBHOOK_SECRET')
    expect(src).toContain('orgId: e.DOVESOFT_ORG_ID ?? null')
    expect(src).not.toMatch(/log\.(info|warn|error)\(/)
  })

  it('awaits the alarm and schedules only the ordinary notice', () => {
    expect(SMS).toContain('alarm: (event) => notify(event)')
    expect(SMS).toContain('later: (event) => after(() => notify(event))')
  })

  it.each([['dlr', DLR], ['sms', SMS]])('%s logs its first refused token, by the route’s name, before it answers 401', (name, src) => {
    expect(src).toContain(`logRefusalOnce('${name}', auth, log)`)
    expect(src.indexOf('logRefusalOnce(')).toBeLessThan(src.indexOf('readDoveSoftRequest('))
  })

  /** A GET push puts its fields in the URL: the inbound-text route says what that costs. */
  it('says a GET text puts the number and the words in the platform’s request log', () => {
    expect(SMS).toContain("SENDER'S NUMBER AND THE WORDS")
    expect(SMS).toContain('request log')
    expect(SMS).toContain('POST')
  })
})
