/**
 * What came of a call (0027): the outcome and the completion land together;
 * a call back makes the next task on the day agreed; asked to stop puts the
 * number on the suppression list first and is refused, rolled back, when it
 * cannot; and nothing but an open call or visit takes one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { migratedDb, expectRejection, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import type { AgencyDb } from '../src/repository.js'
import { TASK_OUTCOMES, tasksCreate, tasksRecordOutcome, tasksReopen } from '../src/tasks.js'

const NOW = new Date('2026-10-09T09:00:00.000Z')

describe('what came of a call', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental', phone: '+918041234567', timeZone: 'Asia/Kolkata' }).returning({ id: schema.companies.id }))[0]!.id
  }, 30_000)
  afterEach(async () => {
    await test.close()
  })

  const call = async () => {
    const r = await tasksCreate(db, { orgId, companyId, kind: 'call', title: 'Call Kumar Dental', createdBy: ownerId, actor: ownerId })
    if (!r.ok) throw new Error(r.message)
    return r.task.id
  }
  const record = (id: string, outcome: (typeof TASK_OUTCOMES)[number], callBackOn?: string) =>
    tasksRecordOutcome(db, { orgId, id, byUserId: ownerId, actor: ownerId, outcome, callBackOn: callBackOn ?? null, now: NOW })
  const task = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
  const suppressions = () => db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
  const audit = (action: string) => db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))

  it('records the outcome with the completion, once', async () => {
    const id = await call()
    const r = await record(id, 'reached')
    expect(r).toMatchObject({ ok: true, callBackTaskId: null, suppressed: false })
    expect(await task(id)).toMatchObject({ doneAt: NOW, doneBy: ownerId, outcome: 'reached' })
    expect(await record(id, 'no_answer')).toMatchObject({ ok: false, reason: 'already_done' })
    // Reopened, it forgets what came of it — or the CHECK would refuse the reopen.
    expect(await tasksReopen(db, { orgId, id, actor: ownerId })).toMatchObject({ ok: true })
    expect(await task(id)).toMatchObject({ doneAt: null, outcome: null })
    expect(await record(id, 'busy')).toMatchObject({ ok: true })
    const [row] = await audit('task.outcome_recorded')
    expect(row!.detail).toEqual({ outcome: 'reached', kind: 'call', companyId, callBackTaskId: null, suppressed: false })
  })

  it('makes the next call on the day agreed, at 10:00 where the company is, for the person who recorded it', async () => {
    const id = await call()
    expect(await record(id, 'call_back')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await record(id, 'call_back', '2025-01-01')).toMatchObject({ ok: false, reason: 'invalid' })
    const r = await record(id, 'call_back', '2026-10-14')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.callBackTaskId).toBeTruthy()
    const next = await task(r.callBackTaskId!)
    expect(next).toMatchObject({
      kind: 'call', title: 'Call Kumar Dental again, as agreed on the phone', assigneeUserId: ownerId, createdBy: ownerId, doneAt: null,
      dueAt: new Date('2026-10-14T04:30:00.000Z'),
    })
    expect(await task(id)).toMatchObject({ outcome: 'call_back' })
  })

  it('puts the number on the suppression list first when they asked not to be called, by the person', async () => {
    const id = await call()
    const r = await record(id, 'asked_to_stop')
    expect(r).toMatchObject({ ok: true, suppressed: true })
    const rows = await suppressions()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'phone', value: '+918041234567', source: 'manual', reason: 'asked on the phone, 2026-10-09' })
    expect((await audit('suppression.added'))[0]!.actor).toBe(ownerId)
    expect(await task(id)).toMatchObject({ outcome: 'asked_to_stop' })
    // A later call task to the number is refused by the suppression, as every call task is.
    expect(await tasksCreate(db, { orgId, companyId, kind: 'call', title: 'Again', createdBy: ownerId, actor: ownerId })).toMatchObject({ ok: false, reason: 'suppressed' })
  })

  it('refuses asked-to-stop, rolled back, when the number cannot be recorded', async () => {
    const id = await call()
    await db.update(schema.companies).set({ phone: null }).where(eq(schema.companies.id, companyId))
    const r = await record(id, 'asked_to_stop')
    expect(r).toMatchObject({ ok: false, reason: 'suppression_failed' })
    expect((r as { message: string }).message).toContain('/suppressions')
    expect(await task(id)).toMatchObject({ doneAt: null, outcome: null })
    expect(await suppressions()).toEqual([])
    expect(await audit('task.outcome_recorded')).toEqual([])
  })

  it('takes an outcome only on an open call or visit, and the database agrees', async () => {
    const todo = await tasksCreate(db, { orgId, companyId, kind: 'todo', title: 'Send the deck', createdBy: ownerId, actor: ownerId })
    if (!todo.ok) throw new Error(todo.message)
    expect(await record(todo.task.id, 'reached')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await record('00000000-0000-0000-0000-000000000000', 'reached')).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await expectRejection(() => test.pg.query("UPDATE tasks SET outcome = 'reached' WHERE id = $1", [todo.task.id]))).toMatch(/tasks_outcome_is_a_done_call_or_visit/)
    const id = await call()
    expect(await expectRejection(() => test.pg.query("UPDATE tasks SET outcome = 'reached' WHERE id = $1", [id]))).toMatch(/tasks_outcome_is_a_done_call_or_visit/)
    expect(await expectRejection(() => test.pg.query("UPDATE tasks SET outcome = 'ghosted', done_at = now(), done_by = $2 WHERE id = $1", [id, ownerId]))).toMatch(/tasks_outcome_is_known/)
    const visit = await tasksCreate(db, { orgId, companyId, kind: 'visit', title: 'Visit Kumar Dental', createdBy: ownerId, actor: ownerId })
    if (!visit.ok) throw new Error(visit.message)
    expect(await record(visit.task.id, 'not_interested')).toMatchObject({ ok: true })
  })
})
