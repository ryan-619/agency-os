/**
 * Reading and rewriting a draft from chat (2026-10-08): `get_draft` shows one
 * email draft whole, and `edit_draft` rewrites it through `editDraft`, the
 * function /approvals' editor calls. Email only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AgencyDb } from '@agency/db'
import { approveDraft } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { editDraftTool, getDraft, type AgencyToolSpec, type ToolContext, type ToolOutcome } from '../src/index.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')

describe('get_draft and edit_draft', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let contactId: string
  let companyId: string
  let campaignId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'priya@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'rentman.io' }).returning({ id: schema.companies.id }))[0]!.id
    contactId = (
      await db.insert(schema.contacts).values({ orgId, companyId, firstName: 'Jo', email: 'jo@rentman.io', timeZone: 'Europe/Amsterdam' })
        .returning({ id: schema.contacts.id })
    )[0]!.id
    campaignId = (
      await db.insert(schema.campaigns).values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx())
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const draft = async (over: Partial<typeof schema.touches.$inferInsert> = {}) =>
    (
      await db
        .insert(schema.touches)
        .values({
          orgId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval',
          subject: 'Security headers on rentman.io', body: 'Hi —\nyour homepage sends no Content-Security-Policy.\nWorth a call?',
          ...over,
        })
        .returning()
    )[0]!
  const row = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!

  it('shows an email draft whole, and changes nothing', async () => {
    const t = await draft()
    const summary = summaryOf(await run(getDraft, { draftId: t.id }))
    expect(summary).toContain('Subject: Security headers on rentman.io')
    expect(summary).toContain('your homepage sends no Content-Security-Policy.\nWorth a call?')
    expect(summary).toMatch(/waiting on \/approvals · no recipient chosen yet/)
    expect(audited).toEqual([{ action: 'agent.get_draft', detail: { draftId: t.id, status: 'awaiting_approval' } }])
  })

  it('refuses a LinkedIn draft — its words are shown only where /tasks would — and a sent email', async () => {
    const li = await draft({ channel: 'linkedin' })
    const r = await run(getDraft, { draftId: li.id })
    expect(r).toMatchObject({ ok: false, code: 'invalid_state', message: expect.stringMatching(/\/tasks/) })
    const sent = await draft({ status: 'sent', sentAt: NOW, contactId, campaignId, recipient: 'jo@rentman.io' })
    expect(await run(editDraftTool, { draftId: sent.id, body: 'x' })).toMatchObject({ ok: false, code: 'invalid_state' })
    expect((await row(sent.id)).body).toBe(sent.body)
  })

  it('rewrites a waiting draft, and says it still waits on /approvals', async () => {
    const t = await draft()
    const summary = summaryOf(await run(editDraftTool, { draftId: t.id, body: 'Hi Jo — a two-line note.', subject: 'A note on rentman.io' }))
    expect(summary).toMatch(/Rewrote email draft .* with a new subject\. It is waiting on \/approvals/)
    expect(summary).toMatch(/Nothing was sent\.$/)
    expect(await row(t.id)).toMatchObject({ subject: 'A note on rentman.io', body: 'Hi Jo — a two-line note.', status: 'awaiting_approval' })
    expect(audited.at(-1)).toEqual({ action: 'agent.edit_draft', detail: { draftId: t.id, edited: true, reapprove: false } })
  })

  it('sends an approved email back to /approvals', async () => {
    const t = await draft()
    expect(await approveDraft(db, { orgId, touchId: t.id, contactId, campaignId, approvedBy: ownerId })).toMatchObject({ ok: true })
    const summary = summaryOf(await run(editDraftTool, { draftId: t.id, body: 'Shorter.' }))
    expect(summary).toMatch(/It had been approved, so it is back on \/approvals/)
    expect(await row(t.id)).toMatchObject({ status: 'awaiting_approval', approvedBy: null, body: 'Shorter.' })
  })

  it('refuses a role that cannot decide drafts', async () => {
    const t = await draft()
    // A role `can()` does not know is refused every capability.
    const viewer = { ...ctx(), principal: { id: ownerId, orgId, role: 'viewer' } } as unknown as ToolContext
    const r = await editDraftTool.handler({ draftId: t.id, body: 'x' }, viewer)
    expect(r).toMatchObject({ ok: false, code: 'not_permitted' })
  })
})
