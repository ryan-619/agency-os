/**
 * The morning brief's scheduler (0020), against a real migrated database and a
 * stand-in for the turn: a due brief is claimed ONCE, lands in a fresh thread
 * of the person who switched it on, is asked to do the brief at the time it
 * starts, and is audited; a brief that cannot start spends its day and says
 * why, rather than being tried every minute; "Run it now" starts one at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { requestBrief, saveBrief, schema, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { runDueBriefs, startMorningBriefs, type BriefStarter } from '../src/brief/scheduler.js'
import type { Logger } from '../src/logger.js'

interface Line { level: string; msg: string; fields: Record<string, unknown> | undefined }

function capture(): { log: Logger; lines: Line[] } {
  const lines: Line[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields })
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

describe('runDueBriefs', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let owner: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [u] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    owner = u!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const auditRows = (action: string) =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  /** A starter that records what it was asked and ends the turn at once. */
  function recorder(answer?: { ok: false; message: string }) {
    const calls: Parameters<BriefStarter>[0][] = []
    const start: BriefStarter = async (req) => {
      calls.push(req)
      return answer ?? { ok: true, finished: Promise.resolve() }
    }
    return { calls, start }
  }

  // 03:40 UTC is 09:10 in Kolkata, past an 08:30 brief.
  const morning = new Date('2026-10-07T03:40:00Z')

  it('starts a due brief once, in a fresh thread of the person who switched it on', async () => {
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    const { calls, start } = recorder()
    const { log, lines } = capture()

    expect(await runDueBriefs({ db, log, now: () => morning, start })).toBe(1)
    // A second look the same day — or a second worker — starts nothing.
    expect(await runDueBriefs({ db, log, now: () => new Date('2026-10-07T03:41:00Z'), start })).toBe(0)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.userId).toBe(owner)
    // Asked at the time it STARTED (09:10), not the time it was set for.
    expect(call.text).toContain('MORNING BRIEF for 2026-10-07 (09:10, Asia/Kolkata)')

    const [thread] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, call.chatSessionId))
    expect(thread).toMatchObject({ orgId, userId: owner, title: 'Morning brief · 2026-10-07' })

    const started = await auditRows('assistant.brief_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      actor: 'system', subjectType: 'chat_session', subjectId: call.chatSessionId,
      detail: { date: '2026-10-07', requested: false },
    })
    expect(lines.some((l) => l.msg === 'morning brief started')).toBe(true)
  })

  it('spends the day on a brief that could not start, records why, and tries again tomorrow', async () => {
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    const { calls, start } = recorder({ ok: false, message: 'chat_disabled' })
    const { log, lines } = capture()

    expect(await runDueBriefs({ db, log, now: () => morning, start })).toBe(0)
    expect(await runDueBriefs({ db, log, now: () => new Date('2026-10-07T04:00:00Z'), start })).toBe(0)
    expect(calls).toHaveLength(1)

    const failed = await auditRows('assistant.brief_failed')
    expect(failed.map((r) => r.detail)).toEqual([{ date: '2026-10-07', requested: false, why: 'chat_disabled' }])
    expect(lines.find((l) => l.msg === 'the morning brief could not start')?.level).toBe('warn')

    const ok = recorder()
    expect(await runDueBriefs({ db, log, now: () => new Date('2026-10-08T03:40:00Z'), start: ok.start })).toBe(1)
  })

  it('starts one at once when somebody pressed Run it now, whatever the clock says', async () => {
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    const early = new Date('2026-10-07T01:30:00Z') // 07:00 in Kolkata
    const { calls, start } = recorder()
    const { log } = capture()

    expect(await runDueBriefs({ db, log, now: () => early, start })).toBe(0)
    await requestBrief(db, { orgId, actor: owner })
    expect(await runDueBriefs({ db, log, now: () => early, start })).toBe(1)
    expect(calls[0]!.text).toContain('(07:00, Asia/Kolkata)')
    expect((await auditRows('assistant.brief_started'))[0]?.detail).toEqual({ date: '2026-10-07', requested: true })
    // That was the day's brief: 08:30 starts no second one.
    expect(await runDueBriefs({ db, log, now: () => morning, start })).toBe(0)
  })

  it('waits for one brief to finish before starting the next org’s', async () => {
    const [org2] = await db.insert(schema.orgs).values({ name: 'Second' }).returning({ id: schema.orgs.id })
    const [u2] = await db.insert(schema.users).values({ orgId: org2!.id, email: 'two@second.test', role: 'owner' }).returning({ id: schema.users.id })
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    await saveBrief(db, { orgId: org2!.id, actor: u2!.id, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })

    const order: string[] = []
    let release!: () => void
    const first = new Promise<void>((r) => { release = r })
    const start: BriefStarter = async (req) => {
      order.push(`start ${req.userId === owner ? 'one' : 'two'}`)
      const finished = order.length === 1 ? first.then(() => { order.push('end first') }) : Promise.resolve()
      return { ok: true, finished }
    }
    const { log } = capture()
    const run = runDueBriefs({ db, log, now: () => morning, start })
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toHaveLength(1)
    release()
    expect(await run).toBe(2)
    expect(order[1]).toBe('end first')
    expect(order).toHaveLength(3)
  })

  it('logs a failing look once per streak, by class, and once when it works again', async () => {
    const { log, lines } = capture()
    let broken = true
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (broken && prop === 'select') {
          return () => {
            throw Object.assign(new Error('relation "assistant_settings" does not exist postgres://u:p@h/db'), {
              name: 'DatabaseError',
            })
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const stop = startMorningBriefs({
      db: failingDb, log, now: () => morning, start: recorder().start, intervalMs: 20,
    })
    await new Promise((r) => setTimeout(r, 120))
    broken = false
    await new Promise((r) => setTimeout(r, 60))
    stop()
    const failed = lines.filter((l) => l.msg === 'the morning brief check failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.fields).toEqual({ error: 'DatabaseError' })
    expect(JSON.stringify(lines)).not.toContain('postgres://')
    expect(lines.filter((l) => l.msg === 'the morning brief check works again')).toHaveLength(1)
  })
})
