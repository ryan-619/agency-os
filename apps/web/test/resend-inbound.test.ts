/**
 * Replies through Resend: the mapping, the fetch, and the route's whole
 * decision path with the network and the database injected.
 *
 * The route file itself cannot be imported by a test (it reaches
 * `server-only` through `@/lib/db`), so it is two things — `env()` and the
 * Slack message — around `receiveResendWebhook`, and that is what the last
 * block drives: the real signature check, the real fetch code against a
 * fake `fetch`, the real mapping, and a stand-in for `handleInboundEmail`
 * that records what it was handed.
 *
 * Three promises every case checks where it can: the API key and the
 * signing secret reach no log line and no answer; the message text reaches
 * no log line; and a message this system did not READ is never answered
 * with a 2xx, because Resend stops retrying on one and the unread message
 * might have said "stop".
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { htmlToText } from '@agency/core'
import { looksLikeOptOut, type InboundOutcome } from '@agency/db/queries'
import {
  RESEND_MAX_BODY,
  fetchReceivedEmail,
  mapReceivedEmail,
  receiveResendWebhook,
  type InboundMail,
  type ResendWebhookDeps,
} from '../src/lib/resend-inbound'

const SECRET = 'whsec_' + Buffer.from('a fixed endpoint signing secret').toString('base64')
const API_KEY = 're_TESTKEY_do_not_log_me_4f1c2b'
const EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'
const NOW = new Date('2026-09-30T10:00:00.000Z')
const BODY_TEXT = 'Happy to talk next week — my private phone is 555-0100.'

/** Modelled on the example in Resend's "Retrieve received email" reference. */
const RECEIVED = {
  object: 'email',
  id: EMAIL_ID,
  to: ['replies@outreach.agency.example'],
  from: 'Jane Doe <Jane.Doe@Acme.example>',
  created_at: '2026-09-30T09:59:58.000Z',
  subject: 'Re: Your security.txt',
  html: '<p>Happy to talk next week</p>',
  text: BODY_TEXT,
  headers: {
    'Return-Path': 'jane.doe@acme.example',
    'MIME-Version': '1.0',
    'In-Reply-To': '<out-2@agency.example>',
    References: '<out-1@agency.example>\r\n <out-2@agency.example>',
  },
  bcc: [],
  cc: [],
  reply_to: [],
  message_id: '<CAF=reply-1@mail.acme.example>',
  attachments: [],
}

describe('mapReceivedEmail', () => {
  it('maps the documented shape to what handleInboundEmail takes', () => {
    expect(mapReceivedEmail(RECEIVED)).toEqual({
      from: 'Jane.Doe@Acme.example',
      subject: 'Re: Your security.txt',
      text: BODY_TEXT,
      messageId: '<CAF=reply-1@mail.acme.example>',
      references: ['<out-2@agency.example>', '<out-1@agency.example>'],
      headers: {
        'return-path': 'jane.doe@acme.example',
        'mime-version': '1.0',
        'in-reply-to': '<out-2@agency.example>',
        references: '<out-1@agency.example>\r\n <out-2@agency.example>',
      },
      dsn: null,
    } satisfies InboundMail)
  })

  it.each([
    ['a display name', 'Jane Doe <jane@acme.example>'],
    ['a quoted display name with a comma', '"Doe, Jane" <jane@acme.example>'],
    ['a bare address', 'jane@acme.example'],
    ['surrounding space', '  jane@acme.example  '],
  ])('reads the address out of %s', (_label, from) => {
    expect(mapReceivedEmail({ ...RECEIVED, from })?.from).toBe('jane@acme.example')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not a string', { email: 'jane@acme.example' }],
    ['empty', ''],
    ['empty angle brackets', 'Jane Doe <>'],
  ])('answers null when from is %s — nothing can be filed without a sender', (_label, from) => {
    expect(mapReceivedEmail({ ...RECEIVED, from })).toBeNull()
  })

  it('answers null for something that is not an object', () => {
    for (const v of [null, undefined, 'text', 42, [RECEIVED]]) expect(mapReceivedEmail(v)).toBeNull()
  })

  it('uses the HTML, as text, when there is no plain part', () => {
    const m = mapReceivedEmail({ ...RECEIVED, text: null, html: '<div>Thanks &amp; yes,<br>Tuesday works.</div>' })
    expect(m?.text).toBe('Thanks & yes,\nTuesday works.')
  })

  it('treats a blank plain part as absent', () => {
    expect(mapReceivedEmail({ ...RECEIVED, text: '  \n ', html: '<p>Yes please</p>' })?.text).toBe('Yes please')
  })

  it('has null text when there is neither part', () => {
    expect(mapReceivedEmail({ ...RECEIVED, text: null, html: null })?.text).toBeNull()
    expect(mapReceivedEmail({ ...RECEIVED, text: null, html: '<p> </p>' })?.text).toBeNull()
  })

  it('bounds the text as the generic route does', () => {
    expect(mapReceivedEmail({ ...RECEIVED, text: 'x'.repeat(50_000) })?.text).toHaveLength(20_000)
  })

  it('folds header names to lower case, first value winning', () => {
    const m = mapReceivedEmail({
      ...RECEIVED,
      headers: { 'Auto-Submitted': 'auto-replied', 'auto-submitted': 'no', Received: ['by mx1', 'by mx2'], 'X-Count': 3 },
    })
    expect(m?.headers).toEqual({ 'auto-submitted': 'auto-replied', received: 'by mx1' })
  })

  it('bounds header values and refuses names that are not header names', () => {
    const m = mapReceivedEmail({ ...RECEIVED, headers: { 'X-Long': 'v'.repeat(5_000), 'bad name': 'x', 'bad:name': 'y' } })
    expect(m?.headers).toEqual({ 'x-long': 'v'.repeat(2_000) })
  })

  it('keeps a header named __proto__ as a header, not a prototype', () => {
    const m = mapReceivedEmail({ ...RECEIVED, headers: JSON.parse('{"__proto__": "x", "Precedence": "bulk"}') as unknown })
    expect(Object.getPrototypeOf(m?.headers)).toBe(Object.prototype)
    expect(m?.headers?.['precedence']).toBe('bulk')
    expect(Object.prototype.hasOwnProperty.call(m?.headers, '__proto__')).toBe(true)
  })

  it('puts In-Reply-To first, then References, split on folded whitespace, without repeats', () => {
    const m = mapReceivedEmail({
      ...RECEIVED,
      headers: { 'in-reply-to': '<b@x>', references: '<a@x>\r\n\t<b@x>   <c@x>' },
    })
    expect(m?.references).toEqual(['<b@x>', '<a@x>', '<c@x>'])
  })

  it('has no references when neither header is there', () => {
    expect(mapReceivedEmail({ ...RECEIVED, headers: undefined })?.references).toEqual([])
    expect(mapReceivedEmail({ ...RECEIVED, headers: [] })?.references).toEqual([])
  })

  it('reads References before the header is cut, keeping the newest ids of a long thread', () => {
    const chain = Array.from({ length: 150 }, (_, i) => `<thread-${i}@agency.example>`)
    const m = mapReceivedEmail({ ...RECEIVED, headers: { 'in-reply-to': '<parent@x>', references: chain.join(' ') } })
    expect(m?.references).toHaveLength(100)
    expect(m?.references?.[0]).toBe('<parent@x>')
    // Past the 2 000-character cut, and still read.
    expect(m?.references).toContain('<thread-149@agency.example>')
    expect(m?.references).not.toContain('<thread-0@agency.example>')
    expect(m?.headers?.['references']).toHaveLength(2_000)
  })

  it('falls back to the Message-ID header when the top-level field is absent', () => {
    expect(mapReceivedEmail({ ...RECEIVED, message_id: undefined, headers: { 'Message-ID': ' <h@x> ' } })?.messageId).toBe('<h@x>')
    expect(mapReceivedEmail({ ...RECEIVED, message_id: undefined, headers: {} })?.messageId).toBeNull()
  })

  it('never has a DSN: the receiving API lists attachments without inlining them', () => {
    expect(mapReceivedEmail(RECEIVED)?.dsn).toBeNull()
  })
})

/**
 * The converter is packages/core's, shared with the worker's IMAP listener;
 * its exact output is pinned in packages/core/test/html-text.test.ts. What is
 * asked here is what the Resend path hands the opt-out reader.
 */
describe('htmlToText, read by the opt-out reader', () => {
  /** What Gmail sends for a one-word reply above the quoted original. */
  const gmailStop =
    '<div dir="ltr">Stop</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
    'On Mon, 28 Sept 2026 at 09:00, Agency &lt;hello@agency.example&gt; wrote:<br></div>' +
    '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex">Hi Jane — we looked at acme.example from the outside.' +
    '<br>Reply stop and we will not write again.</blockquote></div>'

  it('keeps a one-word HTML opt-out on its own line, so it is read as one', () => {
    const text = htmlToText(gmailStop)
    expect(text.split('\n')[0]).toBe('Stop')
    expect(looksLikeOptOut(text)).toBe(true)
    // Flattened to one line, the same reply is not — which is what the
    // worker's IMAP fallback did before it used this converter, and why the
    // lines are kept.
    expect(looksLikeOptOut(text.replace(/\s+/g, ' '))).toBe(false)
  })

  it('does not read a quoted "unsubscribe" as the person’s own words', () => {
    const html =
      '<p>Sounds interesting, send me the details.</p><blockquote><p>unsubscribe</p></blockquote>'
    const text = htmlToText(html)
    expect(text).toContain('Sounds interesting')
    expect(looksLikeOptOut(text)).toBe(false)
  })
})

describe('fetchReceivedEmail', () => {
  const ok = (json: unknown): typeof fetch =>
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const status = (n: number, body = '{"name":"not_found","message":"Email not found"}'): typeof fetch =>
    vi.fn(async () => new Response(body, { status: n })) as unknown as typeof fetch
  const calls = (f: typeof fetch): [string, RequestInit][] => (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]

  it('asks the receiving API for exactly that message, with the key in the Authorization header only', async () => {
    const f = ok(RECEIVED)
    expect(await fetchReceivedEmail(API_KEY, EMAIL_ID, f)).toEqual({ ok: true, email: RECEIVED })
    const [url, init] = calls(f)[0]!
    expect(url).toBe(`https://api.resend.com/emails/receiving/${EMAIL_ID}`)
    expect(url).not.toContain(API_KEY)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reduces a refusal to its status, without reading the error body', async () => {
    const r = await fetchReceivedEmail(API_KEY, EMAIL_ID, status(404))
    expect(r).toEqual({ ok: false, status: 404, error: 'http_404' })
  })

  it('treats a redirect as a failure rather than following it with the key', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })) as unknown as typeof fetch
    expect(await fetchReceivedEmail(API_KEY, EMAIL_ID, f)).toEqual({ ok: false, status: 302, error: 'http_302' })
  })

  it('reports a network failure by the error’s name', async () => {
    const f = vi.fn(async () => { throw new TypeError(`fetch failed for Bearer ${API_KEY}`) }) as unknown as typeof fetch
    const r = await fetchReceivedEmail(API_KEY, EMAIL_ID, f)
    expect(r).toEqual({ ok: false, status: null, error: 'TypeError' })
    expect(JSON.stringify(r)).not.toContain(API_KEY)
  })

  it('reports a body that is not JSON', async () => {
    expect(await fetchReceivedEmail(API_KEY, EMAIL_ID, status(200, '<html>'))).toEqual({ ok: false, status: 200, error: 'SyntaxError' })
  })

  it.each(['../emails', 'a/b', 'id?x=1', '', 'x'.repeat(129)])('refuses the id %j without making a request', async (id) => {
    const f = ok(RECEIVED)
    expect(await fetchReceivedEmail(API_KEY, id, f)).toEqual({ ok: false, status: null, error: 'invalid_email_id' })
    expect(calls(f)).toHaveLength(0)
  })
})

describe('receiveResendWebhook — the route, with the network and the database injected', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)) })
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)) })
  })

  afterEach(() => {
    // Every case: neither secret, and no message text, in anything logged.
    const all = logged.join('\n')
    expect(all).not.toContain(API_KEY)
    expect(all).not.toContain(SECRET.slice('whsec_'.length))
    expect(all).not.toContain('555-0100')
    vi.restoreAllMocks()
  })

  const MATCHED: InboundOutcome = {
    matched: 'contact', contactId: 'c1', orgId: 'o1', touchId: 't1', paused: true, suppressed: false,
    replyKind: 'interested', duplicate: false, companyId: 'co1', companyDomain: 'acme.example',
  }

  function event(type = 'email.received', data: Record<string, unknown> = { email_id: EMAIL_ID }): string {
    return JSON.stringify({
      type,
      created_at: '2026-09-30T09:59:59.000Z',
      data: { from: 'Jane Doe <jane.doe@acme.example>', subject: 'Re: Your security.txt', message_id: '<m@x>', ...data },
    })
  }

  function signed(body: string, opts: { at?: Date; secret?: string; id?: string } = {}): Request {
    const id = opts.id ?? 'msg_2Lh9KRb0pSGUZfHf3m5rjdyKvab'
    const ts = String(Math.floor((opts.at ?? NOW).getTime() / 1000))
    const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ''), 'base64')
    const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
    return new Request('https://app.test/api/inbound/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
      body,
    })
  }

  function harness(opts: { fetchImpl?: typeof fetch; outcome?: InboundOutcome; throws?: Error; deps?: Partial<ResendWebhookDeps> } = {}) {
    const handed: InboundMail[] = []
    const fetchImpl = opts.fetchImpl ?? (vi.fn(async () => new Response(JSON.stringify(RECEIVED), { status: 200 })) as unknown as typeof fetch)
    const deps: ResendWebhookDeps = {
      secret: SECRET,
      apiKey: API_KEY,
      now: NOW,
      fetchImpl,
      handle: async (mail) => {
        handed.push(mail)
        if (opts.throws) throw opts.throws
        return opts.outcome ?? MATCHED
      },
      ...opts.deps,
    }
    const fetched = (): number => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    return { deps, handed, fetched }
  }

  it.each([
    ['the signing secret', { secret: undefined }],
    ['the API key', { apiKey: undefined }],
    ['both', { secret: null, apiKey: null }],
    ['an empty secret', { secret: '' }],
  ])('refuses everything with 503 when %s is unset — even a correctly signed delivery', async (_label, patch) => {
    const h = harness({ deps: patch })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r).toEqual({ status: 503, body: { error: 'inbound webhook is not configured' }, outcome: null })
    expect(h.fetched()).toBe(0)
    expect(h.handed).toHaveLength(0)
  })

  it('refuses a secret that is not a whsec_ secret with 503, and says so in the log', async () => {
    const h = harness({ deps: { secret: 'plain-text-secret-of-some-length' } })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r.status).toBe(503)
    expect(logged.join('\n')).toContain('not a whsec_ signing secret')
    expect(h.fetched()).toBe(0)
  })

  it('refuses a delivery signed with another secret: 401, nothing fetched, nothing filed', async () => {
    const h = harness()
    const other = 'whsec_' + Buffer.from('somebody else entirely').toString('base64')
    const r = await receiveResendWebhook(signed(event(), { secret: other }), h.deps)
    expect(r).toEqual({ status: 401, body: { error: 'unauthorized' }, outcome: null })
    expect(h.fetched()).toBe(0)
    expect(h.handed).toHaveLength(0)
  })

  it('refuses a body changed after signing', async () => {
    const h = harness()
    const req = signed(event())
    const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: event('email.received', { email_id: 'another-id' }) })
    expect((await receiveResendWebhook(tampered, h.deps)).status).toBe(401)
    expect(h.fetched()).toBe(0)
  })

  it('refuses a delivery replayed after the five-minute window', async () => {
    const h = harness()
    const r = await receiveResendWebhook(signed(event(), { at: new Date(NOW.getTime() - 6 * 60_000) }), h.deps)
    expect(r.status).toBe(401)
    expect(logged.join('\n')).toContain('"why":"stale"')
  })

  it('refuses an unsigned delivery', async () => {
    const h = harness()
    const r = await receiveResendWebhook(new Request('https://app.test/api/inbound/resend', { method: 'POST', body: event() }), h.deps)
    expect(r.status).toBe(401)
  })

  it('refuses a body over 64 KB before reading it as anything', async () => {
    const h = harness()
    const big = event('email.received', { email_id: EMAIL_ID, pad: 'x'.repeat(RESEND_MAX_BODY) })
    expect((await receiveResendWebhook(signed(big), h.deps)).status).toBe(413)
    expect(h.fetched()).toBe(0)
  })

  it('answers a signed body that is not JSON with 400', async () => {
    const h = harness()
    expect((await receiveResendWebhook(signed('not json'), h.deps)).body).toEqual({ error: 'invalid_json' })
  })

  it.each(['email.sent', 'email.delivered', 'email.bounced', 'contact.created'])(
    'ignores %s with a 200, fetching nothing',
    async (type) => {
      const h = harness()
      const r = await receiveResendWebhook(signed(event(type)), h.deps)
      expect(r).toEqual({ status: 200, body: { ignored: true }, outcome: null })
      expect(h.fetched()).toBe(0)
    },
  )

  it('answers 400 for an email.received that names no message', async () => {
    const h = harness()
    expect((await receiveResendWebhook(signed(event('email.received', { email_id: undefined })), h.deps)).status).toBe(400)
    expect((await receiveResendWebhook(signed(event('email.received', { email_id: '../domains' })), h.deps)).status).toBe(400)
    expect(h.fetched()).toBe(0)
  })

  it('fetches the message, maps it, and hands it to handleInboundEmail', async () => {
    const h = harness()
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r).toEqual({ status: 200, body: { matched: 'contact', paused: true, suppressed: false }, outcome: MATCHED })
    expect(h.handed).toEqual([mapReceivedEmail(RECEIVED)])
    expect(h.handed[0]?.from).toBe('Jane.Doe@Acme.example')
    expect(h.handed[0]?.references?.[0]).toBe('<out-2@agency.example>')
    const [url, init] = (h.deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain(EMAIL_ID)
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(logged.join('\n')).toContain('inbound reply recorded')
  })

  it('mirrors the generic route when nothing matches: 200 with the reason', async () => {
    const h = harness({ outcome: { matched: 'none', why: 'no contact has this address' } })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ matched: 'none', why: 'no contact has this address' })
  })

  it.each([
    ['Resend refusing', vi.fn(async () => new Response('{"name":"internal_server_error"}', { status: 500 }))],
    ['the message not being there yet', vi.fn(async () => new Response('{}', { status: 404 }))],
    ['the network failing', vi.fn(async () => { throw new TypeError('fetch failed') })],
    ['an answer that is not JSON', vi.fn(async () => new Response('<html>', { status: 200 }))],
  ])('answers 502 — never a 2xx — on %s, so Resend retries a message nobody read', async (_label, f) => {
    const h = harness({ fetchImpl: f as unknown as typeof fetch })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'the message could not be fetched', retry: true })
    expect(h.handed).toHaveLength(0)
    expect(logged.join('\n')).toContain('could not be fetched')
  })

  it('names a sending-only key as the likely cause when the receiving API refuses the key', async () => {
    const f = vi.fn(async () => new Response('{"name":"restricted_api_key"}', { status: 401 }))
    const h = harness({ fetchImpl: f as unknown as typeof fetch })
    expect((await receiveResendWebhook(signed(event()), h.deps)).status).toBe(502)
    expect(logged.join('\n')).toContain('reading received email needs a full-access one')
  })

  it('answers 200 for a message it read and could not place — a retry would read the same thing', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ...RECEIVED, from: null }), { status: 200 }))
    const h = harness({ fetchImpl: f as unknown as typeof fetch })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r).toEqual({ status: 200, body: { matched: 'none', why: 'the message had no readable sender' }, outcome: null })
    expect(h.handed).toHaveLength(0)
  })

  it('answers 500 when recording fails, logging the error’s name and not its message', async () => {
    const h = harness({ throws: Object.assign(new Error('connect ECONNREFUSED postgres://u:pw@db.internal/agency'), { name: 'DatabaseError' }) })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'the message could not be recorded', retry: true })
    const all = logged.join('\n')
    expect(all).toContain('DatabaseError')
    expect(all).not.toContain('ECONNREFUSED')
    expect(all).not.toContain('db.internal')
  })

  it('hands a redelivery through unchanged — handleInboundEmail is what recognises it', async () => {
    const duplicate: InboundOutcome = { ...MATCHED, duplicate: true, paused: false }
    const h = harness({ outcome: duplicate })
    const r = await receiveResendWebhook(signed(event()), h.deps)
    expect(r.outcome).toEqual(duplicate)
    expect(h.handed[0]?.messageId).toBe('<CAF=reply-1@mail.acme.example>')
  })

  it('files an HTML-only "stop" with the opt-out on the first line of its text', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      ...RECEIVED, text: null, html: '<div>Stop</div><blockquote>We looked at acme.example from the outside.</blockquote>',
    }), { status: 200 }))
    const h = harness({ fetchImpl: f as unknown as typeof fetch })
    await receiveResendWebhook(signed(event()), h.deps)
    expect(looksLikeOptOut(h.handed[0]?.text)).toBe(true)
  })
})

/**
 * The route cannot be imported (`server-only` through `@/lib/db`), so what
 * it adds around `receiveResendWebhook` is pinned from its source: the
 * segment exports, the secrets from `env()` and nowhere else, the generic
 * route's own notification builder, and `after()` only inside a try and only
 * once the delivery has been handled.
 */
describe('apps/web/src/app/api/inbound/resend/route.ts (read from the source)', () => {
  const source = readFileSync(new URL('../src/app/api/inbound/resend/route.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('is a dynamic Node route', () => {
    expect(code).toContain(`export const dynamic = 'force-dynamic'`)
    expect(code).toContain(`export const runtime = 'nodejs'`)
  })

  it('hands the whole delivery to receiveResendWebhook and reads nothing of the body itself', () => {
    expect(code).toContain('await receiveResendWebhook(request, {')
    expect(code).not.toMatch(/request\.(json|text|arrayBuffer|formData)\(/)
  })

  it('takes both secrets from env() and matches through handleInboundEmail — no second matcher', () => {
    expect(code).toContain('secret: e.RESEND_WEBHOOK_SECRET')
    expect(code).toContain('apiKey: e.RESEND_API_KEY')
    expect(code).toContain('handleInboundEmail(getDb()')
    expect(code).not.toContain('process.env')
  })

  it('announces with the generic route’s builder, after the delivery is handled, and only inside a try', () => {
    expect(code).toContain(`import { replyNotification } from '../email/notification'`)
    expect(code).toContain(`from '@/lib/slack'`)
    expect(code.indexOf('after(')).toBeGreaterThan(code.indexOf('await receiveResendWebhook('))
    const calls = code.match(/\bafter\(/g) ?? []
    const guarded = code.match(/try \{\s*after\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(guarded.length).toBe(1)
  })
})
