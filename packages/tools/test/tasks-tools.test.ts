/**
 * The notes and tasks tools, against a real Postgres engine.
 *
 * Both writes are `medium`: they change the CRM and nothing leaves the
 * building, and the summary the model repeats to a person says so. What is
 * asserted is what a careless handler gets wrong: a note filed under nobody,
 * a task handed to somebody in another org, an address or a body in the
 * audit log, and a filter that quietly widens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Principal } from '@agency/core'
import { tasksComplete, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  addNote, createTask, listTasks, type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('the notes and tasks tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let teammateId: string
  let outsiderId: string
  let companyId: string
  let contactId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    // Real users rows: notes.author_user_id and tasks.created_by are same-org
    // composite keys, so the principal must be a person in this org.
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya Shah', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: 'Sam Okafor', role: 'member' },
        { orgId: otherOrgId, email: 'outsider@rival.test', name: 'Outsider', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    userId = users.find((u) => u.email === 'priya@agency.test')!.id
    teammateId = users.find((u) => u.email === 'sam@agency.test')!.id
    outsiderId = users.find((u) => u.email === 'outsider@rival.test')!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'jo@rentman.io', firstName: 'Jo' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date('2026-09-15T12:00:00.000Z'),
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  const stranger = (): Partial<ToolContext> => ({
    principal: { id: userId, orgId, role: 'guest' as unknown as Principal['role'] },
  })

  const notes = () => db.select().from(schema.notes)
  const tasks = () => db.select().from(schema.tasks)

  /** Every audit value is an id, a null, or a flag/count — never somebody's words. */
  const idsOnly = (detail: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === 'string') expect(value, key).toMatch(UUID)
      else expect(value === null || typeof value === 'number' || typeof value === 'boolean', key).toBe(true)
    }
  }

  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  // -------------------------------------------------------------------------
  describe('add_note', () => {
    it('lands on the company with the person you are helping as its author', async () => {
      const out = await run(addNote, { domain: 'www.rentman.io', body: '  Jo said budget opens in Q1.  ', contactEmail: 'JO@rentman.io' })
      const summary = summaryOf(out)
      const rows = await notes()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ orgId, companyId, contactId, authorUserId: userId, body: 'Jo said budget opens in Q1.' })
      expect(summary).toContain('not evidence')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
    })

    /**
     * Any teammate may approve the card, so the person the note is filed
     * under may never have seen it. `author_user_id` must name a person and
     * `notes` has no column to mark the note, so the audit row is where the
     * agent is named: before, `note.added` named the chat's owner as actor
     * and nothing but the separate `agent.add_note` row said otherwise.
     */
    it('records the agent as the note’s writer in the audit log, beside who it is filed under', async () => {
      const summary = summaryOf(await run(addNote, { domain: 'rentman.io', body: 'They have no CSP.' }))
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'note.added'))
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'note' })
      expect(log[0]!.detail).toEqual({ companyId, noteId: log[0]!.subjectId, authorUserId: userId })
      expect(JSON.stringify(log)).not.toContain('CSP')
      expect(summary).toContain('shows as theirs')
      expect(summary).toContain('the agent wrote it')
    })

    it('audits ids only — never the body', async () => {
      await run(addNote, { domain: 'rentman.io', body: 'PRIVATE WORDS about the call' })
      expect(audited.map((a) => a.action)).toEqual(['agent.add_note'])
      const detail = audited[0]!.detail
      expect(JSON.stringify(detail)).not.toContain('PRIVATE')
      expect(detail).toMatchObject({ companyId, contactId: null })
      idsOnly(detail)
    })

    it('refuses a blank body with the sentence the CHECK stands behind, and writes nothing', async () => {
      const out = await run(addNote, { domain: 'rentman.io', body: '   \n  ' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      if (out.ok) return
      expect(out.message).toContain('A note needs some words in it.')
      expect(await notes()).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a contact who is not at that company, and writes nothing', async () => {
      const [elsewhere] = await db.insert(schema.companies).values({ orgId, domain: 'other.example' }).returning({ id: schema.companies.id })
      await db.insert(schema.contacts).values({ orgId, companyId: elsewhere!.id, email: 'lee@other.example' })
      expect(await run(addNote, { domain: 'rentman.io', body: 'hello', contactEmail: 'lee@other.example' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await notes()).toEqual([])
    })

    it('does not find another org’s company', async () => {
      await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'theirs.example' })
      expect(await run(addNote, { domain: 'theirs.example', body: 'hello' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await notes()).toEqual([])
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(addNote, { domain: 'rentman.io', body: 'hello' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await notes()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('create_task', () => {
    it('creates a task for a teammate in this org, created by the agent rather than by a person', async () => {
      const out = await run(createTask, {
        domain: 'rentman.io', title: 'Send the scope', detail: 'They want it by Friday.',
        dueAt: '2026-09-18T09:00:00Z', assigneeEmail: 'Sam@Agency.test',
      })
      const summary = summaryOf(out)
      const rows = await tasks()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        orgId, kind: 'todo', title: 'Send the scope', detail: 'They want it by Friday.', companyId,
        assigneeUserId: teammateId, createdBy: null, dueAt: new Date('2026-09-18T09:00:00Z'), doneAt: null,
      })
      // 0018: "the agent creates tasks and has no users row, so created_by is
      // nullable and the audit row names the actor". It used to be the chat's owner.
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.created'))
      expect(log.map((l) => l.actor)).toEqual(['agent'])
      expect(summary).toContain('assigned to Sam Okafor')
      expect(summary).toContain('no email, message or calendar event')
      expect(summary.endsWith('Nothing was sent.')).toBe(true)
    })

    it('audits ids only — never the title or the detail', async () => {
      await run(createTask, { title: 'PRIVATE TITLE', detail: 'PRIVATE DETAIL', assigneeEmail: 'sam@agency.test' })
      expect(audited.map((a) => a.action)).toEqual(['agent.create_task'])
      const detail = audited[0]!.detail
      expect(JSON.stringify(detail)).not.toContain('PRIVATE')
      expect(detail).toMatchObject({ companyId: null, assigneeUserId: teammateId })
      idsOnly(detail)
      // The db writer's own row, too.
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'task.created'))
      expect(JSON.stringify(log)).not.toContain('PRIVATE')
    })

    it('answers an assignee from another org exactly like nobody, and writes nothing', async () => {
      const out = await run(createTask, { title: 'Follow up', assigneeEmail: 'outsider@rival.test' })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      if (out.ok) return
      expect(out.message).toContain('is on this team')
      expect(out.message).not.toContain(outsiderId)
      expect(await tasks()).toEqual([])
      expect(audited).toEqual([])
    })

    it('will not assign a task to a revoked teammate', async () => {
      await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, teammateId))
      expect(await run(createTask, { title: 'Follow up', assigneeEmail: 'sam@agency.test' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await tasks()).toEqual([])
    })

    it('refuses a blank title and an unknown company, and writes nothing', async () => {
      expect(await run(createTask, { title: '   ' })).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(await run(createTask, { title: 'Call them', domain: 'nowhere.example' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await tasks()).toEqual([])
    })

    it('leaves a task unassigned and about no company when asked for neither', async () => {
      const summary = summaryOf(await run(createTask, { title: 'Tidy the pipeline', domain: '' }))
      expect((await tasks())[0]).toMatchObject({ companyId: null, assigneeUserId: null, createdBy: null })
      expect(summary).toContain('unassigned')
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(createTask, { title: 'Follow up' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await tasks()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('list_tasks', () => {
    type Listed = { title: string; domain: string | null; overdue: boolean; doneAt: string | null }
    const listed = (out: ToolOutcome<unknown>): Listed[] => {
      if (!out.ok) throw new Error(out.message)
      return out.data as Listed[]
    }

    beforeEach(async () => {
      const [elsewhere] = await db.insert(schema.companies).values({ orgId, domain: 'other.example' }).returning({ id: schema.companies.id })
      await db.insert(schema.tasks).values([
        { orgId, kind: 'todo', title: 'Overdue for Sam', companyId, assigneeUserId: teammateId, createdBy: userId, dueAt: new Date('2026-09-10T00:00:00Z') },
        { orgId, kind: 'todo', title: 'Later for Priya', companyId: elsewhere!.id, assigneeUserId: userId, createdBy: userId, dueAt: new Date('2026-10-01T00:00:00Z') },
        { orgId, kind: 'todo', title: 'Nobody’s, undated', createdBy: userId },
      ])
      const [done] = await db
        .insert(schema.tasks)
        .values({ orgId, kind: 'todo', title: 'Already done', companyId, assigneeUserId: teammateId, createdBy: userId })
        .returning({ id: schema.tasks.id })
      await tasksComplete(db, { orgId, id: done!.id, byUserId: teammateId, actor: teammateId })
      const [theirCompany] = await db.insert(schema.companies).values({ orgId: otherOrgId, domain: 'rentman.io' }).returning({ id: schema.companies.id })
      await db.insert(schema.tasks).values({ orgId: otherOrgId, kind: 'todo', title: 'RIVAL TASK', companyId: theirCompany!.id, createdBy: outsiderId })
    })

    it('lists open tasks by default, soonest due first, and marks what is overdue', async () => {
      const out = await run(listTasks, {})
      expect(listed(out).map((t) => t.title)).toEqual(['Overdue for Sam', 'Later for Priya', 'Nobody’s, undated'])
      expect(listed(out)[0]!.overdue).toBe(true)
      if (!out.ok) return
      expect(out.summary).toMatch(/^3 open tasks, soonest due first:/)
      expect(out.summary).toContain('[OVERDUE]')
      expect(JSON.stringify(out)).not.toContain('RIVAL')
      expect(audited[0]).toMatchObject({ action: 'agent.list_tasks', detail: { open: true, returned: 3 } })
      idsOnly(audited[0]!.detail)
    })

    /**
     * Only the summary reaches the model, and complete_task names a task by
     * its id — so every listed task carries its id in the summary itself.
     */
    it('prints each task’s id in the summary, so complete_task can name it', async () => {
      const out = await run(listTasks, {})
      if (!out.ok) throw new Error(out.message)
      const ids = (await db.select({ id: schema.tasks.id, title: schema.tasks.title }).from(schema.tasks))
        .filter((t) => ['Overdue for Sam', 'Later for Priya', 'Nobody’s, undated'].includes(t.title))
      expect(ids).toHaveLength(3)
      for (const t of ids) expect(out.summary, t.title).toContain(`task ${t.id}`)
    })

    it('includes done ones when open is false', async () => {
      const titles = listed(await run(listTasks, { open: false })).map((t) => t.title)
      expect(titles).toHaveLength(4)
      expect(titles).toContain('Already done')
    })

    it('filters by assignee', async () => {
      expect(listed(await run(listTasks, { assigneeEmail: 'sam@agency.test' })).map((t) => t.title)).toEqual(['Overdue for Sam'])
      expect(listed(await run(listTasks, { assigneeEmail: 'sam@agency.test', open: false })).map((t) => t.title).sort())
        .toEqual(['Already done', 'Overdue for Sam'])
    })

    it('filters by company, and never reaches another org’s company of the same domain', async () => {
      const titles = listed(await run(listTasks, { domain: 'rentman.io', open: false })).map((t) => t.title).sort()
      expect(titles).toEqual(['Already done', 'Overdue for Sam'])
    })

    it('answers an address that is not on this team as not_found', async () => {
      expect(await run(listTasks, { assigneeEmail: 'outsider@rival.test' })).toMatchObject({ ok: false, code: 'not_found' })
    })

    it('respects the limit', async () => {
      expect(listed(await run(listTasks, { limit: 1 })).map((t) => t.title)).toEqual(['Overdue for Sam'])
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(listTasks, {}, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
    })
  })

  // -------------------------------------------------------------------------
  it('ends every write summary with "Nothing was sent."', async () => {
    const writes = [
      await run(addNote, { domain: 'rentman.io', body: 'A note.' }),
      await run(createTask, { title: 'A task.', domain: 'rentman.io' }),
    ]
    for (const out of writes) expect(summaryOf(out).endsWith('Nothing was sent.')).toBe(true)
    // A member may write both, as the routes allow.
    const member = { principal: { id: teammateId, orgId, role: 'member' as const } }
    expect(summaryOf(await run(addNote, { domain: 'rentman.io', body: 'Another.' }, member)).endsWith('Nothing was sent.')).toBe(true)
    expect(summaryOf(await run(createTask, { title: 'Another.' }, member)).endsWith('Nothing was sent.')).toBe(true)
  })
})
