/**
 * Tasks, against a real engine (0018).
 *
 * The rules worth a test are the ones a race or a wrong id would break: one
 * open task per touch (the unique index arbitrates, the loser is told so),
 * completion that happens once however many people press Done, assignment
 * that cannot reach outside the org, counts that do not include finished
 * work — and templates that only ever come from a click on a won deal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, like } from 'drizzle-orm'
import { KICKOFF_TEMPLATE, RENEWAL_TEMPLATE } from '@agency/core'
import {
  schema, setDealStage, tasksApplyTemplate, tasksAssign, tasksAssignableUsers, tasksComplete, tasksCounts, tasksCreate,
  tasksIsOverdue, tasksList, tasksOpenForTouch, tasksReopen, tasksSetDue, tasksTemplateReadiness, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const HOUR = 3_600_000
const NOW = new Date('2026-09-15T12:00:00.000Z')

describe('tasks', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let companyId: string
  let siblingCompanyId: string
  let otherCompanyId: string
  let me: string
  let teammate: string
  let revoked: string
  let outsider: string
  let touchId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org, other] = await db.insert(schema.orgs).values([{ name: 'Agency' }, { name: 'Elsewhere' }]).returning()
    orgId = org!.id
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya', role: 'owner' },
        { orgId, email: 'olu@agency.test', name: 'Olu', role: 'member' },
        { orgId, email: 'gone@agency.test', name: 'Gone', role: 'member', revokedAt: new Date('2026-09-01T00:00:00Z') },
        { orgId: otherOrgId, email: 'eve@elsewhere.test', name: 'Eve', role: 'owner' },
      ])
      .returning({ id: schema.users.id })
    ;[me, teammate, revoked, outsider] = users.map((u) => u.id) as [string, string, string, string]
    const companies = await db
      .insert(schema.companies)
      .values([
        { orgId, domain: 'rentman.io', name: 'Rentman' },
        { orgId, domain: 'sibling.io', name: 'Sibling' },
        { orgId: otherOrgId, domain: 'theirs.io', name: 'Theirs' },
      ])
      .returning({ id: schema.companies.id })
    ;[companyId, siblingCompanyId, otherCompanyId] = companies.map((c) => c.id) as [string, string, string]
    const [touch] = await db
      .insert(schema.touches)
      .values({ orgId, companyId, channel: 'linkedin', direction: 'out', status: 'awaiting_approval', subject: 's', body: 'b' })
      .returning({ id: schema.touches.id })
    touchId = touch!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const create = (over: Partial<Parameters<typeof tasksCreate>[1]> = {}) =>
    tasksCreate(db, { orgId, kind: 'todo', title: 'Call Ana back', createdBy: me, actor: me, ...over })

  const created = async (over: Partial<Parameters<typeof tasksCreate>[1]> = {}) => {
    const r = await create(over)
    if (!r.ok) throw new Error(`${r.reason}: ${r.message}`)
    return r.task
  }

  const taskCount = async (): Promise<number> => (await db.select().from(schema.tasks)).length

  describe('tasksCreate', () => {
    it('creates a task and audits it by id', async () => {
      const task = await created({ title: '  Send the NDA  ', companyId, assigneeUserId: teammate, dueAt: NOW })
      expect(task).toMatchObject({ title: 'Send the NDA', kind: 'todo', companyId, assigneeUserId: teammate, createdBy: me })
      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.created'))
      expect(row!.detail).toEqual({ taskId: task.id, kind: 'todo', companyId })
      expect(JSON.stringify(row)).not.toContain('NDA')
    })

    it('refuses a blank title and writes nothing', async () => {
      expect(await create({ title: '   ' })).toEqual({ ok: false, reason: 'blank_title', message: 'A task needs a title.' })
      expect(await taskCount()).toBe(0)
    })

    it('refuses a title past the column bound', async () => {
      expect(await create({ title: 'x'.repeat(201) })).toMatchObject({ ok: false, reason: 'title_too_long' })
      expect((await create({ title: 'x'.repeat(200) })).ok).toBe(true)
    })

    it('files a task on a deal or a touch under that company, and refuses a disagreement', async () => {
      const [deal] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' }).returning()
      expect((await created({ dealId: deal!.id })).companyId).toBe(companyId)
      expect(await create({ dealId: deal!.id, companyId: siblingCompanyId })).toMatchObject({ ok: false, reason: 'invalid' })
      expect((await created({ kind: 'linkedin_send', touchId })).companyId).toBe(companyId)
    })

    it('refuses a LinkedIn step that names no message', async () => {
      expect(await create({ kind: 'linkedin_send' })).toMatchObject({ ok: false, reason: 'invalid' })
    })

    it('answers duplicate_open_for_touch for a second open task on one touch', async () => {
      const first = await created({ kind: 'linkedin_send', title: 'Send on LinkedIn', touchId })
      const second = await create({ kind: 'linkedin_send', title: 'Send on LinkedIn', touchId })
      expect(second).toEqual({ ok: false, reason: 'duplicate_open_for_touch', message: expect.any(String) })
      expect((await tasksOpenForTouch(db, orgId, touchId))!.id).toBe(first.id)
      expect(await taskCount()).toBe(1)
    })

    it('accepts a new open task for a touch once the previous one is done', async () => {
      const first = await created({ kind: 'linkedin_send', title: 'Send on LinkedIn', touchId })
      await tasksComplete(db, { orgId, id: first.id, byUserId: me, actor: me })
      const second = await created({ kind: 'linkedin_send', title: 'Send on LinkedIn', touchId })
      expect(second.id).not.toBe(first.id)
      expect((await tasksOpenForTouch(db, orgId, touchId))!.id).toBe(second.id)
      // …and the done one cannot be reopened beside it.
      expect(await tasksReopen(db, { orgId, id: first.id, actor: me })).toMatchObject({
        ok: false, reason: 'duplicate_open_for_touch',
      })
    })

    it('refuses an assignee from another org, or one who has been revoked', async () => {
      expect(await create({ assigneeUserId: outsider })).toEqual({
        ok: false, reason: 'assignee_not_in_org', message: 'That person is not on this team.',
      })
      expect(await create({ assigneeUserId: revoked })).toMatchObject({ ok: false, reason: 'assignee_not_in_org' })
      expect(await taskCount()).toBe(0)
    })

    it("refuses another org's company, deal and touch", async () => {
      const [theirDeal] = await db.insert(schema.deals).values({ orgId: otherOrgId, companyId: otherCompanyId }).returning()
      const [theirTouch] = await db
        .insert(schema.touches)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, channel: 'email', direction: 'out' })
        .returning()
      expect(await create({ companyId: otherCompanyId })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await create({ dealId: theirDeal!.id })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await create({ touchId: theirTouch!.id })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await taskCount()).toBe(0)
    })

    it('lets the agent create a task with no creator row', async () => {
      const task = await created({ createdBy: null, actor: 'agent' })
      expect(task.createdBy).toBeNull()
      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.created'))
      expect(row!.actor).toBe('agent')
    })
  })

  describe('tasksComplete and tasksReopen', () => {
    it('completes once; a second press is told alreadyDone and shown the first', async () => {
      const task = await created()
      const first = await tasksComplete(db, { orgId, id: task.id, byUserId: me, actor: me, now: NOW })
      expect(first).toMatchObject({ ok: true, alreadyDone: false })
      if (!first.ok) return
      expect(first.task.doneAt!.toISOString()).toBe(NOW.toISOString())
      expect(first.task.doneBy).toBe(me)

      const second = await tasksComplete(db, { orgId, id: task.id, byUserId: teammate, actor: teammate })
      expect(second).toMatchObject({ ok: true, alreadyDone: true })
      if (!second.ok) return
      expect(second.task.doneBy).toBe(me)
      expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.completed'))).toHaveLength(1)
    })

    it('reopens a done task, clearing who did it', async () => {
      const task = await created()
      await tasksComplete(db, { orgId, id: task.id, byUserId: me, actor: me })
      const r = await tasksReopen(db, { orgId, id: task.id, actor: me })
      expect(r).toMatchObject({ ok: true, alreadyOpen: false, task: { doneAt: null, doneBy: null } })
      expect(await tasksReopen(db, { orgId, id: task.id, actor: me })).toMatchObject({ ok: true, alreadyOpen: true })
    })

    it("cannot complete another org's task, or be completed by another org's user", async () => {
      const theirs = await tasksCreate(db, { orgId: otherOrgId, kind: 'todo', title: 'theirs', createdBy: outsider, actor: outsider })
      if (!theirs.ok) throw new Error(theirs.message)
      expect(await tasksComplete(db, { orgId, id: theirs.task.id, byUserId: me, actor: me })).toMatchObject({ ok: false, reason: 'not_found' })
      const mine = await created()
      expect(await tasksComplete(db, { orgId, id: mine.id, byUserId: outsider, actor: outsider })).toMatchObject({
        ok: false, reason: 'not_found',
      })
      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, mine.id))
      expect(row!.doneAt).toBeNull()
    })
  })

  describe('tasksAssign and tasksSetDue', () => {
    it('assigns within the org, unassigns with null, and refuses a user from another org', async () => {
      const task = await created()
      expect(await tasksAssign(db, { orgId, id: task.id, assigneeUserId: teammate, actor: me })).toMatchObject({
        ok: true, task: { assigneeUserId: teammate },
      })
      expect(await tasksAssign(db, { orgId, id: task.id, assigneeUserId: outsider, actor: me })).toEqual({
        ok: false, reason: 'assignee_not_in_org', message: 'That person is not on this team.',
      })
      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
      expect(row!.assigneeUserId).toBe(teammate)
      expect(await tasksAssign(db, { orgId, id: task.id, assigneeUserId: null, actor: me })).toMatchObject({
        ok: true, task: { assigneeUserId: null },
      })
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.assigned'))
      expect(audits.map((a) => a.detail)).toEqual([
        { taskId: task.id, assigneeUserId: teammate },
        { taskId: task.id, assigneeUserId: null },
      ])
    })

    it('sets and clears a due date', async () => {
      const task = await created()
      expect(await tasksSetDue(db, { orgId, id: task.id, dueAt: NOW, actor: me })).toMatchObject({ ok: true })
      expect(await tasksSetDue(db, { orgId, id: task.id, dueAt: new Date('nope'), actor: me })).toMatchObject({
        ok: false, reason: 'invalid',
      })
      expect(await tasksSetDue(db, { orgId, id: task.id, dueAt: null, actor: me })).toMatchObject({ ok: true, task: { dueAt: null } })
    })
  })

  describe('tasksList', () => {
    it('filters by open, assignee (null is unassigned), company, kind and due date, in org only', async () => {
      const a = await created({ title: 'a', assigneeUserId: me, companyId, dueAt: new Date(NOW.getTime() - HOUR) })
      const b = await created({ title: 'b', assigneeUserId: teammate, dueAt: new Date(NOW.getTime() + HOUR) })
      const c = await created({ title: 'c' })
      const d = await created({ title: 'd', assigneeUserId: me })
      await tasksComplete(db, { orgId, id: d.id, byUserId: me, actor: me })
      await tasksCreate(db, { orgId: otherOrgId, kind: 'todo', title: 'theirs', createdBy: outsider, actor: outsider })

      const titles = (rows: { title: string }[]) => rows.map((r) => r.title)
      expect(titles(await tasksList(db, orgId))).toEqual(['a', 'b', 'c', 'd'])
      expect(titles(await tasksList(db, orgId, { open: true }))).toEqual(['a', 'b', 'c'])
      expect(titles(await tasksList(db, orgId, { open: false }))).toEqual(['d'])
      expect(titles(await tasksList(db, orgId, { open: true, assigneeUserId: me }))).toEqual(['a'])
      expect(titles(await tasksList(db, orgId, { assigneeUserId: null }))).toEqual(['c'])
      expect(titles(await tasksList(db, orgId, { companyId }))).toEqual(['a'])
      expect(titles(await tasksList(db, orgId, { dueBefore: NOW }))).toEqual(['a'])
      expect(titles(await tasksList(db, orgId, { kind: 'kickoff' }))).toEqual([])
      expect(titles(await tasksList(db, orgId, { limit: 2 }))).toEqual(['a', 'b'])

      const [first] = await tasksList(db, orgId, { companyId })
      expect(first).toMatchObject({ companyDomain: 'rentman.io', assigneeName: 'Priya', assigneeEmail: 'priya@agency.test' })
      expect(tasksIsOverdue(a, NOW)).toBe(true)
      expect(tasksIsOverdue(b, NOW)).toBe(false)
      expect(tasksIsOverdue(c, NOW)).toBe(false)
    })
  })

  describe('tasksCounts', () => {
    it('counts open, overdue and due in the next day — and never a done task', async () => {
      await created({ title: 'overdue', dueAt: new Date(NOW.getTime() - HOUR) })
      const doneLate = await created({ title: 'overdue but done', dueAt: new Date(NOW.getTime() - 2 * HOUR) })
      await tasksComplete(db, { orgId, id: doneLate.id, byUserId: me, actor: me })
      await created({ title: 'due in an hour', dueAt: new Date(NOW.getTime() + HOUR) })
      await created({ title: 'due in two days', dueAt: new Date(NOW.getTime() + 48 * HOUR) })
      await created({ title: 'no date' })
      await tasksCreate(db, {
        orgId: otherOrgId, kind: 'todo', title: 'theirs, overdue', dueAt: new Date(NOW.getTime() - HOUR), createdBy: outsider, actor: outsider,
      })

      expect(await tasksCounts(db, orgId, NOW)).toEqual({ open: 4, overdue: 1, dueToday: 1 })
      expect(await tasksCounts(db, otherOrgId, NOW)).toEqual({ open: 1, overdue: 1, dueToday: 0 })
    })
  })

  describe('tasksApplyTemplate', () => {
    const won = async (target = companyId, org = orgId) =>
      (await db.insert(schema.deals).values({ orgId: org, companyId: target, stage: 'won', closedAt: NOW }).returning())[0]!

    it('refuses a company with no won deal, and writes nothing', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' })
      const r = await tasksApplyTemplate(db, { orgId, template: 'kickoff', companyId, createdBy: me, actor: me, now: NOW })
      expect(r).toMatchObject({ ok: false, reason: 'deal_not_won' })
      expect(await taskCount()).toBe(0)
      expect((await tasksTemplateReadiness(db, orgId, companyId)).wonDealId).toBeNull()
    })

    it('creates the five kickoff tasks on the won deal, dated from the click, and audits ids and a count', async () => {
      const deal = await won()
      const r = await tasksApplyTemplate(db, {
        orgId, template: 'kickoff', companyId, assigneeUserId: teammate, createdBy: me, actor: me, now: NOW,
      })
      if (!r.ok) throw new Error(r.message)
      expect(r.tasks.map((t) => t.title)).toEqual(KICKOFF_TEMPLATE.map((t) => t.title))
      expect(r.tasks.every((t) => t.kind === 'kickoff' && t.dealId === deal.id && t.companyId === companyId)).toBe(true)
      expect(r.tasks.every((t) => t.assigneeUserId === teammate && t.createdBy === me)).toBe(true)
      expect(r.tasks[0]!.dueAt!.getTime() - NOW.getTime()).toBe(KICKOFF_TEMPLATE[0]!.dueAfterDays * 24 * HOUR)

      const [applied] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.template_applied'))
      expect(applied!.detail).toEqual({ template: 'kickoff', companyId, dealId: deal.id, count: 5 })
      expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.created'))).toHaveLength(5)
      expect(await tasksTemplateReadiness(db, orgId, companyId)).toEqual({ wonDealId: deal.id, openKickoff: 5, openRenewal: 0 })
    })

    it('does not apply a set twice while its tasks are open', async () => {
      await won()
      const first = await tasksApplyTemplate(db, { orgId, template: 'renewal', companyId, createdBy: me, actor: me, now: NOW })
      expect(first.ok).toBe(true)
      const again = await tasksApplyTemplate(db, { orgId, template: 'renewal', companyId, createdBy: me, actor: me, now: NOW })
      expect(again).toMatchObject({ ok: false, reason: 'already_applied', message: expect.stringMatching(/2 open renewal tasks/) })
      expect(await taskCount()).toBe(RENEWAL_TEMPLATE.length)
    })

    it('refuses a named deal that is not won or not this company’s, and another org’s company', async () => {
      const [open] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' }).returning()
      const siblingWon = await won(siblingCompanyId)
      expect(await tasksApplyTemplate(db, { orgId, template: 'kickoff', companyId, dealId: open!.id, createdBy: me, actor: me }))
        .toMatchObject({ ok: false, reason: 'deal_not_won' })
      expect(await tasksApplyTemplate(db, { orgId, template: 'kickoff', companyId, dealId: siblingWon.id, createdBy: me, actor: me }))
        .toMatchObject({ ok: false, reason: 'not_found' })
      await won(otherCompanyId, otherOrgId)
      expect(await tasksApplyTemplate(db, { orgId, template: 'kickoff', companyId: otherCompanyId, createdBy: me, actor: me }))
        .toMatchObject({ ok: false, reason: 'not_found' })
      expect(await tasksApplyTemplate(db, {
        orgId, template: 'kickoff', companyId: siblingCompanyId, assigneeUserId: outsider, createdBy: me, actor: me,
      })).toMatchObject({ ok: false, reason: 'assignee_not_in_org' })
      expect(await taskCount()).toBe(0)
    })

    it('is the only thing that creates template tasks — a deal moved to won creates none', async () => {
      const [deal] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'proposal' }).returning()
      const moved = await setDealStage(db, { orgId, dealId: deal!.id, stage: 'won', lostReason: null })
      expect(moved!.stage).toBe('won')
      expect(await taskCount()).toBe(0)
      expect(await db.select().from(schema.auditLog).where(like(schema.auditLog.action, 'task.%'))).toHaveLength(0)
    })
  })

  it('offers only this org’s unrevoked people as assignees', async () => {
    expect((await tasksAssignableUsers(db, orgId)).map((u) => u.email)).toEqual(['olu@agency.test', 'priya@agency.test'])
  })
})
