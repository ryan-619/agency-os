/**
 * `POST /api/inbound/email` when recording the mail throws (review round 5).
 *
 * The route called `handleInboundEmail` with no try/catch, so a fault
 * escaped to Next as drizzle's error — whose message quotes every bound
 * parameter, the From address, the subject and the reply — and Next logged
 * it whole on every provider retry. It is caught now, logged by the
 * fault's class, answered 500 so the provider retries, and a reply that
 * asked to stop takes the loud path: an audit row and the awaited alarm,
 * under the contact the recorder itself was filing it under.
 *
 * `./fault.ts` is driven here against the real recorder and a fault the
 * engine raises; the route file reaches `server-only` and is pinned by
 * reading its source.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleInboundEmail, schema, type AgencyDb } from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { failOnce } from '../../../packages/db/test/fault-db.js'
import {
  inboundEmailNotRecorded, keepingRolledBackOptOut, type InboundEmailFaultDeps,
} from '../src/app/api/inbound/email/fault'
import { slackMessage, type NotificationEvent } from '../src/lib/slack-message'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const OUR_ID = '<sent-1@agency.test>'
const ADDRESS = 'priya@rentman.io'
const WORDS = 'Stop\n\nMy mobile is 07700 900123 — DECOY-WORDS'

describe('POST /api/inbound/email — a fault while recording', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let contactId: string
  let sentId: string
  let lines: { message: string; fields: Record<string, unknown> }[]
  let audits: Parameters<InboundEmailFaultDeps['audit']>[0][]
  let alarms: NotificationEvent[]
  const deps = (): InboundEmailFaultDeps => ({
    audit: async (entry) => {
      audits.push(entry)
    },
    alarm: async (event) => {
      alarms.push(event)
    },
    log: { error: (message, fields = {}) => lines.push({ message, fields }) },
  })
  /** The route's own wiring: the recorder's lines forwarded, a rolled-back stop kept. */
  const recorderFor = () => keepingRolledBackOptOut({ error: (message, fields = {}) => lines.push({ message, fields: { ...fields } }) })

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    audits = []
    alarms = []
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, email: ADDRESS, timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [sent] = await db
      .insert(schema.touches)
      .values({
        orgId, contactId, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
        subject: 'A gap on your security page', body: 'Hello.', recipient: ADDRESS,
        sentAt: new Date(NOON.getTime() - 86_400_000), providerId: OUR_ID,
      })
      .returning({ id: schema.touches.id })
    sentId = sent!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** The route's call, with its log, and the answer it gives when the call throws. */
  const deliver = async (text: string, references: readonly string[] = [OUR_ID]) => {
    const recorder = recorderFor()
    try {
      await handleInboundEmail(db, {
        from: ADDRESS, subject: 'Re: A gap on your security page', text, messageId: '<reply-1@rentman.io>',
        references, now: NOON, log: recorder,
      })
    } catch (err) {
      return { thrown: err, answer: await inboundEmailNotRecorded(err, { text, rolledBack: recorder.rolledBack() }, deps()) }
    }
    throw new Error('the fault did not fire')
  }

  it('answers a stop it could not record 500, audits it and awaits the alarm — and logs no address or words', async () => {
    // The reply's own INSERT refused: the statement whose parameters are the
    // address and the words.
    await failOnce(test.pg, { table: 'touches', event: 'INSERT' })
    const { thrown, answer } = await deliver(WORDS)
    // What used to reach the platform log whole: drizzle's message quotes them.
    expect((thrown as Error).message).toContain(ADDRESS)
    expect((thrown as Error).message).toContain('DECOY-WORDS')

    expect(answer).toEqual({ status: 500, body: { error: 'opt-out not recorded', retry: true } })
    expect(audits).toEqual([
      {
        orgId, actor: 'system', action: 'contact.opt_out_not_recorded', subjectType: 'contact', subjectId: contactId,
        detail: { channel: 'email', why: 'record_failed' },
      },
    ])
    // The touch it names is the message the reply answered.
    expect(alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId, touchId: sentId, contactId, path: 'reply' }])
    expect(lines.at(-1)).toEqual({
      message: expect.stringContaining('OPT-OUT NOT RECORDED — an email that asked to stop could not be recorded'),
      fields: { error: 'Error', orgId, contactId, audited: true, alarm: 'raised' },
    })
    for (const said of [JSON.stringify(lines), JSON.stringify(audits), JSON.stringify(slackMessage(alarms[0]!, 'https://x.test'))]) {
      expect(said).not.toContain(ADDRESS)
      expect(said).not.toContain('DECOY-WORDS')
      expect(said).not.toContain('07700')
    }
    // Nothing was stored: the retry records it all.
    expect((await db.select().from(schema.touches)).filter((t) => t.direction === 'in')).toEqual([])
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
    expect(c!.pausedAt).toBeNull()
  })

  it('names no touch for a stop matched by its address alone', async () => {
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    await deliver('Stop', [])
    expect(alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId, touchId: null, contactId, path: 'reply' }])
  })

  it('answers an ordinary reply it could not record 500, with the fault’s class and no alarm', async () => {
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    const { answer } = await deliver('Yes, send pricing — DECOY-WORDS')
    expect(answer).toEqual({ status: 500, body: { error: 'the message could not be recorded', retry: true } })
    expect(audits).toEqual([])
    expect(alarms).toEqual([])
    expect(lines).toEqual([{ message: 'inbound email could not be recorded; answering 500 so it is retried', fields: { error: 'Error' } }])
  })

  it('says a stop is unplaced, at error, when the fault came before the recorder could say whose it was', async () => {
    const answer = await inboundEmailNotRecorded(new TypeError('Failed query: … params: priya@rentman.io,Stop'), { text: 'Stop', rolledBack: null }, deps())
    expect(answer.status).toBe(500)
    expect(audits).toEqual([])
    expect(alarms).toEqual([])
    expect(lines).toEqual([
      {
        message: expect.stringContaining('nothing says whose it was'),
        fields: { error: 'TypeError', alarm: 'not_raised_unplaced' },
      },
    ])
    expect(JSON.stringify(lines)).not.toContain(ADDRESS)
  })

  it('still answers and alarms when the audit row cannot be written', async () => {
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    const recorder = recorderFor()
    const err = await handleInboundEmail(db, {
      from: ADDRESS, subject: null, text: 'Stop', messageId: '<reply-2@rentman.io>', references: [OUR_ID], now: NOON, log: recorder,
    }).catch((e: unknown) => e)
    const answer = await inboundEmailNotRecorded(err, { text: 'Stop', rolledBack: recorder.rolledBack() }, {
      ...deps(),
      audit: async () => {
        throw new Error('Connection terminated unexpectedly')
      },
    })
    expect(answer.status).toBe(500)
    expect(alarms).toHaveLength(1)
    expect(lines.at(-1)!.fields).toMatchObject({ audited: false, alarm: 'raised' })
  })

  it('forwards every line the recorder says, and keeps only an opt-out it names an org and a contact for', () => {
    const recorder = recorderFor()
    recorder.error('something else', { orgId, contactId })
    expect(recorder.rolledBack()).toBeNull()
    recorder.error('OPT-OUT NOT RECORDED — the reply was rolled back', { orgId, contactId, inReplyTo: null, why: 'Error' })
    expect(recorder.rolledBack()).toEqual({ orgId, contactId, inReplyTo: null })
    expect(lines.map((l) => l.message)).toEqual(['something else', 'OPT-OUT NOT RECORDED — the reply was rolled back'])
  })
})

describe('the route, as it wires it (read from the source)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const route = readFileSync(resolve(here, '../src/app/api/inbound/email/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('calls the recorder inside a try, with the keeping log, and answers a throw through fault.ts', () => {
    expect(route).toMatch(/try \{\s*outcome = await handleInboundEmail\(/)
    expect(route).toContain('log: recorder,')
    expect(route).toMatch(/\} catch \(err\) \{\s*const answer = await inboundEmailNotRecorded\(err, \{ text, rolledBack: recorder\.rolledBack\(\) \}/)
    expect(route).toContain('return NextResponse.json(answer.body, { status: answer.status })')
    expect(route).toContain(`from './fault'`)
  })

  it('never hands the error itself to a log line', () => {
    const caught = route.slice(route.indexOf('} catch (err) {'), route.indexOf('return NextResponse.json(answer.body'))
    expect(caught.length).toBeGreaterThan(0)
    expect(caught).not.toMatch(/\b(?:log|console)\.\w+\(/)
    expect(route).not.toContain('console.')
  })
})
