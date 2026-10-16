/**
 * The worker heartbeat (§2.4), against a real engine.
 *
 * A silent worker has to be a fact somebody can read, not an inference from
 * a queue that stopped moving. So: the writer keeps ONE row per worker and
 * moves it every tick (including its boot instant, because `hostname:pid`
 * survives a restart); the database refuses a row whose two instants
 * disagree or whose mode nobody defined; the reader returns whichever worker
 * ticked most recently; and the pure half turns a row and a clock into
 * `live` or `silent` at exactly the instants it says it does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  HEARTBEAT_RETIRED_AFTER_DAYS, HEARTBEAT_SILENT_AFTER_SECONDS,
  heartbeatAge, heartbeatBrief, heartbeatReport, heartbeatReportedStatus, heartbeatSilentAfter, heartbeatSms, heartbeatStatus,
  isCheckViolation, readLatestHeartbeat, schema, writeHeartbeat,
  type AgencyDb, type HeartbeatWrite, heartbeatMailLogin,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const BOOT = new Date('2026-09-15T12:00:00.000Z')
const at = (seconds: number) => new Date(BOOT.getTime() + seconds * 1000)
const DAY = 24 * 60 * 60

const beat = (over: Partial<HeartbeatWrite> = {}): HeartbeatWrite => ({
  workerId: 'fly-machine-1:1',
  bootedAt: BOOT,
  lastTickAt: at(15),
  outreach: 'send-only',
  chat: 'disabled',
  detail: { halted: false, lockHeld: true },
  ...over,
})

describe('writeHeartbeat and readLatestHeartbeat', () => {
  let test: TestDb
  let db: AgencyDb
  const rows = () => db.select().from(schema.workerHeartbeats)

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('reads null from a database no worker has written to', async () => {
    expect(await readLatestHeartbeat(db)).toBeNull()
  })

  it('keeps one row per worker and moves last_tick_at on every write', async () => {
    await writeHeartbeat(db, beat({ lastTickAt: at(15) }))
    await writeHeartbeat(db, beat({ lastTickAt: at(30), outreach: 'send-and-receive', chat: 'enabled' }))

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]!.lastTickAt.toISOString()).toBe(at(30).toISOString())
    expect(all[0]!.outreach).toBe('send-and-receive')
    expect(all[0]!.chat).toBe('enabled')
    expect(all[0]!.detail).toEqual({ halted: false, lockHeld: true })
    // The trigger stamps an update, so "when did this row last change" is
    // answerable without trusting the worker's clock.
    expect(all[0]!.updatedAt).not.toBeNull()
  })

  /**
   * `hostname:pid` is the same after a restart on Fly and in compose — same
   * machine, pid 1. An upsert that kept the old `booted_at` would describe a
   * process that no longer exists.
   */
  it('moves booted_at when the same worker id boots again', async () => {
    await writeHeartbeat(db, beat({ lastTickAt: at(15) }))
    const reboot = at(3600)
    await writeHeartbeat(db, beat({ bootedAt: reboot, lastTickAt: at(3601) }))

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]!.bootedAt.toISOString()).toBe(reboot.toISOString())
    expect(all[0]!.lastTickAt.toISOString()).toBe(at(3601).toISOString())
  })

  it('REFUSES a tick from before the boot, through the writer', async () => {
    const err = await writeHeartbeat(db, beat({ bootedAt: at(60), lastTickAt: at(59) })).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isCheckViolation(err, 'worker_heartbeats_beat_after_boot')).toBe(true)
    expect(await rows()).toHaveLength(0)
  })

  it('REFUSES an outreach mode nobody defined, through the writer', async () => {
    const err = await writeHeartbeat(
      db,
      beat({ outreach: 'maybe' as unknown as HeartbeatWrite['outreach'] }),
    ).then(() => null, (e: unknown) => e)
    expect(isCheckViolation(err, 'worker_heartbeats_outreach_known')).toBe(true)
    expect(await rows()).toHaveLength(0)
  })

  it('keeps two workers as two rows and reads the one that ticked most recently', async () => {
    // A rollout: the outgoing worker is still ticking when the new one boots.
    await writeHeartbeat(db, beat({ workerId: 'old:1', lastTickAt: at(100) }))
    await writeHeartbeat(db, beat({ workerId: 'new:1', bootedAt: at(90), lastTickAt: at(95) }))
    expect(await rows()).toHaveLength(2)
    expect((await readLatestHeartbeat(db))!.workerId).toBe('old:1')

    // The old one stops; the new one keeps going and becomes the answer.
    await writeHeartbeat(db, beat({ workerId: 'new:1', bootedAt: at(90), lastTickAt: at(110) }))
    const latest = await readLatestHeartbeat(db)
    expect(latest!.workerId).toBe('new:1')
    expect(latest!.lastTickAt.toISOString()).toBe(at(110).toISOString())
  })

  it('prunes a row nobody has written for 31 days, and keeps one from 29', async () => {
    const now = at(60 * DAY)
    await writeHeartbeat(db, beat({ workerId: 'gone:1', lastTickAt: at(29 * DAY) }))
    await writeHeartbeat(db, beat({ workerId: 'recent:1', lastTickAt: at(31 * DAY) }))

    await writeHeartbeat(db, beat({ workerId: 'current:1', bootedAt: at(60 * DAY - 10), lastTickAt: now }))
    const ids = (await rows()).map((r) => r.workerId).sort()
    expect(ids).toEqual(['current:1', 'recent:1'])
  })

  /**
   * The same machine, the same pid, back after a month off: its own row had
   * aged out, so it is deleted and written fresh rather than kept with the
   * boot instant of a process from last month.
   */
  it('writes a fresh row for a worker whose own row had aged out', async () => {
    await writeHeartbeat(db, beat({ lastTickAt: at(15) }))
    const [before] = await rows()
    const back = at(40 * DAY)
    await writeHeartbeat(db, beat({ bootedAt: back, lastTickAt: back }))

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).not.toBe(before!.id)
    expect(all[0]!.bootedAt.toISOString()).toBe(back.toISOString())
    expect(all[0]!.updatedAt).toBeNull()
  })

  it('feeds heartbeatReport the row it read', async () => {
    await writeHeartbeat(db, beat({ lastTickAt: at(15), chat: 'enabled' }))
    const report = heartbeatReport(await readLatestHeartbeat(db), true, at(75))
    expect(report).toEqual({
      configured: true,
      lastSeenAt: at(15),
      ageSeconds: 60,
      outreach: 'send-only',
      chat: 'enabled',
      sms: null, smtpLogin: null, imapLogin: null,
      status: 'live',
      retired: false,
    })
  })

  /**
   * The worker writes `sms` into `detail` (0019), because `outreach` and its
   * CHECK describe the mailbox. A worker with no SMTP and DoveSoft on is
   * `outreach: 'disabled'` and sends texts; the report has to carry both.
   */
  it('carries what the worker said about SMS through the row it wrote', async () => {
    await writeHeartbeat(db, beat({ outreach: 'disabled', detail: { halted: false, lockHeld: true, sms: 'on' } }))
    expect(heartbeatReport(await readLatestHeartbeat(db), true, at(20))).toMatchObject({
      status: 'live', outreach: 'disabled', sms: 'on',
    })
    await writeHeartbeat(db, beat({ lastTickAt: at(30), detail: { halted: false, lockHeld: true, sms: 'off' } }))
    expect(heartbeatReport(await readLatestHeartbeat(db), true, at(40)).sms).toBe('off')
  })
})

describe('the mailboxes’ logins on the row', () => {
  it('carries what the worker said about each login, and null where it said nothing', () => {
    const row = (detail: unknown) => ({ lastTickAt: new Date('2026-10-08T07:00:00Z'), outreach: 'send-and-receive', chat: 'enabled', detail })
    const now = new Date('2026-10-08T07:00:30Z')
    expect(heartbeatReport(row({ smtpLogin: 'refused', imapLogin: 'ok' }) as never, true, now)).toMatchObject({
      smtpLogin: 'refused', imapLogin: 'ok',
    })
    expect(heartbeatReport(row({ halted: false }) as never, true, now)).toMatchObject({ smtpLogin: null, imapLogin: null })
    expect(heartbeatReport(row({ smtpLogin: 'something else' }) as never, true, now).smtpLogin).toBeNull()
    expect(heartbeatMailLogin(null, 'smtpLogin')).toBeNull()
  })
})

describe('the pure half', () => {
  const row = { lastTickAt: at(0) }

  it('ages a row in whole seconds, and has no age without one', () => {
    expect(heartbeatAge(null, at(10))).toBeNull()
    expect(heartbeatAge(row, at(0))).toBe(0)
    expect(heartbeatAge(row, new Date(at(59).getTime() + 999))).toBe(59)
    expect(heartbeatAge(row, at(60))).toBe(60)
  })

  it('never reports a negative age for a row stamped by a clock that runs ahead', () => {
    expect(heartbeatAge(row, at(-3))).toBe(0)
  })

  it('transitions live → silent exactly past the threshold', () => {
    expect(heartbeatStatus(null, at(0))).toBe('never')
    expect(heartbeatStatus(row, at(0))).toBe('live')
    expect(heartbeatStatus(row, at(HEARTBEAT_SILENT_AFTER_SECONDS))).toBe('live')
    expect(heartbeatStatus(row, at(HEARTBEAT_SILENT_AFTER_SECONDS + 1))).toBe('silent')
    expect(heartbeatStatus(row, at(30), 30)).toBe('live')
    expect(heartbeatStatus(row, at(31), 30)).toBe('silent')
  })

  it('waits three of the worker’s own ticks when that is longer than the default', () => {
    expect(heartbeatSilentAfter(null)).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
    expect(heartbeatSilentAfter({ detail: {} })).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
    expect(heartbeatSilentAfter({ detail: { intervalMs: 15_000 } })).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
    expect(heartbeatSilentAfter({ detail: { intervalMs: 20 * 60_000 } })).toBe(3600)
    // Not a number the worker could have meant: the default, not NaN.
    expect(heartbeatSilentAfter({ detail: { intervalMs: '900000' } })).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
    expect(heartbeatSilentAfter({ detail: { intervalMs: -1 } })).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
    expect(heartbeatSilentAfter({ detail: null })).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
  })

  it('reads SMS as on or off from the row’s detail, and as unknown otherwise', () => {
    expect(heartbeatSms({ detail: { sms: 'on' } })).toBe('on')
    expect(heartbeatSms({ detail: { sms: 'off', intervalMs: 15_000 } })).toBe('off')
    // A worker from before 0019 wrote nothing about SMS: unknown, never "off".
    expect(heartbeatSms({ detail: { halted: false, lockHeld: true } })).toBeNull()
    expect(heartbeatSms(null)).toBeNull()
    expect(heartbeatSms({ detail: null })).toBeNull()
    // Not a value the worker writes: not guessed at.
    for (const sms of ['ON', 'yes', true, 1, '']) expect(heartbeatSms({ detail: { sms } }), String(sms)).toBeNull()
  })

  it('reads whether the worker writes the morning brief, and a worker from before 0020 as unknown', () => {
    expect(heartbeatBrief({ detail: { brief: 'on', sms: 'off' } })).toBe('on')
    expect(heartbeatBrief({ detail: { brief: 'off' } })).toBe('off')
    // Started before 0020: it writes no brief, but the row never said "off".
    expect(heartbeatBrief({ detail: { halted: false, lockHeld: true, sms: 'on' } })).toBeNull()
    expect(heartbeatBrief(null)).toBeNull()
    for (const brief of ['ON', 'yes', true, 1, '']) expect(heartbeatBrief({ detail: { brief } }), String(brief)).toBeNull()
  })

  describe('heartbeatReport', () => {
    const r = (seconds: number, detail: unknown = {}) => ({
      lastTickAt: at(seconds), outreach: 'send-only', chat: 'disabled', detail,
    })

    it('says not_configured only when there is no row and no worker is configured', () => {
      expect(heartbeatReport(null, false, at(0))).toEqual({
        configured: false, lastSeenAt: null, ageSeconds: null, outreach: null, chat: null, sms: null, smtpLogin: null, imapLogin: null,
        status: 'not_configured', retired: false,
      })
      expect(heartbeatReport(null, true, at(0)).status).toBe('never')
    })

    /**
     * A worker on Fly writing to a database whose web half has no AGENT_URL
     * is still sending. The configuration does not get to overrule the row.
     */
    it('reports a live row as live whatever the configuration says', () => {
      const report = heartbeatReport(r(0), false, at(20))
      expect(report).toMatchObject({ configured: false, status: 'live', ageSeconds: 20, outreach: 'send-only' })
    })

    it('reports a silent row as silent, with its age', () => {
      expect(heartbeatReport(r(0), true, at(601))).toMatchObject({ status: 'silent', ageSeconds: 601 })
      expect(heartbeatReport(r(0), false, at(601)).status).toBe('silent')
    })

    it('uses the row’s own tick interval for the threshold', () => {
      const slow = r(0, { intervalMs: 20 * 60_000 })
      expect(heartbeatReport(slow, true, at(1800)).status).toBe('live')
      expect(heartbeatReport(slow, true, at(3601)).status).toBe('silent')
    })

    /**
     * `./tools/run-worker.sh` against production, once, then closed: its row
     * stays, and only a running worker's own write prunes it. Where no worker
     * is configured, a row that old is a session somebody ran by hand and
     * closed — named as such, and alerted about by nobody. A worker that was
     * running and stopped is worth a week of notices first.
     */
    it('reads a silent row past a week, where no worker is configured, as a retired session', () => {
      const week = HEARTBEAT_RETIRED_AFTER_DAYS * DAY
      expect(HEARTBEAT_RETIRED_AFTER_DAYS).toBe(7)
      expect(heartbeatReport(r(0), false, at(week + 1))).toMatchObject({
        status: 'silent', retired: true, ageSeconds: week + 1, lastSeenAt: at(0),
      })
      expect(heartbeatReportedStatus(heartbeatReport(r(0), false, at(week + 1)))).toBe('retired')
      // A week to the second is still a worker that stopped.
      expect(heartbeatReport(r(0), false, at(week))).toMatchObject({ status: 'silent', retired: false })
      expect(heartbeatReportedStatus(heartbeatReport(r(0), false, at(week)))).toBe('silent')
      // Where a worker IS configured, a stopped one is silent however long ago it stopped.
      expect(heartbeatReport(r(0), true, at(30 * DAY))).toMatchObject({ status: 'silent', retired: false })
      expect(heartbeatReportedStatus(heartbeatReport(r(0), true, at(30 * DAY)))).toBe('silent')
    })

    it('never calls a row retired that is not silent, or that is not there', () => {
      // A worker that ticks every four days is on time six days after its last write.
      const glacial = r(0, { intervalMs: 4 * DAY * 1000 })
      expect(heartbeatReport(glacial, false, at(8 * DAY))).toMatchObject({ status: 'live', retired: false })
      expect(heartbeatReport(glacial, false, at(12 * DAY + 1))).toMatchObject({ status: 'silent', retired: true })
      expect(heartbeatReport(null, false, at(0))).toMatchObject({ status: 'not_configured', retired: false })
      expect(heartbeatReport(null, true, at(0))).toMatchObject({ status: 'never', retired: false })
      for (const status of ['not_configured', 'never', 'live', 'silent'] as const) {
        expect(heartbeatReportedStatus({ status, retired: false })).toBe(status)
      }
    })
  })
})
