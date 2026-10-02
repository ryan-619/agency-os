/**
 * The IMAP drain: what is marked `\Seen`, and when the mailbox is read again.
 *
 * Round 4 made `recordInboundReply` one transaction, so a database fault
 * leaves NO row where it used to leave one with a NULL kind — and the drain
 * marked every UID seen in a `finally`. A "stop" that met a transient fault
 * was therefore never retried and never recorded: an error line was all that
 * remained of it. And nothing would have retried it anyway: imapflow's
 * `idle()` ends only when another command breaks it, so an EXISTS for new
 * mail woke nothing, and the mailbox was read again only after a reconnect.
 *
 * `drainUnseen` is driven against a fake client for its rules; `startInbox`
 * against a fake mailbox, a real migrated database, and a fault the engine
 * raises, for the whole loop. The fake's `idle()` behaves as imapflow's does:
 * it resolves on a command (NOOP, LOGOUT) and never on an EXISTS.
 *
 * And a "stop" the drain cannot record takes the webhooks' loud path on its
 * first failure (review round 6): the contact paused, a
 * `contact.opt_out_not_recorded` row, and the awaited alarm — once per
 * message, however often it is retried. Before, it was retried and then
 * abandoned with log lines only: nothing paused them, nothing alarmed, and
 * /compliance and the digest counted nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { pauseReasonClass, type SlackOptOutNotRecordedEvent } from '@agency/core'
import { schema, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { failOnce, throughTransactions } from '../../../packages/db/test/fault-db.js'
import {
  DRAIN_TIMING,
  INBOUND_MAX_ATTEMPTS,
  UnreadableInboundMessage,
  drainUnseen,
  handleInboundMessage,
  startInbox,
  type InboxClient,
} from '../src/outreach/inbox.js'
import type { Logger } from '../src/logger.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')

/** A Logger that keeps every line it is handed, as the JSON the real one would print. */
function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ level, msg, ...fields }))
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

/**
 * A mailbox, and a client of it that behaves as imapflow does where it
 * matters: `idle()` resolves only when a command breaks it.
 */
class FakeMailbox implements InboxClient {
  readonly messages = new Map<number, { source: Buffer | null; seen: boolean }>()
  private readonly listeners = new Set<() => void>()
  private endIdle: (() => void) | null = null
  searches = 0
  idles = 0

  async connect(): Promise<void> {}
  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => {} }
  }
  idle(): Promise<boolean> {
    this.idles++
    return new Promise((resolve) => {
      this.endIdle = () => {
        this.endIdle = null
        resolve(true)
      }
    })
  }
  get idling(): boolean {
    return this.endIdle !== null
  }
  async noop(): Promise<void> {
    this.endIdle?.()
  }
  async logout(): Promise<void> {
    this.endIdle?.()
  }
  async search(): Promise<number[] | false> {
    this.searches++
    const unseen = [...this.messages].filter(([, m]) => !m.seen).map(([uid]) => uid)
    return unseen.length ? unseen : false
  }
  async fetchOne(uid: string): Promise<{ source?: Buffer } | false> {
    const m = this.messages.get(Number(uid))
    if (!m) return false
    return m.source ? { source: m.source } : {}
  }
  async messageFlagsAdd(uid: string, flags: string[]): Promise<boolean> {
    const m = this.messages.get(Number(uid))
    if (m && flags.includes('\\Seen')) m.seen = true
    return true
  }
  on(_event: 'exists', listener: () => void): this {
    this.listeners.add(listener)
    return this
  }
  off(_event: 'exists', listener: () => void): this {
    this.listeners.delete(listener)
    return this
  }

  put(uid: number, source: string | null): void {
    this.messages.set(uid, { source: source === null ? null : Buffer.from(source), seen: false })
  }
  /** New mail: the server's untagged EXISTS, which imapflow turns into an event and nothing more. */
  deliver(uid: number, source: string): void {
    this.put(uid, source)
    for (const l of this.listeners) l()
  }
  seen(uid: number): boolean {
    return this.messages.get(uid)?.seen ?? false
  }
}

const dbFault = (): Error => Object.assign(new Error('terminating connection due to administrator command'), { name: 'DatabaseError' })

describe('drainUnseen', () => {
  let box: FakeMailbox
  let attempts: Map<number, number>
  let log: Logger
  let lines: string[]

  beforeEach(() => {
    box = new FakeMailbox()
    attempts = new Map()
    ;({ log, lines } = captureLog())
  })

  const drain = (handle: (source: Buffer, uid: number) => Promise<unknown>) => drainUnseen(box, { log, handle, attempts })

  it('marks a message seen once it was handled', async () => {
    box.put(1, 'a reply')
    expect(await drain(async () => ({ matched: 'message' }))).toEqual({ retryInMs: null })
    expect(box.seen(1)).toBe(true)
  })

  /** The fix: a fault while recording it is not handling it. */
  it('leaves a message whose recording threw UNSEEN, counts the attempt, and asks to be run again', async () => {
    box.put(7, 'Stop')
    const r = await drain(async () => {
      throw dbFault()
    })
    expect(box.seen(7)).toBe(false)
    expect(attempts.get(7)).toBe(1)
    expect(r).toEqual({ retryInMs: DRAIN_TIMING.retryMs })
    const line = JSON.parse(lines.at(-1)!) as Record<string, unknown>
    expect(line).toEqual({
      level: 'error', msg: 'could not record an inbound message; left unseen to retry',
      uid: 7, error: 'DatabaseError', attempt: 1, of: INBOUND_MAX_ATTEMPTS,
    })
  })

  it('marks seen what can never be handled: unreadable, or with no source', async () => {
    box.put(2, '\u0000 not a mail')
    box.put(3, null)
    const handled: number[] = []
    const r = await drain(async (_source, uid) => {
      handled.push(uid)
      throw new UnreadableInboundMessage('TypeError')
    })
    expect(r).toEqual({ retryInMs: null })
    expect(box.seen(2)).toBe(true)
    expect(box.seen(3)).toBe(true)
    // No source is never handed to the handler at all.
    expect(handled).toEqual([2])
    expect(attempts.size).toBe(0)
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'error', msg: 'could not read an inbound message; marked seen', uid: 2, error: 'TypeError' },
    ])
  })

  it(`abandons a message on its ${INBOUND_MAX_ATTEMPTS}th failure: seen, and said at error with the uid and the error's name only`, async () => {
    box.put(9, 'From: priya@rentman.io\r\n\r\nPlease unsubscribe me.')
    const failing = async (): Promise<never> => {
      throw dbFault()
    }
    const asked: (number | null)[] = []
    for (let i = 1; i < INBOUND_MAX_ATTEMPTS; i++) {
      asked.push((await drain(failing)).retryInMs)
      expect(box.seen(9)).toBe(false)
      expect(attempts.get(9)).toBe(i)
    }
    // Doubling from the base, so the attempts span a quarter of an hour, not five minutes.
    expect(asked).toEqual([60_000, 120_000, 240_000, 480_000])

    expect(await drain(failing)).toEqual({ retryInMs: null })
    expect(box.seen(9)).toBe(true)
    expect(attempts.has(9)).toBe(false)
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      level: 'error', msg: 'INBOUND MESSAGE ABANDONED — handle it by hand', uid: 9, error: 'DatabaseError',
    })
    expect(lines.join('\n')).not.toContain('priya@')
    expect(lines.join('\n')).not.toContain('unsubscribe')
    expect(lines.join('\n')).not.toContain('administrator command')
  })

  it('caps the wait at the refresh', async () => {
    box.put(4, 'x')
    attempts.set(4, 3)
    expect(await drainUnseen(box, { log, handle: async () => { throw dbFault() }, attempts }, { retryMs: 60_000, refreshMs: 100_000 }))
      .toEqual({ retryInMs: 100_000 })
  })

  it('forgets the count once a retry records it', async () => {
    box.put(5, 'Stop')
    let fail = true
    const flaky = async (): Promise<unknown> => {
      if (fail) throw dbFault()
      return null
    }
    await drain(flaky)
    expect(attempts.get(5)).toBe(1)
    fail = false
    expect(await drain(flaky)).toEqual({ retryInMs: null })
    expect(box.seen(5)).toBe(true)
    expect(attempts.size).toBe(0)
  })

  /**
   * The stops already said out loud are remembered beside the count, and
   * forgotten with it: a UID handled, unreadable or abandoned is settled,
   * and one still to be retried keeps its entry, so its retry alarms nobody
   * twice.
   */
  it('forgets a stop it said out loud once the message is settled, and keeps it while it is retried', async () => {
    const unrecordedStops = new Map<string, { readonly written: boolean }>([
      ['1', { written: true }], ['2', { written: true }], ['3', { written: true }], ['4', { written: false }],
    ])
    attempts.set(3, INBOUND_MAX_ATTEMPTS - 1)
    box.put(1, 'recorded now')
    box.put(2, 'unreadable')
    box.put(3, 'abandoned')
    await drainUnseen(box, {
      log,
      attempts,
      unrecordedStops,
      handle: async (source) => {
        const said = source.toString()
        if (said === 'unreadable') throw new UnreadableInboundMessage('TypeError')
        if (said === 'abandoned') throw dbFault()
        return null
      },
    })
    expect([...unrecordedStops.keys()]).toEqual(['4'])

    box.put(4, 'still failing')
    await drainUnseen(box, { log, attempts, unrecordedStops, handle: async () => { throw dbFault() } })
    expect(box.seen(4)).toBe(false)
    expect(unrecordedStops.get('4')).toEqual({ written: false })
  })

  /**
   * A database that is down fails every message, and charging each would
   * abandon the whole inbox to one outage; and one message that will never
   * record must not hold up a "stop" behind it.
   */
  it('charges only the first failure of a drain, and still tries the messages behind it', async () => {
    box.put(1, 'poison')
    box.put(2, 'also failing')
    box.put(3, 'Stop')
    await drain(async (source) => {
      if (source.toString() !== 'Stop') throw dbFault()
      return null
    })
    expect(attempts).toEqual(new Map([[1, 1]]))
    expect([box.seen(1), box.seen(2), box.seen(3)]).toEqual([false, false, true])
  })
})

/**
 * The whole loop, minus the server: `startInbox` on a fake mailbox, a real
 * database, and the real `handleInboundMessage`.
 */
describe('startInbox', () => {
  let test: TestDb
  let db: AgencyDb
  let stop: (() => Promise<void>) | null
  let orgId: string
  let contactId: string
  let sentId: string

  const raw = (headers: string, body: string): string => `${headers.trim()}\r\n\r\n${body}`
  const reply = (body: string, id: string): string =>
    raw(
      `From: Priya <priya@rentman.io>
To: outreach@agency.test
Subject: Re: A gap on your security page
Message-ID: ${id}
In-Reply-To: <sent-1@agency.test>`,
      body,
    )

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    stop = null
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
    const [sent] = await db.insert(schema.touches).values({
      orgId, contactId, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
      recipient: 'priya@rentman.io', sentAt: NOON, providerId: '<sent-1@agency.test>',
      subject: 'A gap on your security page', body: 'Hello.',
    }).returning({ id: schema.touches.id })
    sentId = sent!.id
    // `recordInboundReply` says OPT-OUT NOT RECORDED on stderr when a stop is rolled back.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  }, 30_000)

  afterEach(async () => {
    await stop?.()
    vi.restoreAllMocks()
    await test?.close()
  })

  const start = (
    box: FakeMailbox,
    target: AgencyDb,
    timing: { retryMs: number; refreshMs: number },
    alarms: SlackOptOutNotRecordedEvent[] | null = null,
  ) => {
    const { log, lines } = captureLog()
    stop = startInbox({
      db: target,
      log,
      config: { host: 'imap.test', port: 993, secure: true, user: 'outreach', password: 'x', mailbox: 'INBOX' },
      optOutAlarm: alarms
        ? async (event) => {
            alarms.push(event)
          }
        : null,
      now: () => NOON,
      connect: () => box,
      timing,
    })
    return lines
  }
  const suppressions = async () =>
    (await db.select().from(schema.suppressions)).map((s) => ({ kind: s.kind, value: s.value, source: s.source }))
  const notRecordedRows = async () =>
    db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'contact.opt_out_not_recorded')))
  const contactRow = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!
  /** Every write of an inbound row fails, whatever transaction it is in; everything else works. */
  const refusingReplies = (): AgencyDb =>
    throughTransactions(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.touches) throw Object.assign(new Error('the database is down'), { name: 'DatabaseError' })
            return (target as AgencyDb).insert(table as typeof schema.suppressions)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  const said = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>)

  /**
   * The probe: a "stop" whose transaction the engine aborts. Before, it was
   * marked seen with nothing recorded; now it stays unseen, the retry timer
   * wakes the idle, and the next drain records it — suppression and all.
   */
  it('retries a "stop" whose recording the database refused, and records it, while the mailbox idles', async () => {
    await failOnce(test.pg, { table: 'contacts', event: 'UPDATE' })
    const box = new FakeMailbox()
    box.put(7, reply('Stop', '<stop-7@rentman.io>'))
    const alarms: SlackOptOutNotRecordedEvent[] = []
    const lines = start(box, db, { retryMs: 20, refreshMs: 60_000 }, alarms)

    await vi.waitFor(() => expect(box.seen(7)).toBe(true), { timeout: 10_000 })
    expect(box.searches).toBeGreaterThanOrEqual(2)
    expect(await suppressions()).toEqual([{ kind: 'email', value: 'priya@rentman.io', source: 'reply' }])
    const inbound = await db.select().from(schema.touches).where(eq(schema.touches.direction, 'in'))
    expect(inbound.map((t) => t.replyKind)).toEqual(['opted_out'])
    expect(lines.some((l) => l.includes('left unseen to retry') && l.includes('"uid":7'))).toBe(true)
    expect(lines.join('\n')).not.toContain('ABANDONED')
    // The first failure was said out loud, as the webhooks say it — once —
    // and the pause it wrote stands over the retry's.
    expect(alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId, touchId: sentId, contactId, path: 'reply' }])
    expect(await notRecordedRows()).toHaveLength(1)
    expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('opt_out_not_recorded')
  })

  /**
   * The probe (review round 6): a "stop" that never records. It used to be
   * retried and abandoned with log lines only — the contact live, nothing
   * in /audit, nothing in Slack. Now its FIRST failure pauses them, writes
   * the row /compliance and the digest count and raises the alarm, and the
   * retries and the abandonment say nothing more.
   */
  it(`pauses, audits and alarms a "stop" it cannot record on its first failure — once in ${INBOUND_MAX_ATTEMPTS} attempts`, async () => {
    const box = new FakeMailbox()
    box.put(9, reply('Please unsubscribe me.', '<stop-9@rentman.io>'))
    const alarms: SlackOptOutNotRecordedEvent[] = []
    const lines = start(box, refusingReplies(), { retryMs: 2, refreshMs: 60_000 }, alarms)

    await vi.waitFor(() => expect(box.seen(9)).toBe(true), { timeout: 10_000 })
    const out = said(lines)
    expect(out.filter((l) => String(l.msg).startsWith('INBOUND MESSAGE ABANDONED'))).toHaveLength(1)

    expect(alarms).toEqual([{ kind: 'opt_out_not_recorded', orgId, touchId: sentId, contactId, path: 'reply' }])
    const rows = await notRecordedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: 'system', subjectType: 'contact', subjectId: contactId, detail: { channel: 'email', why: 'record_failed' },
    })
    const contact = await contactRow()
    expect(contact.pausedAt).toEqual(NOON)
    expect(contact.pausedReason).toBe(`opt-out not recorded: reply ${NOON.toISOString()} (record_failed)`)

    // Said once, before the first retry was asked for — ids, never the words.
    const loud = out.filter((l) => String(l.msg).startsWith('OPT-OUT NOT RECORDED — a reply that asked to stop'))
    expect(loud).toEqual([
      {
        level: 'error',
        msg: expect.stringContaining('could not be recorded'),
        uid: 9, error: 'DatabaseError', orgId, contactId, paused: true, audited: true, alarm: 'raised',
      },
    ])
    expect(out.indexOf(loud[0]!)).toBeLessThan(out.findIndex((l) => l.msg === 'could not record an inbound message; left unseen to retry'))
    // The recorder's own rolled-back line still goes where it always went.
    const stderr = vi.mocked(console.error).mock.calls.map((c) => String(c[0]))
    expect(stderr.filter((l) => l.includes('the reply was rolled back'))).toHaveLength(INBOUND_MAX_ATTEMPTS)
    expect(JSON.stringify([lines, stderr, rows])).not.toContain('priya@')
    expect(JSON.stringify([lines, stderr, rows])).not.toContain('unsubscribe me')
  })

  it('writes on a later failure the row the first could not, and raises the alarm only once', async () => {
    await failOnce(test.pg, { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'contact.opt_out_not_recorded'` })
    const box = new FakeMailbox()
    box.put(9, reply('Stop', '<stop-9@rentman.io>'))
    const alarms: SlackOptOutNotRecordedEvent[] = []
    const lines = start(box, refusingReplies(), { retryMs: 2, refreshMs: 60_000 }, alarms)

    await vi.waitFor(() => expect(box.seen(9)).toBe(true), { timeout: 10_000 })
    expect(alarms).toHaveLength(1)
    expect(await notRecordedRows()).toHaveLength(1)
    const loud = said(lines).filter((l) => String(l.msg).startsWith('OPT-OUT NOT RECORDED — a reply that asked to stop'))
    expect(loud.map((l) => [l.audited, l.alarm])).toEqual([
      [false, 'raised'],
      [true, 'already_raised'],
    ])
  })

  it('pauses nobody and raises nothing for an ordinary reply it cannot record', async () => {
    const box = new FakeMailbox()
    box.put(9, reply('Thursday works — send an invite.', '<yes-9@rentman.io>'))
    const alarms: SlackOptOutNotRecordedEvent[] = []
    const lines = start(box, refusingReplies(), { retryMs: 2, refreshMs: 60_000 }, alarms)

    await vi.waitFor(() => expect(box.seen(9)).toBe(true), { timeout: 10_000 })
    expect(alarms).toEqual([])
    expect(await notRecordedRows()).toEqual([])
    expect((await contactRow()).pausedAt).toBeNull()
    expect(lines.join('\n')).not.toContain('OPT-OUT NOT RECORDED')
  })

  /** A caller with no inbox around it — nothing to remember a UID — takes the loud path on every failure. */
  it('takes the loud path from handleInboundMessage itself, before rethrowing the fault', async () => {
    const { log } = captureLog()
    const alarms: SlackOptOutNotRecordedEvent[] = []
    const deps = {
      db: refusingReplies(), log, now: () => NOON,
      optOutAlarm: async (event: SlackOptOutNotRecordedEvent) => {
        alarms.push(event)
      },
    }
    await expect(handleInboundMessage(reply('Stop', '<stop-3@rentman.io>'), 3, deps)).rejects.toMatchObject({ name: 'DatabaseError' })
    expect(alarms).toHaveLength(1)
    expect(await notRecordedRows()).toHaveLength(1)
    expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('opt_out_not_recorded')
  })

  /**
   * imapflow's `idle()` ends only to run another command. An EXISTS is an
   * event, so the inbox breaks the idle itself; the refresh is a minute
   * away here, so only the EXISTS can explain the drain.
   */
  it('drains new mail when the server announces it, not only after a reconnect', async () => {
    const box = new FakeMailbox()
    start(box, db, { retryMs: 20, refreshMs: 60_000 })
    await vi.waitFor(() => expect(box.idling).toBe(true), { timeout: 10_000 })

    box.deliver(8, reply('Thursday works — send an invite.', '<yes-8@rentman.io>'))
    await vi.waitFor(() => expect(box.seen(8)).toBe(true), { timeout: 10_000 })
    const inbound = await db.select().from(schema.touches).where(eq(schema.touches.direction, 'in'))
    expect(inbound).toHaveLength(1)
  })

  /** And with nothing to wake it, the refresh re-reads the mailbox anyway. */
  it('re-reads the mailbox on the refresh with no EXISTS at all', async () => {
    const box = new FakeMailbox()
    start(box, db, { retryMs: 20, refreshMs: 30 })
    await vi.waitFor(() => expect(box.idling).toBe(true), { timeout: 10_000 })
    // Arrived without an announcement.
    box.put(6, reply('Interested.', '<quiet-6@rentman.io>'))
    await vi.waitFor(() => expect(box.seen(6)).toBe(true), { timeout: 10_000 })
  })

  it(`abandons a message that never records, after ${INBOUND_MAX_ATTEMPTS} attempts, and says so`, async () => {
    const failing = refusingReplies()
    const box = new FakeMailbox()
    box.put(9, reply('Please unsubscribe me.', '<stop-9@rentman.io>'))
    const lines = start(box, failing, { retryMs: 2, refreshMs: 60_000 })

    await vi.waitFor(() => expect(box.seen(9)).toBe(true), { timeout: 10_000 })
    const said = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(said.filter((l) => l.msg === 'could not record an inbound message; left unseen to retry')).toHaveLength(INBOUND_MAX_ATTEMPTS - 1)
    expect(said.filter((l) => l.level === 'error' && String(l.msg).startsWith('INBOUND MESSAGE ABANDONED'))).toEqual([
      { level: 'error', msg: 'INBOUND MESSAGE ABANDONED — handle it by hand', uid: 9, error: 'DatabaseError' },
    ])
    expect(lines.join('\n')).not.toContain('priya@')
    expect(lines.join('\n')).not.toContain('unsubscribe me')
  })
})
