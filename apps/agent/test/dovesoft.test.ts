/**
 * The DoveSoft SMS provider, against a fetch that records and never sends.
 *
 * What is pinned: the request is exactly DoveSoft's published one; every
 * refusal happens BEFORE a request; a failure carries a name and a status
 * and never the response body (which may echo the message) or the key; and
 * the two pure readers — the number DoveSoft is given, and when a text goes
 * as unicode — say what they say.
 *
 * The key below is distinctive on purpose. Every failure path, every log
 * line and the provider object itself are searched for it.
 */
import { describe, it, expect } from 'vitest'
import {
  createDoveSoftProvider, DoveSoftError, dovesoftMobile, doveSoftConfigFrom, messageIdFrom, needsUnicode,
  type DoveSoftConfig,
} from '../src/outreach/dovesoft.js'
import { senderProvidersFrom } from '../src/worker.js'
import { loadEnv } from '../src/env.js'
import type { MessageTemplateRegistration } from '@agency/db'

const KEY = 'dsk-NEVER-LOG-7f3a9c-SECRET-KEY'
const ENTITY = '1101234567890123456'
const PHONE = '+919812345678'
const TEMPLATE: MessageTemplateRegistration = {
  externalId: '1107160000000012345',
  senderId: 'ACMEIN',
  category: 'service_explicit',
  language: 'en',
}
const WORDS = 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.'

interface Call {
  readonly url: URL
  readonly init: RequestInit
}

/** A fetch that records each request and answers with `answer`. */
function recordingFetch(answer: () => Response | Promise<Response> = () => json({ messageid: 'DS-0001' })) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} })
    return answer()
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const provider = (over: Partial<DoveSoftConfig> = {}, f = recordingFetch()) => ({
  f,
  p: createDoveSoftProvider({ apiKey: KEY, entityId: ENTITY, baseUrl: 'https://api.dovesoft.io', fetch: f.fetch, ...over }),
})

const send = (p: ReturnType<typeof createDoveSoftProvider>, over: Record<string, unknown> = {}) =>
  p.send({ to: PHONE, subject: '', body: WORDS, template: TEMPLATE, ...over } as Parameters<typeof p.send>[0])

/** The thrown error, asserted to be ours and to carry neither the key nor what DoveSoft said. */
async function failure(promise: Promise<unknown>, mustNotContain: readonly string[] = []): Promise<DoveSoftError> {
  let caught: unknown
  try {
    await promise
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(DoveSoftError)
  const err = caught as DoveSoftError
  for (const text of [err.message, err.name, String(err), err.stack ?? '', JSON.stringify(err)]) {
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(PHONE.slice(1))
    for (const needle of mustNotContain) expect(text).not.toContain(needle)
  }
  return err
}

describe('the request', () => {
  it('is DoveSoft’s published sendsms call, exactly', async () => {
    const { p, f } = provider()
    expect(await send(p)).toEqual({ providerId: 'DS-0001' })

    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]!
    expect(`${url.origin}${url.pathname}`).toBe('https://api.dovesoft.io/api/json/sendsms/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      senderid: 'ACMEIN',
      unicode: '0',
      entityid: ENTITY,
      tempid: '1107160000000012345',
    })
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ key: KEY, 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      listsms: [{ sms: WORDS, mobiles: '919812345678', senderid: 'ACMEIN' }],
    })
    // One attempt, bounded, and a redirect would carry the key elsewhere.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('error')
  })

  it('appends the path to a base URL with a prefix or a trailing slash', async () => {
    for (const baseUrl of ['https://api.dovesoft.io/', 'https://gw.example.com/sms//']) {
      const { p, f } = provider({ baseUrl })
      await send(p)
      const { url } = f.calls[0]!
      expect(url.pathname).toBe(baseUrl.includes('gw.') ? '/sms/api/json/sendsms/' : '/api/json/sendsms/')
    }
  })

  it('carries the key in the header and nowhere else in the request', async () => {
    const { p, f } = provider()
    await send(p)
    const { url, init } = f.calls[0]!
    expect(url.toString()).not.toContain(KEY)
    expect(String(init.body)).not.toContain(KEY)
  })

  it('asks for unicode exactly when a character is outside the GSM-7 basic set', async () => {
    for (const [body, unicode] of [
      [WORDS, '0'],
      ['Your OTP is 4821. Valid for 10 minutes — do not share.', '1'],
      ['₹500 off your renewal', '1'],
      ['नमस्ते Priya', '1'],
      ['Café at 3pm? Ça va.', '0'],
    ] as const) {
      const { p, f } = provider()
      await send(p, { body })
      expect(f.calls[0]!.url.searchParams.get('unicode'), body).toBe(unicode)
    }
  })

  it('names the first message id DoveSoft returns as the providerId', async () => {
    const { p } = provider({}, recordingFetch(() => json([{ mobile: '919812345678', messageid: 987654321 }])))
    expect(await send(p)).toEqual({ providerId: '987654321' })
  })
})

describe('refusing before any request', () => {
  it.each([
    ['no template', { template: undefined }],
    ['a sender id that is not a DLT header', { template: { ...TEMPLATE, senderId: 'ACME' } }],
    ['a lower-case header', { template: { ...TEMPLATE, senderId: 'acmein' } }],
    ['a template id with a URL character in it', { template: { ...TEMPLATE, externalId: '1107&tempid=2' } }],
    ['a national number with no country', { to: '9812345678' }],
    ['a recipient that is not a number', { to: 'priya@rentman.in' }],
    ['no words', { body: '   ' }],
  ])('%s', async (_why, over) => {
    const { p, f } = provider()
    const err = await failure(send(p, over))
    expect(err.name).toBe('DoveSoftRefusedError')
    expect(err.failure).toBe('refused')
    expect(err.status).toBeNull()
    expect(err.message).toMatch(/Nothing was sent/)
    expect(f.calls).toEqual([])
  })

  it.each([
    ['the key', { apiKey: '' }],
    ['the entity id', { entityId: '' }],
  ])('without %s', async (_why, over) => {
    const { p, f } = provider(over)
    const err = await failure(send(p))
    expect(err.name).toBe('DoveSoftNotConfiguredError')
    expect(err.message).toMatch(/DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID/)
    expect(f.calls).toEqual([])
  })
})

describe('failing without echoing', () => {
  /** What a gateway might say back: the words, the number, and the key it was given. */
  const ECHO = `{"error":"rejected","sms":"${WORDS}","mobiles":"919812345678","key":"${KEY}"}`

  it.each([400, 401, 403, 429, 500, 503])('on HTTP %i, with the status and never the body', async (status) => {
    const { p } = provider({}, recordingFetch(() => new Response(ECHO, { status })))
    const err = await failure(send(p), [WORDS, 'rejected'])
    expect(err.name).toBe('DoveSoftHttpError')
    expect(err.status).toBe(status)
    expect(err.message).toContain(String(status))
    expect(err.message).toMatch(/not confirmed/)
  })

  it.each([
    ['not JSON', 'OK sent'],
    ['JSON with no message id', ECHO],
    ['an id under another spelling', '{"messageId":"DS-1"}'],
    ['a blank id', '{"messageid":"  "}'],
    ['an empty body', ''],
    ['a body far longer than any answer', `{"pad":"${'x'.repeat(70_000)}","messageid":"DS-1"}`],
  ])('on a 2xx that is %s', async (_why, body) => {
    const { p } = provider({}, recordingFetch(() => new Response(body, { status: 200 })))
    const err = await failure(send(p), [WORDS, 'rejected', 'OK sent'])
    expect(err.name).toBe('DoveSoftResponseError')
    expect(err.status).toBe(200)
  })

  it('when nothing answers within the timeout', async () => {
    const never = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    const p = createDoveSoftProvider({ apiKey: KEY, entityId: ENTITY, baseUrl: 'https://api.dovesoft.io', fetch: never, timeoutMs: 20 })
    const err = await failure(send(p))
    expect(err.name).toBe('DoveSoftUnreachableError')
    expect(err.status).toBeNull()
    expect(err.message).toMatch(/did not answer within/)
    expect(err.message).toMatch(/may or may not have been accepted/)
  })

  it('when the network fails, without repeating what the network said', async () => {
    const broken = (async () => {
      throw new TypeError(`fetch failed for key ${KEY} and 919812345678`)
    }) as typeof fetch
    const p = createDoveSoftProvider({ apiKey: KEY, entityId: ENTITY, baseUrl: 'https://api.dovesoft.io', fetch: broken })
    const err = await failure(send(p))
    expect(err.name).toBe('DoveSoftUnreachableError')
    expect(err.message).toMatch(/could not be reached/)
    expect(err.cause).toBeUndefined()
  })

  it('keeps the key out of the provider object itself', () => {
    const { p } = provider()
    expect(JSON.stringify(p)).not.toContain(KEY)
    expect(Object.values(p).map(String).join(' ')).not.toContain(KEY)
    expect(p).toMatchObject({ name: 'dovesoft', channels: ['sms'] })
  })
})

describe('dovesoftMobile — the one assumption to confirm with DoveSoft', () => {
  it.each([
    ['+919812345678', '919812345678'],
    ['+91 98123 45678', '919812345678'],
    ['+91-98123-45678', '919812345678'],
    ['00919812345678', '919812345678'],
    ['+447700900123', '447700900123'],
  ])('reads %s as %s: the E.164 digits, no +', (raw, expected) => {
    expect(dovesoftMobile(raw)).toBe(expected)
  })

  it.each([['9812345678'], [''], ['   '], ['+1-800-FLOWERS'], ['+0123456789'], ['priya@rentman.in']])(
    'refuses %j rather than guessing a country',
    (raw) => {
      expect(dovesoftMobile(raw)).toBeNull()
    },
  )
})

describe('needsUnicode — GSM-7 basic set or not', () => {
  it.each([
    ['plain English', 'Your meeting is at 3pm. Reply STOP to opt out.', false],
    ['every accented letter the basic set holds', 'èéùìòÇØøÅåÆæßÉÄÖÑÜäöñüà¡¿', false],
    ['the Greek capitals it holds', 'ΔΦΓΛΩΠΨΣΘΞ', false],
    ['£ $ ¥ ¤ § @ and line breaks', '£5 $5 ¥5 ¤ § @home\r\nok', false],
    ['the empty string', '', false],
    ['the rupee sign', '₹500', true],
    ['Devanagari', 'नमस्ते', true],
    ['an emoji, read as one code point', 'see you 👋', true],
    ['the euro, which is only in the extension table', '€5', true],
    ['square brackets, extension table too', '[ref]', true],
    ['a curly quote', 'it’s', true],
    ['a tab', 'a\tb', true],
    ['a lower-case ç, which the basic set does not hold', 'ça', true],
    ['the escape character itself', 'a\u001bb', true],
  ])('%s', (_why, text, expected) => {
    expect(needsUnicode(text)).toBe(expected)
  })
})

describe('messageIdFrom', () => {
  it.each([
    ['a top-level string', { messageid: 'DS-1' }, 'DS-1'],
    ['a top-level number', { messageid: 42 }, '42'],
    ['the first in an array', [{ messageid: 'A' }, { messageid: 'B' }], 'A'],
    ['inside an object', { status: 'ok', data: { messageid: 'C' } }, 'C'],
    ['inside a list inside an object', { data: [{ mobile: '91…', messageid: 'D' }] }, 'D'],
    ['top level before a nested one', { data: { messageid: 'inner' }, messageid: 'outer' }, 'outer'],
  ])('reads %s', (_why, payload, expected) => {
    expect(messageIdFrom(payload)).toBe(expected)
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a bare string', 'DS-1'],
    ['no messageid', { status: 'ok' }],
    ['another spelling', { messageId: 'DS-1', MessageID: 'DS-2' }],
    ['a blank', { messageid: '' }],
    ['an object as the id', { messageid: { id: 1 } }],
    ['a boolean', { messageid: true }],
    ['NaN', { messageid: Number.NaN }],
    ['an id with a space in it', { messageid: 'two words' }],
    ['one buried too deep', { a: { b: { c: { d: { messageid: 'deep' } } } } }],
  ])('refuses %s', (_why, payload) => {
    expect(messageIdFrom(payload)).toBeNull()
  })
})

describe('configuration', () => {
  const BASE = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    AGENT_INTERNAL_TOKEN: 't'.repeat(32),
  }
  /** A logger that keeps its lines. */
  function keepingLog() {
    const lines: { level: string; msg: string; fields: Record<string, unknown> | undefined }[] = []
    const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields })
    return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  }
  const env = (vars: Record<string, string>) => loadEnv({ ...BASE, ...vars } as NodeJS.ProcessEnv)

  it('is on only with both the key and the entity id', () => {
    expect(doveSoftConfigFrom(env({ DOVESOFT_API_KEY: KEY, DOVESOFT_ENTITY_ID: ENTITY }))).toEqual({
      on: true,
      config: { apiKey: KEY, entityId: ENTITY, baseUrl: 'https://api.dovesoft.io' },
    })
    expect(doveSoftConfigFrom(env({ DOVESOFT_API_KEY: KEY }))).toEqual({ on: false, missing: ['DOVESOFT_ENTITY_ID'] })
    expect(doveSoftConfigFrom(env({ DOVESOFT_ENTITY_ID: ENTITY }))).toEqual({ on: false, missing: ['DOVESOFT_API_KEY'] })
    expect(doveSoftConfigFrom(env({}))).toEqual({ on: false, missing: ['DOVESOFT_API_KEY', 'DOVESOFT_ENTITY_ID'] })
  })

  it('says sms: dovesoft on once, and never the key or the entity id', () => {
    const log = keepingLog()
    const s = senderProvidersFrom(env({ DOVESOFT_API_KEY: KEY, DOVESOFT_ENTITY_ID: ENTITY }), log)
    expect(s.sms).toBe('on')
    expect(log.lines).toEqual([{ level: 'info', msg: 'sms: dovesoft on', fields: undefined }])
    expect(JSON.stringify(log.lines)).not.toContain(KEY)
    expect(JSON.stringify(log.lines)).not.toContain(ENTITY)
    expect(JSON.stringify(s)).not.toContain(KEY)
  })

  it('says sms: dovesoft off naming what is missing — a warning when half of it is set', () => {
    const half = keepingLog()
    expect(senderProvidersFrom(env({ DOVESOFT_API_KEY: KEY }), half).sms).toBe('off')
    expect(half.lines).toEqual([{ level: 'warn', msg: 'sms: dovesoft off', fields: { missing: ['DOVESOFT_ENTITY_ID'] } }])
    expect(JSON.stringify(half.lines)).not.toContain(KEY)

    const none = keepingLog()
    expect(senderProvidersFrom(env({}), none).sms).toBe('off')
    expect(none.lines).toEqual([
      { level: 'info', msg: 'sms: dovesoft off', fields: { missing: ['DOVESOFT_API_KEY', 'DOVESOFT_ENTITY_ID'] } },
    ])
  })

  /** LinkedIn is a person's; voice and WhatsApp have no provider here at all. */
  it.each([
    [{ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com', DOVESOFT_API_KEY: KEY, DOVESOFT_ENTITY_ID: ENTITY }, ['email', 'sms'], []],
    [{ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com' }, ['email'], ['sms']],
    [{ DOVESOFT_API_KEY: KEY, DOVESOFT_ENTITY_ID: ENTITY }, ['sms'], ['email']],
    [{}, [], ['email', 'sms']],
  ] as const)('hands the tick providers for %j and leaves the rest unserved', (vars, carried, unserved) => {
    const s = senderProvidersFrom(env(vars), keepingLog())
    const channels = s.providers.flatMap((p) => [...p.channels])
    expect(channels.sort()).toEqual([...carried])
    expect(channels).not.toContain('linkedin')
    expect(channels).not.toContain('voice')
    expect(channels).not.toContain('whatsapp')
    expect(s.unserved).toEqual(unserved)
  })
})
