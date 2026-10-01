/**
 * A bounce arriving through Resend (RFC 3464, read the way the IMAP parser
 * reads one).
 *
 * The receiving API lists a message's attachments without their contents;
 * each part is `GET /emails/receiving/{email_id}/attachments/{id}`, which
 * answers a signed `download_url` on Resend's CDN (resend.com/docs,
 * "Retrieve Attachment"). Before, the route never asked, so `dsn` was null
 * and a bounce of our message reaching this route was read as a reply from
 * MAILER-DAEMON — matched to nobody, and the address never marked.
 *
 * Driven with the network faked by URL and, in the last block, the real
 * `handleInboundEmail` over a real migrated database: a Resend-delivered
 * DSN for one of our Message-IDs marks the bounce, and an ordinary reply
 * through the same route is exactly what it was.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { handleInboundEmail, schema, type AgencyDb, type InboundOutcome } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  deliveryReportParts,
  fetchDeliveryReport,
  receiveResendWebhook,
  returnedMessageIds,
  type InboundMail,
} from '../src/lib/resend-inbound'

const SECRET = 'whsec_' + Buffer.from('a fixed endpoint signing secret').toString('base64')
const API_KEY = 're_TESTKEY_do_not_log_me_4f1c2b'
const EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'
const STATUS_ID = '2a0c9ce0-3112-4728-976e-47ddcd16a318'
const COPY_ID = '3b1d0df1-4223-5839-087f-54eedd27b419'
/** The signature on a download link is a bearer credential of its own. */
const SIGNATURE = 'sig-THIS-IS-A-BEARER-LINK-123'
const NOW = new Date('2026-09-30T10:00:00.000Z')

const cdn = (id: string): string => `https://inbound-cdn.resend.com/${EMAIL_ID}/attachments/${id}?Expires=1&signature=${SIGNATURE}`

const STATUS_PART = [
  'Reporting-MTA: dns; mx.acme.example',
  '',
  'Final-Recipient: rfc822; jane.doe@acme.example',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
  '',
].join('\r\n')

const RETURNED_COPY = [
  'From: Agency <outreach@agency.example>',
  'To: jane.doe@acme.example',
  'Subject: A gap on your security page',
  'Message-ID: <out-1@agency.example>',
  'References: <their-0@acme.example>',
  '',
  'Hello. Message-ID: <not-a-header@body.example>',
].join('\r\n')

/** A bounce as the receiving API returns it: a multipart/report root and its parts listed as attachments. */
const RECEIVED_DSN = {
  object: 'email',
  id: EMAIL_ID,
  to: ['outreach@agency.example'],
  from: 'Mail Delivery System <MAILER-DAEMON@mx.acme.example>',
  created_at: '2026-09-30T09:59:58.000Z',
  subject: 'Undelivered Mail Returned to Sender',
  html: null,
  text: 'I am sorry to have to inform you that your message could not be delivered.',
  headers: {
    'auto-submitted': 'auto-replied',
    'content-type': 'multipart/report; report-type=delivery-status; boundary="B"',
    'mime-version': '1.0',
  },
  message_id: '<dsn-1@mx.acme.example>',
  attachments: [
    { id: STATUS_ID, filename: 'details.txt', content_type: 'message/delivery-status', content_disposition: null, content_id: null, size: 220 },
    { id: COPY_ID, filename: 'message.eml', content_type: 'message/rfc822', content_disposition: null, content_id: null, size: 300 },
  ],
}

/** An ordinary reply, for contrast: no report, no attachment requests. */
const RECEIVED_REPLY = {
  object: 'email',
  id: EMAIL_ID,
  to: ['outreach@agency.example'],
  from: 'Jane Doe <jane.doe@acme.example>',
  subject: 'Re: A gap on your security page',
  html: null,
  text: 'Thursday works.',
  headers: { 'in-reply-to': '<out-1@agency.example>', 'content-type': 'text/plain; charset=utf-8' },
  message_id: '<reply-1@mail.acme.example>',
  attachments: [],
}

type Route = (init: RequestInit) => Response | Promise<Response>

/** A fake network: each URL answers what its route says, and every request is kept. */
function network(email: unknown, override: Record<string, Route> = {}) {
  const requests: { url: string; init: RequestInit }[] = []
  const routes: Record<string, Route> = {
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}`]: () => Response.json(email),
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${STATUS_ID}`]: () =>
      Response.json({ object: 'attachment', id: STATUS_ID, content_type: 'message/delivery-status', download_url: cdn(STATUS_ID), expires_at: '2026-09-30T11:00:00.000Z' }),
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${COPY_ID}`]: () =>
      Response.json({ object: 'attachment', id: COPY_ID, content_type: 'message/rfc822', download_url: cdn(COPY_ID), expires_at: '2026-09-30T11:00:00.000Z' }),
    [cdn(STATUS_ID)]: () => new Response(STATUS_PART),
    [cdn(COPY_ID)]: () => new Response(RETURNED_COPY),
    ...override,
  }
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    requests.push({ url: u, init: init ?? {} })
    const route = routes[u]
    if (!route) return new Response('{"name":"not_found"}', { status: 404 })
    return route(init ?? {})
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

const auth = (init: RequestInit): string | undefined => (init.headers as Record<string, string> | undefined)?.['authorization']

describe('deliveryReportParts — which attachments make a report', () => {
  it('finds the delivery-status part and the returned copy of a multipart/report', () => {
    expect(deliveryReportParts(RECEIVED_DSN)).toEqual({ status: STATUS_ID, returned: [COPY_ID] })
  })

  it.each([
    ['message/global-delivery-status', 'text/rfc822-headers'],
    ['Message/Delivery-Status; charset=us-ascii', 'message/global-headers'],
  ])('reads %s with %s', (statusType, copyType) => {
    const json = {
      ...RECEIVED_DSN,
      attachments: [
        { id: STATUS_ID, content_type: statusType },
        { id: COPY_ID, content_type: copyType },
      ],
    }
    expect(deliveryReportParts(json)).toEqual({ status: STATUS_ID, returned: [COPY_ID] })
  })

  /** The IMAP rule: only a report whose ROOT is one. A prospect forwarding a bounce is writing to us. */
  it('reads nothing when the root is not a multipart/report — a forwarded bounce is a reply', () => {
    expect(deliveryReportParts({ ...RECEIVED_DSN, headers: { 'content-type': 'multipart/mixed; boundary="M"' } })).toBeNull()
    expect(deliveryReportParts({ ...RECEIVED_DSN, headers: {} })).toBeNull()
    expect(deliveryReportParts({ ...RECEIVED_DSN, headers: undefined })).toBeNull()
  })

  it('reads nothing from a report with no delivery-status part (a read receipt)', () => {
    expect(
      deliveryReportParts({
        ...RECEIVED_DSN,
        headers: { 'content-type': 'multipart/report; report-type=disposition-notification' },
        attachments: [{ id: STATUS_ID, content_type: 'message/disposition-notification' }],
      }),
    ).toBeNull()
  })

  it('skips an attachment whose id could not go in a URL, and reads at most two returned copies', () => {
    const json = {
      ...RECEIVED_DSN,
      attachments: [
        { id: '../../domains', content_type: 'message/delivery-status' },
        { id: STATUS_ID, content_type: 'message/delivery-status' },
        { id: 'c1', content_type: 'message/rfc822' },
        { id: 'c2', content_type: 'message/rfc822' },
        { id: 'c3', content_type: 'message/rfc822' },
      ],
    }
    expect(deliveryReportParts(json)).toEqual({ status: STATUS_ID, returned: ['c1', 'c2'] })
  })

  it('answers null for anything that is not a received message', () => {
    for (const v of [null, undefined, 'x', 42, [RECEIVED_DSN]]) expect(deliveryReportParts(v)).toBeNull()
    expect(deliveryReportParts(RECEIVED_REPLY)).toBeNull()
  })
})

describe('returnedMessageIds', () => {
  it('reads the Message-ID, then References, from the header section only', () => {
    expect(returnedMessageIds(RETURNED_COPY)).toEqual(['<out-1@agency.example>', '<their-0@acme.example>'])
  })

  it('unfolds a folded References and keeps the first of a repeated header', () => {
    const copy = 'Message-ID: <a@x>\nMessage-ID: <b@x>\nReferences: <r1@x>\n\t<r2@x>\n  <r3@x>\n\nbody'
    expect(returnedMessageIds(copy)).toEqual(['<a@x>', '<r1@x>', '<r2@x>', '<r3@x>'])
  })

  it('names nothing for a copy with no ids', () => {
    expect(returnedMessageIds('Subject: hi\r\n\r\nMessage-ID: <in-the-body@x>')).toEqual([])
    expect(returnedMessageIds('')).toEqual([])
  })
})

describe('fetchDeliveryReport', () => {
  it('asks the receiving API for each part with the key, and the CDN for its bytes without it', async () => {
    const net = network(RECEIVED_DSN)
    const r = await fetchDeliveryReport(API_KEY, EMAIL_ID, { status: STATUS_ID, returned: [COPY_ID] }, net.fetchImpl)
    expect(r).toEqual({ ok: true, dsn: STATUS_PART, originalMessageIds: ['<out-1@agency.example>', '<their-0@acme.example>'] })
    expect(net.requests.map((q) => q.url)).toEqual([
      `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${STATUS_ID}`,
      cdn(STATUS_ID),
      `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${COPY_ID}`,
      cdn(COPY_ID),
    ])
    for (const q of net.requests) {
      expect(q.init.redirect).toBe('manual')
      expect(q.init.signal).toBeInstanceOf(AbortSignal)
      expect(q.url).not.toContain(API_KEY)
      if (q.url.startsWith('https://api.resend.com/')) expect(auth(q.init)).toBe(`Bearer ${API_KEY}`)
      else expect(auth(q.init)).toBeUndefined()
    }
  })

  it('reads a bounded prefix of a huge part, and cuts the DSN to the readers’ bound', async () => {
    const huge = `${STATUS_PART}${'x'.repeat(1_000_000)}`
    const net = network(RECEIVED_DSN, { [cdn(STATUS_ID)]: () => new Response(huge) })
    const r = await fetchDeliveryReport(API_KEY, EMAIL_ID, { status: STATUS_ID, returned: [] }, net.fetchImpl)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dsn.startsWith(STATUS_PART)).toBe(true)
    expect(r.dsn.length).toBe(20_000)
  })

  it.each([
    ['the metadata endpoint', 'https://169.254.169.254/latest/meta-data/'],
    ['plain http', `http://inbound-cdn.resend.com/x?signature=${SIGNATURE}`],
    ['a loopback name', 'https://localhost/x'],
    ['credentials in the link', 'https://user:pw@inbound-cdn.resend.com/x'],
    ['an explicit port', 'https://inbound-cdn.resend.com:8443/x'],
    ['not a URL', 'nope'],
  ])('refuses a download_url to %s without requesting it', async (_label, url) => {
    const net = network(RECEIVED_DSN, {
      [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${STATUS_ID}`]: () => Response.json({ download_url: url }),
    })
    const r = await fetchDeliveryReport(API_KEY, EMAIL_ID, { status: STATUS_ID, returned: [] }, net.fetchImpl)
    expect(r).toEqual({ ok: false, part: 'delivery-status', status: 200, error: 'download_url_refused' })
    expect(net.requests).toHaveLength(1)
  })

  it.each([
    ['the attachment API refusing', { [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${COPY_ID}`]: () => new Response('{}', { status: 500 }) }, { status: 500, error: 'http_500' }],
    ['no download_url', { [`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments/${COPY_ID}`]: () => Response.json({ id: COPY_ID }) }, { status: 200, error: 'no_download_url' }],
    ['an expired link', { [cdn(COPY_ID)]: () => new Response('<Error>AccessDenied</Error>', { status: 403 }) }, { status: 403, error: 'download_http_403' }],
    ['the CDN redirecting', { [cdn(COPY_ID)]: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }) }, { status: 302, error: 'download_http_302' }],
    ['the network failing', { [cdn(COPY_ID)]: () => { throw new TypeError(`fetch failed ${cdn(COPY_ID)}`) } }, { status: null, error: 'TypeError' }],
  ] as const)('says which part failed on %s, by status and name only', async (_label, override, failure) => {
    const net = network(RECEIVED_DSN, override as Record<string, Route>)
    const r = await fetchDeliveryReport(API_KEY, EMAIL_ID, { status: STATUS_ID, returned: [COPY_ID] }, net.fetchImpl)
    expect(r).toEqual({ ok: false, part: 'returned-copy', ...failure })
    expect(JSON.stringify(r)).not.toContain(SIGNATURE)
  })
})

describe('receiveResendWebhook — a report', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)) })
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)) })
  })

  afterEach(() => {
    // Neither the key nor a signed download link, in anything logged.
    const all = logged.join('\n')
    expect(all).not.toContain(API_KEY)
    expect(all).not.toContain(SIGNATURE)
    vi.restoreAllMocks()
  })

  function signed(): Request {
    const body = JSON.stringify({ type: 'email.received', created_at: '2026-09-30T09:59:59.000Z', data: { email_id: EMAIL_ID } })
    const id = 'msg_2Lh9KRb0pSGUZfHf3m5rjdyKvab'
    const ts = String(Math.floor(NOW.getTime() / 1000))
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64')
    const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
    return new Request('https://app.test/api/inbound/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
      body,
    })
  }

  function harness(fetchImpl: typeof fetch, outcome: InboundOutcome = { matched: 'none', why: 'stub' }) {
    const handed: InboundMail[] = []
    const deps = {
      secret: SECRET, apiKey: API_KEY, now: NOW, fetchImpl,
      handle: async (mail: InboundMail) => { handed.push(mail); return outcome },
    }
    return { deps, handed }
  }

  it('hands handleInboundEmail the DSN and the returned copy’s ids', async () => {
    const net = network(RECEIVED_DSN)
    const h = harness(net.fetchImpl)
    const r = await receiveResendWebhook(signed(), h.deps)
    expect(r.status).toBe(200)
    expect(h.handed).toHaveLength(1)
    expect(h.handed[0]?.dsn).toBe(STATUS_PART)
    expect(h.handed[0]?.originalMessageIds).toEqual(['<out-1@agency.example>', '<their-0@acme.example>'])
    expect(h.handed[0]?.headers?.['content-type']).toMatch(/^multipart\/report/)
  })

  it('answers 502 — never a 2xx — when a report part cannot be fetched, and files nothing', async () => {
    const net = network(RECEIVED_DSN, { [cdn(STATUS_ID)]: () => new Response('', { status: 503 }) })
    const h = harness(net.fetchImpl)
    const r = await receiveResendWebhook(signed(), h.deps)
    expect(r).toEqual({ status: 502, body: { error: 'the message could not be fetched', retry: true }, outcome: null })
    expect(h.handed).toHaveLength(0)
    expect(logged.join('\n')).toContain('"part":"delivery-status"')
  })

  it('asks for no attachment of an ordinary reply', async () => {
    const net = network(RECEIVED_REPLY)
    const h = harness(net.fetchImpl)
    await receiveResendWebhook(signed(), h.deps)
    expect(net.requests).toHaveLength(1)
    expect(h.handed[0]?.dsn).toBeNull()
    expect(h.handed[0]?.originalMessageIds).toBeUndefined()
  })

  /** End to end, below: the real matcher over a real database. */
  describe('through handleInboundEmail', () => {
    let test: TestDb
    let db: AgencyDb
    let contactId: string

    beforeEach(async () => {
      test = await migratedDb()
      db = drizzle(test.pg, { schema }) as unknown as AgencyDb
      const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
      const orgId = org!.id
      const [company] = await db
        .insert(schema.companies)
        .values({ orgId, domain: 'acme.example', timeZone: 'Europe/London' })
        .returning({ id: schema.companies.id })
      const [contact] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId: company!.id, email: 'jane.doe@acme.example', timeZone: 'Europe/London' })
        .returning({ id: schema.contacts.id })
      contactId = contact!.id
      await db.insert(schema.touches).values({
        orgId, contactId, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
        recipient: 'jane.doe@acme.example', sentAt: new Date('2026-09-29T09:00:00.000Z'), providerId: '<out-1@agency.example>',
        subject: 'A gap on your security page', body: 'Hello.',
      })
    }, 30_000)

    afterEach(async () => {
      await test?.close()
    })

    const real = (fetchImpl: typeof fetch) => ({
      secret: SECRET, apiKey: API_KEY, now: NOW, fetchImpl,
      handle: (mail: InboundMail) => handleInboundEmail(db, { ...mail, now: NOW }),
    })

    it('marks the bounce on the address our message went to — and records no reply', async () => {
      const r = await receiveResendWebhook(signed(), real(network(RECEIVED_DSN).fetchImpl))
      expect(r.status).toBe(200)
      expect(r.outcome).toMatchObject({ matched: 'none', bounce: { contactId, permanent: true, code: '5.1.1', marked: true } })
      const [person] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(person!.emailBouncedAt).not.toBeNull()
      expect(person!.emailBounceCode).toBe('5.1.1')
      // A bounce is not a reply and not an opt-out: nobody paused, nothing suppressed, no inbound row.
      expect(person!.pausedAt).toBeNull()
      expect(await db.select().from(schema.suppressions)).toEqual([])
      expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
      expect(logged.join('\n')).toContain('delivery report recorded')
      expect(logged.join('\n')).not.toContain('jane.doe@')
    })

    it('leaves an ordinary reply exactly what it was: a reply, the contact paused, no bounce', async () => {
      const r = await receiveResendWebhook(signed(), real(network(RECEIVED_REPLY).fetchImpl))
      expect(r.status).toBe(200)
      expect(r.outcome).toMatchObject({ matched: 'message', contactId, paused: true, suppressed: false })
      const [person] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
      expect(person!.emailBouncedAt).toBeNull()
      expect(person!.pausedAt).not.toBeNull()
    })
  })
})
