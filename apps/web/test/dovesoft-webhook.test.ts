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
import { describe, expect, it } from 'vitest'
import type { InboundSmsOutcome, SmsDeliveryOutcome } from '@agency/db/queries'
import {
  DLR_ID_FIELDS, DLR_STATUS_FIELDS, DOVESOFT_MAX_BODY_BYTES, MO_FROM_FIELDS, MO_ID_FIELDS, MO_TEXT_FIELDS,
  MO_TIME_FIELDS, MO_TO_FIELDS, authoriseDoveSoft, handleDoveSoftDlr, handleDoveSoftMo, readDlr, readDoveSoftRequest,
  readFields, readMo, readReceivedAt, readSender, type FieldsRead,
} from '../src/app/api/inbound/dovesoft/webhook'
import { smsOptOutNotRecordedNotification, smsReplyNotification } from '../src/app/api/inbound/dovesoft/notification'
import { slackMessage, type NotificationEvent } from '../src/lib/slack-message'

const SECRET = 'd'.repeat(40)
const ORG = '00000000-0000-4000-8000-00000000000a'
const NOW = new Date('2026-10-01T10:00:00.000Z')
const NUMBER = '+919876543210'
const WORDS = 'STOP sending me these DECOY-WORDS'

const fields = (o: Record<string, string>): FieldsRead => ({ ok: true, fields: new Map(Object.entries(o)) })
const shape = { bytes: 120, contentType: 'application/x-www-form-urlencoded' }

/** What a handler wrote, logged and announced. */
function world(orgId: string | null = ORG) {
  const audits: { action: string; detail: Record<string, unknown> }[] = []
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = []
  return {
    audits,
    logs,
    deps: {
      orgId,
      audit: async (e: { action: string; detail: Record<string, unknown> }) => {
        audits.push({ action: e.action, detail: e.detail })
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

  it('maps DELIVRD to delivered, whatever its case', () => {
    for (const word of ['DELIVRD', 'delivrd']) {
      expect(readDlr(new Map([['messageid', 'm-1'], ['errorstatus', word]]))).toEqual({
        ok: true, providerMessageId: 'm-1', status: 'delivered', reason: null,
      })
    }
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
    companyId: '00000000-0000-4000-8000-00000000000c',
    companyDomain: 'acme.example',
    ...over,
  })

  function run(outcome: InboundSmsOutcome | (() => Promise<InboundSmsOutcome>), read: FieldsRead = fields({ mobile: '919876543210', message: WORDS })) {
    const w = world()
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
   * drops anything scheduled after it.
   */
  it('awaits the opt_out_not_recorded alarm before it answers, in place of the reply notice', async () => {
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
    expect((await r.answer).status).toBe(200)
    expect(r.later).toEqual([])
  })

  it('raises nothing for a retried push', async () => {
    const r = run(filed({ duplicate: true, optOutNotRecorded: false }))
    expect((await r.answer).status).toBe(200)
    expect(r.alarms).toEqual([])
    expect(r.later).toEqual([])
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

  it('answers a number it could not read 400, so DoveSoft retries — the recorder has taken the loud path', async () => {
    const r = run({ matched: 'none', why: 'unreadable_number', optOut: true, suppressed: false, optOutNotRecorded: true })
    expect(await r.answer).toMatchObject({ status: 400, body: { why: 'unreadable_number' } })
    expect(r.w.logs[0]).toMatchObject({ level: 'error', fields: { optOut: true, optOutNotRecorded: true } })
    expect(r.w.everything()).not.toContain('9876543210')
  })

  it('answers a STOP nobody could suppress 500, so the retry re-attempts it', async () => {
    const r = run({ matched: 'none', why: 'no_contact', optOut: true, suppressed: false, optOutNotRecorded: true })
    expect(await r.answer).toMatchObject({ status: 500, body: { error: 'opt-out not recorded' } })
    expect(r.w.logs[0]!.message).toContain('OPT-OUT NOT RECORDED')
  })

  it('answers a text it filed under nobody 200 — the answer to a delivery, not a failure of one', async () => {
    for (const why of ['no_contact', 'ambiguous', 'duplicate'] as const) {
      const r = run({ matched: 'none', why, optOut: true, suppressed: true, optOutNotRecorded: false })
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

  it('raises the alarm only for a STOP that could not be recorded, filed under a contact', () => {
    expect(smsOptOutNotRecordedNotification(outcome)).toBeNull()
    expect(smsOptOutNotRecordedNotification({ ...outcome, optOutNotRecorded: true })).toMatchObject({
      kind: 'opt_out_not_recorded', path: 'reply',
    })
    expect(smsReplyNotification({ ...outcome, optOutNotRecorded: true })).toBeNull()
    expect(smsOptOutNotRecordedNotification({ ...outcome, optOutNotRecorded: true, duplicate: true })).toBeNull()
    expect(
      smsOptOutNotRecordedNotification({ matched: 'none', why: 'no_contact', optOut: true, suppressed: false, optOutNotRecorded: true }),
    ).toBeNull()
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
})
