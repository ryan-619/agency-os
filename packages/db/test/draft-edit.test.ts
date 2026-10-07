/**
 * Editing the words of a message that has not gone yet (2026-10-08).
 *
 * `editDraft` changes a draft's subject and body over the words the editor
 * loaded, sends an approved email back for approval (the approval was of the
 * old words), leaves a queued auto-send message queued, refuses a text (a
 * registered template filled for one person), refuses anything sending, sent,
 * refused or failed, and never moves when the words were first written — the
 * moment the send path judges their evidence from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { DRAFT_BODY_MAX, approveDraft, editDraft, schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('editing a draft’s words', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let otherOrgUser: string
  let companyId: string
  let contactId: string
  let emailCampaign: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
    otherOrgUser = (
      await db.insert(schema.users).values({ orgId: other!.id, email: 'x@other.test', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', timeZone: 'Europe/Amsterdam' }).returning({ id: schema.companies.id })
    )[0]!.id
    contactId = (
      await db
        .insert(schema.contacts)
        .values({ orgId, companyId, firstName: 'Jo', email: 'jo@rentman.io', timeZone: 'Europe/Amsterdam' })
        .returning({ id: schema.contacts.id })
    )[0]!.id
    emailCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Q4', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const draft = async (over: Partial<typeof schema.touches.$inferInsert> = {}) =>
    (
      await db
        .insert(schema.touches)
        .values({
          orgId,
          companyId,
          channel: 'email',
          direction: 'out',
          status: 'awaiting_approval',
          subject: 'Security headers on rentman.io',
          body: 'Hi — your homepage sends no Content-Security-Policy.',
          ...over,
        })
        .returning()
    )[0]!
  const row = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!
  const audits = () => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'draft.edited'))

  it('changes the words of a draft awaiting approval, keeps when they were written, and audits counts only', async () => {
    const t = await draft()
    const r = await editDraft(db, {
      orgId, touchId: t.id, editedBy: userId,
      subject: '  A quick note on   rentman.io ', body: 'Hi Jo,\r\nshorter words.\n',
      expected: { subject: t.subject, body: t.body },
    })
    expect(r).toMatchObject({ ok: true, changed: true, reapprove: false })
    const after = await row(t.id)
    expect(after).toMatchObject({ subject: 'A quick note on rentman.io', body: 'Hi Jo,\nshorter words.', status: 'awaiting_approval' })
    expect(after.createdAt.getTime()).toBe(t.createdAt.getTime())

    const [a] = await audits()
    expect(a?.detail).toEqual({
      channel: 'email', status: 'awaiting_approval', subjectChanged: true,
      bodyChars: { before: [...t.body!].length, after: 'Hi Jo,\nshorter words.'.length }, reapprove: false,
    })
    expect(JSON.stringify(a?.detail)).not.toContain('shorter words')
  })

  it('sends an approved email back for approval, keeping who it was addressed to', async () => {
    const t = await draft()
    expect(await approveDraft(db, { orgId, touchId: t.id, contactId, campaignId: emailCampaign, approvedBy: userId })).toMatchObject({ ok: true })
    const approved = await row(t.id)
    const r = await editDraft(db, {
      orgId, touchId: t.id, editedBy: userId, body: 'New words.', expected: { subject: approved.subject, body: approved.body },
    })
    expect(r).toMatchObject({ ok: true, changed: true, reapprove: true })
    expect(await row(t.id)).toMatchObject({
      status: 'awaiting_approval', approvedBy: null, approvedAt: null, contactId, campaignId: emailCampaign, body: 'New words.',
    })
  })

  it('lands only over the words the editor loaded', async () => {
    const t = await draft()
    const stale = { subject: t.subject, body: t.body }
    await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'First editor.', expected: stale })
    const second = await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'Second editor.', expected: stale })
    expect(second).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
    expect((await row(t.id)).body).toBe('First editor.')
  })

  it('refuses a message that is sending, sent, refused or failed, and a LinkedIn step already approved', async () => {
    for (const status of ['sending', 'sent', 'failed'] as const) {
      const t = await draft({ status, ...(status === 'sent' ? { sentAt: new Date() } : {}) })
      expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'x', expected: { subject: t.subject, body: t.body } }))
        .toMatchObject({ ok: false, reason: 'not_editable' })
    }
    const refused = await draft({ status: 'refused', refusalCode: 'needs_approval' })
    expect(
      await editDraft(db, { orgId, touchId: refused.id, editedBy: userId, body: 'x', expected: { subject: refused.subject, body: refused.body } }),
    ).toMatchObject({ ok: false, reason: 'not_editable', message: expect.stringMatching(/Draft a new message/) })

    const linkedin = await draft({ channel: 'linkedin' })
    const li = await db.insert(schema.campaigns).values({ orgId, name: 'LI', channel: 'linkedin', autoSend: false, dailyCap: 10, status: 'active' }).returning({ id: schema.campaigns.id })
    await db.update(schema.contacts).set({ linkedinUrl: 'https://www.linkedin.com/in/jo-rentman' }).where(eq(schema.contacts.id, contactId))
    expect(await approveDraft(db, { orgId, touchId: linkedin.id, contactId, campaignId: li[0]!.id, approvedBy: userId })).toMatchObject({ ok: true })
    const r = await editDraft(db, { orgId, touchId: linkedin.id, editedBy: userId, body: 'x', expected: { subject: linkedin.subject, body: linkedin.body } })
    expect(r).toMatchObject({ ok: false, reason: 'not_editable', message: expect.stringMatching(/\/tasks/) })
  })

  it('refuses a text: its words are a registered template', async () => {
    const t = await draft({ channel: 'sms', status: 'refused', refusalCode: 'needs_approval' })
    const r = await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'x', expected: { subject: t.subject, body: t.body } })
    expect(r).toMatchObject({ ok: false, reason: 'not_editable', message: expect.stringMatching(/Draft SMS/) })
  })

  it('leaves a queued auto-send message queued', async () => {
    const t = await draft({ status: 'queued', contactId, campaignId: emailCampaign })
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'Tighter.', expected: { subject: t.subject, body: t.body } }))
      .toMatchObject({ ok: true, reapprove: false })
    expect((await row(t.id)).status).toBe('queued')
  })

  it('refuses words that cannot be stored, an email with no subject, and an editor from another org', async () => {
    const t = await draft()
    const expected = { subject: t.subject, body: t.body }
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: '   ', expected })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'x'.repeat(DRAFT_BODY_MAX + 1), expected })).toMatchObject({
      ok: false, reason: 'invalid',
    })
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, subject: '', body: 'ok', expected })).toMatchObject({
      ok: false, reason: 'invalid', message: 'An email needs a subject.',
    })
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: 'a\u0000b', expected })).toMatchObject({ ok: false, reason: 'invalid' })
    // A user of another org is not an editor here: nothing changes.
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: otherOrgUser, body: 'Hijack.', expected })).toMatchObject({ ok: false })
    expect((await row(t.id)).body).toBe(t.body)
    // Nor is the draft another org's to find.
    expect(await editDraft(db, { orgId: 'f'.repeat(8) + '-0000-4000-8000-000000000000', touchId: t.id, editedBy: userId, body: 'x', expected }))
      .toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('writes nothing when nothing changed', async () => {
    const t = await draft()
    expect(await editDraft(db, { orgId, touchId: t.id, editedBy: userId, body: t.body!, expected: { subject: t.subject, body: t.body } }))
      .toMatchObject({ ok: true, changed: false })
    expect(await audits()).toEqual([])
  })
})
