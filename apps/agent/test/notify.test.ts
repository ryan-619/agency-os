/**
 * The worker's opt-out alarm (§2.1's Phase 4 obligation, in real time).
 *
 * A reply read over IMAP that says stop and whose suppression row cannot be
 * written is already audited and logged by `handleInboundEmail`. The web
 * routes then post the `opt_out_not_recorded` Slack message, AWAITED; the
 * worker had no Slack path at all, so over IMAP the alarm was simply never
 * raised. These tests drive the whole path — a raw message through
 * `handleInboundMessage`, a real migrated database whose suppression insert
 * fails, the real alarm against a fake `fetch` — and pin the four promises:
 * it posts on `optOutNotRecorded`, it does not post otherwise, it writes the
 * `notification.*` audit row, and the webhook URL (the credential) reaches
 * no log line and no audit row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { slackOptOutNotRecordedPayload } from '@agency/core'
import { schema, type AgencyDb, type InboundOutcome } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { throughTransactions } from '../../../packages/db/test/fault-db.js'
import { handleInboundMessage } from '../src/outreach/inbox.js'
import {
  optOutAlarmFrom,
  optOutAlarmFromEnvironment,
  optOutNotRecordedEvent,
  postToSlack,
  raiseOptOutNotRecorded,
} from '../src/notify.js'
import type { Logger } from '../src/logger.js'

/** The credential. Its secret part must appear in nothing anybody can read. */
const SECRET_PART = 'XyZsecretWebhookToken1234567890'
const WEBHOOK = `https://hooks.slack.com/services/T0000/B0000/${SECRET_PART}`
const ORIGIN = 'https://agency.example.com'
const NOON = new Date('2026-09-15T12:00:00.000Z')

/** A Logger that keeps every line it is handed, as the JSON the real one would print. */
function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ level, msg, ...fields }))
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

type FetchMock = ReturnType<typeof vi.fn> & typeof fetch
const answering = (res: () => Response | Promise<Response>): FetchMock =>
  vi.fn(async () => res()) as unknown as FetchMock
const calls = (f: FetchMock): [string, RequestInit][] => f.mock.calls as [string, RequestInit][]

const EVENT = {
  kind: 'opt_out_not_recorded',
  orgId: '00000000-0000-4000-8000-00000000000a',
  touchId: '00000000-0000-4000-8000-000000000007',
  contactId: '00000000-0000-4000-8000-000000000001',
  path: 'reply',
} as const

describe('postToSlack', () => {
  it('posts the payload as JSON, refusing redirects, with a timeout', async () => {
    const f = answering(() => new Response('ok', { status: 200 }))
    expect(await postToSlack(WEBHOOK, { text: 'hi' }, f)).toEqual({ ok: true, status: 200 })
    const [url, init] = calls(f)[0]!
    expect(url).toBe(WEBHOOK)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }))
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps Slack’s short refusal token and nothing else of the body', async () => {
    expect(await postToSlack(WEBHOOK, { text: 'hi' }, answering(() => new Response('no_service', { status: 404 }))))
      .toEqual({ ok: false, status: 404, error: 'no_service' })
    expect(await postToSlack(WEBHOOK, { text: 'hi' }, answering(() => new Response(`<html>${WEBHOOK}</html>`, { status: 500 }))))
      .toEqual({ ok: false, status: 500, error: 'http_500' })
  })

  it('reports a network failure by the error’s name, never its message', async () => {
    const f = vi.fn(async () => { throw new TypeError(`fetch failed for ${WEBHOOK}`) }) as unknown as typeof fetch
    const r = await postToSlack(WEBHOOK, { text: 'hi' }, f)
    expect(r).toEqual({ ok: false, status: null, error: 'TypeError' })
  })

  it('makes one attempt — no retry', async () => {
    const f = answering(() => new Response('', { status: 503 }))
    await postToSlack(WEBHOOK, { text: 'hi' }, f)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('optOutNotRecordedEvent — the web route’s rule', () => {
  const MATCHED: InboundOutcome = {
    matched: 'message', contactId: EVENT.contactId, orgId: EVENT.orgId, touchId: EVENT.touchId, paused: true,
    suppressed: false, replyKind: 'opted_out', duplicate: false, companyId: null, companyDomain: 'priya-rentman.io.inbound',
    optOutNotRecorded: true,
  }

  it('names the ids and the reply path, and nothing from the outcome beyond them', () => {
    expect(optOutNotRecordedEvent(MATCHED)).toEqual(EVENT)
  })

  /**
   * Review round 7: a colleague's stop filed under the contact our mail went
   * to. The opt-out is the sender's; the alarm names their reply and never
   * the contact — the web route's rule, byte for byte.
   */
  it('names the reply and not the contact for a stop sent by somebody else', () => {
    expect(optOutNotRecordedEvent({ ...MATCHED, fromIsContact: false })).toEqual({
      ...EVENT, contactId: null, fromIsContact: false,
    })
    expect(optOutNotRecordedEvent({ ...MATCHED, fromIsContact: true })).toEqual(EVENT)
    expect(optOutNotRecordedEvent({ ...MATCHED, fromIsContact: null })).toEqual(EVENT)
  })

  it.each([
    ['an ordinary reply', { ...MATCHED, optOutNotRecorded: false, replyKind: 'interested' as const }],
    ['a recorded opt-out', { ...MATCHED, optOutNotRecorded: false, suppressed: true }],
    ['a redelivery', { ...MATCHED, duplicate: true }],
    ['no match', { matched: 'none' as const, why: 'no contact has this address' }],
  ])('raises nothing for %s', (_label, outcome) => {
    expect(optOutNotRecordedEvent(outcome as InboundOutcome)).toBeNull()
  })
})

describe('raiseOptOutNotRecorded', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('posts the core builder’s message on WEB_PUBLIC_URL and records notification.sent', async () => {
    const { log, lines } = captureLog()
    const f = answering(() => new Response('ok', { status: 200 }))
    const event = { ...EVENT, orgId }
    await raiseOptOutNotRecorded(event, { webhookUrl: WEBHOOK, origin: ORIGIN, db, log, fetchImpl: f })
    expect(JSON.parse(String(calls(f)[0]![1].body))).toEqual(slackOptOutNotRecordedPayload(event, ORIGIN))
    expect(String(calls(f)[0]![1].body)).toContain(`${ORIGIN}/suppressions`)
    const audit = await db.select().from(schema.auditLog)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      orgId, actor: 'system', action: 'notification.sent', subjectType: 'touch', subjectId: EVENT.touchId,
      detail: { channel: 'slack', event: 'opt_out_not_recorded', ids: { touchId: EVENT.touchId, contactId: EVENT.contactId }, status: 200 },
    })
    expect(lines.join('\n')).toContain('slack notification sent')
    expect(JSON.stringify([audit, lines])).not.toContain(SECRET_PART)
  })

  it('posts without a link when the worker has no WEB_PUBLIC_URL', async () => {
    const { log } = captureLog()
    const f = answering(() => new Response('ok', { status: 200 }))
    await raiseOptOutNotRecorded({ ...EVENT, orgId }, { webhookUrl: WEBHOOK, origin: null, db, log, fetchImpl: f })
    const text = (JSON.parse(String(calls(f)[0]![1].body)) as { text: string }).text
    expect(text).not.toMatch(/https?:/)
    expect(text).toMatch(/^OPT-OUT NOT RECORDED\./)
  })

  it('records notification.failed with the error’s name when Slack cannot be reached, and does not throw', async () => {
    const { log, lines } = captureLog()
    const f = vi.fn(async () => { throw new TypeError(`getaddrinfo ENOTFOUND ${WEBHOOK}`) }) as unknown as typeof fetch
    await expect(raiseOptOutNotRecorded({ ...EVENT, orgId }, { webhookUrl: WEBHOOK, origin: ORIGIN, db, log, fetchImpl: f }))
      .resolves.toBeUndefined()
    const [row] = await db.select().from(schema.auditLog)
    expect(row).toMatchObject({ action: 'notification.failed', detail: { status: null, error: 'TypeError' } })
    expect(lines.join('\n')).toContain('"error":"TypeError"')
    expect(JSON.stringify([row, lines])).not.toContain(SECRET_PART)
    expect(JSON.stringify([row, lines])).not.toContain('ENOTFOUND')
  })

  it('still does not throw when the audit row cannot be written', async () => {
    const { log, lines } = captureLog()
    const broken = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === 'insert') return () => { throw new Error(`relation "audit_log" … ${WEBHOOK}`) }
        return Reflect.get(target, prop, receiver)
      },
    }) as AgencyDb
    const f = answering(() => new Response('ok', { status: 200 }))
    await expect(raiseOptOutNotRecorded({ ...EVENT, orgId }, { webhookUrl: WEBHOOK, origin: ORIGIN, db: broken, log, fetchImpl: f }))
      .resolves.toBeUndefined()
    expect(lines.join('\n')).toContain('slack notification audit row not written')
    expect(lines.join('\n')).not.toContain(SECRET_PART)
  })
})

describe('optOutAlarmFrom — the environment', () => {
  it('is off, and says so by name, without SLACK_WEBHOOK_URL', () => {
    const { log, lines } = captureLog()
    expect(optOutAlarmFrom({ WEB_PUBLIC_URL: ORIGIN }, { db: {} as AgencyDb, log })).toBeNull()
    expect(lines.join('\n')).toContain('"missing":["SLACK_WEBHOOK_URL"]')
  })

  it('is on, naming a missing WEB_PUBLIC_URL and never the webhook', () => {
    const { log, lines } = captureLog()
    expect(optOutAlarmFrom({ SLACK_WEBHOOK_URL: WEBHOOK }, { db: {} as AgencyDb, log })).toBeTypeOf('function')
    expect(lines.join('\n')).toContain('"missing":["WEB_PUBLIC_URL"]')
    expect(lines.join('\n')).not.toContain(SECRET_PART)
  })

  it('reads the worker’s own validated environment when the caller hands none in', () => {
    const { log, lines } = captureLog()
    const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db', AGENT_INTERNAL_TOKEN: 't'.repeat(32) }
    expect(optOutAlarmFromEnvironment({ db: {} as AgencyDb, log }, { ...base, SLACK_WEBHOOK_URL: WEBHOOK, WEB_PUBLIC_URL: ORIGIN }))
      .toBeTypeOf('function')
    expect(optOutAlarmFromEnvironment({ db: {} as AgencyDb, log }, { ...base, SLACK_WEBHOOK_URL: '' })).toBeNull()
    // A host Slack does not own is refused at the boundary, so no alarm is built for it.
    expect(optOutAlarmFromEnvironment({ db: {} as AgencyDb, log }, { ...base, SLACK_WEBHOOK_URL: `https://169.254.169.254/${SECRET_PART}` }))
      .toBeNull()
    expect(lines.join('\n')).not.toContain(SECRET_PART)
  })
})

/**
 * The whole IMAP path, minus the mailbox: a raw message through
 * `handleInboundMessage`, a real database, and the real alarm.
 */
describe('the IMAP path raises the alarm', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let contactId: string
  let stderr: string[]

  const raw = (headers: string, body: string): string => `${headers.trim()}\r\n\r\n${body}`
  const reply = (body: string, id = '<their-9@rentman.io>'): string =>
    raw(
      `From: Priya <priya@rentman.io>
To: outreach@agency.test
Subject: Re: A gap on your security page
Message-ID: ${id}
In-Reply-To: <sent-1@agency.test>`,
      body,
    )

  /**
   * The database, except that writing a suppression row fails — the fault
   * §2.1's obligation is about. Through every transaction: the reply's
   * writes are one, with the suppression in a savepoint inside it.
   */
  const failingSuppression = (): AgencyDb =>
    throughTransactions(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.suppressions) throw new Error('Connection terminated unexpectedly')
            return (target as AgencyDb).insert(table as typeof schema.touches)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    await db.insert(schema.touches).values({
      orgId, contactId, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
      recipient: 'priya@rentman.io', sentAt: NOON, providerId: '<sent-1@agency.test>',
      subject: 'A gap on your security page', body: 'Hello.',
    })
    // `recordInboundReply` shouts OPT-OUT NOT RECORDED on stderr; kept, and checked for the URL too.
    stderr = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { stderr.push(String(line)) })
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { stderr.push(String(line)) })
  }, 30_000)

  afterEach(async () => {
    vi.restoreAllMocks()
    await test?.close()
  })

  function worker(target: AgencyDb, f: FetchMock) {
    const { log, lines } = captureLog()
    const optOutAlarm = optOutAlarmFrom({ SLACK_WEBHOOK_URL: WEBHOOK, WEB_PUBLIC_URL: ORIGIN }, { db: target, log, fetchImpl: f })
    return { deps: { db: target, log, optOutAlarm, now: () => NOON }, lines }
  }

  it('posts the opt_out_not_recorded message when the suppression could not be written, and audits it', async () => {
    const f = answering(() => new Response('ok', { status: 200 }))
    const { deps, lines } = worker(failingSuppression(), f)
    const outcome = await handleInboundMessage(reply('Please unsubscribe me.'), 41, deps)
    expect(outcome?.matched).toBe('message')
    if (!outcome || outcome.matched === 'none') return
    expect(outcome.optOutNotRecorded).toBe(true)

    expect(f).toHaveBeenCalledTimes(1)
    expect(calls(f)[0]![0]).toBe(WEBHOOK)
    const posted = JSON.parse(String(calls(f)[0]![1].body)) as { text: string }
    expect(posted).toEqual(
      slackOptOutNotRecordedPayload({ kind: 'opt_out_not_recorded', orgId, touchId: outcome.touchId, contactId, path: 'reply' }, ORIGIN),
    )
    // Ids and a link — never the address or the words.
    expect(posted.text).not.toContain('priya@')
    expect(posted.text).not.toContain('unsubscribe me')

    const audit = await db.select().from(schema.auditLog)
    // Beside the reply's own rows (contact.replied, deal.created): the failure, and the alarm about it.
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['contact.opt_out_not_recorded', 'notification.sent']))
    expect(audit.filter((a) => a.action.startsWith('notification.'))).toHaveLength(1)
    expect(audit.find((a) => a.action === 'notification.sent')).toMatchObject({
      actor: 'system', subjectType: 'touch', subjectId: outcome.touchId,
      detail: { event: 'opt_out_not_recorded', ids: { touchId: outcome.touchId, contactId } },
    })
    expect(lines.join('\n')).toContain('"optOutNotRecorded":true')
    expect(stderr.join('\n')).toContain('OPT-OUT NOT RECORDED')
    expect(JSON.stringify([audit, lines, stderr])).not.toContain(SECRET_PART)
  })

  it('posts nothing for an opt-out that WAS recorded', async () => {
    const f = answering(() => new Response('ok', { status: 200 }))
    const { deps } = worker(db, f)
    const outcome = await handleInboundMessage(reply('Please unsubscribe me.'), 42, deps)
    expect(outcome?.matched === 'message' && outcome.suppressed).toBe(true)
    expect(f).not.toHaveBeenCalled()
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).not.toContain('notification.sent')
  })

  it('posts nothing for an ordinary reply', async () => {
    const f = answering(() => new Response('ok', { status: 200 }))
    const { deps } = worker(failingSuppression(), f)
    const outcome = await handleInboundMessage(reply('Thursday works — send an invite.'), 43, deps)
    expect(outcome?.matched).toBe('message')
    expect(f).not.toHaveBeenCalled()
  })

  it('posts nothing for a redelivery of the same message — the first delivery raised it', async () => {
    const f = answering(() => new Response('ok', { status: 200 }))
    const { deps } = worker(failingSuppression(), f)
    await handleInboundMessage(reply('Please unsubscribe me.'), 44, deps)
    await handleInboundMessage(reply('Please unsubscribe me.'), 45, deps)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('records notification.failed, and still finishes the message, when Slack refuses', async () => {
    const f = answering(() => new Response('no_service', { status: 404 }))
    const { deps, lines } = worker(failingSuppression(), f)
    const outcome = await handleInboundMessage(reply('Please unsubscribe me.'), 46, deps)
    expect(outcome?.matched).toBe('message')
    const failed = (await db.select().from(schema.auditLog)).find((a) => a.action === 'notification.failed')
    expect(failed?.detail).toMatchObject({ status: 404, error: 'no_service' })
    expect(lines.join('\n')).not.toContain(SECRET_PART)
  })

  it('raises nothing with no alarm configured, and the reply is still recorded', async () => {
    const { log } = captureLog()
    const outcome = await handleInboundMessage(reply('Please unsubscribe me.'), 47, { db: failingSuppression(), log, optOutAlarm: null, now: () => NOON })
    expect(outcome?.matched === 'message' && outcome.optOutNotRecorded).toBe(true)
    const actions = (await db.select().from(schema.auditLog)).map((a) => a.action)
    expect(actions).toContain('contact.opt_out_not_recorded')
    expect(actions.filter((a) => a.startsWith('notification.'))).toEqual([])
  })
})
