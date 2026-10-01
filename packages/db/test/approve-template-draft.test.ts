/**
 * An SMS or WhatsApp draft can be approved only to the person it was rendered
 * for (0019).
 *
 * A template-channel body is the registered template with each slot filled
 * FOR ONE CONTACT — "Hi Priya, your call with Acme is at 3pm" — and the row
 * carries that contact. `approveDraft` takes the recipient from the approver,
 * because an email draft from chat is written to nobody and the approver
 * chooses. On a template channel the choice was already made: approving
 * Priya's text to her colleague sends him a message that greets her by name.
 * Only /approvals' candidate list stood in the way, and a direct call to the
 * route does not go through that list. Refused `rendered_for_another`, and
 * nothing is written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { approveDraft, schema, smsDraft, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
const BODY = 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.'

describe('approving a template-channel draft', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let priya: string
  let ravi: string
  let smsCampaign: string
  let templateId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.in', timeZone: 'Asia/Kolkata' }).returning({ id: schema.companies.id })
    )[0]!.id
    const person = async (firstName: string, phone: string) => {
      const [c] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, firstName, phone, timeZone: 'Asia/Kolkata' })
        .returning({ id: schema.contacts.id })
      await db.insert(schema.consents).values({ orgId, contactId: c!.id, channel: 'sms', granted: true, source: 'booking form' })
      return c!.id
    }
    // Two people at the SAME company, so `wrong_company` cannot be what stops it.
    priya = await person('Priya', '+919876543210')
    ravi = await person('Ravi', '+919812345678')
    smsCampaign = (
      await db
        .insert(schema.campaigns)
        .values({ orgId, name: 'Meeting reminders', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
        .returning({ id: schema.campaigns.id })
    )[0]!.id
    templateId = (
      await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', body: BODY })
        .returning({ id: schema.messageTemplates.id })
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const draftFor = async (contactId: string) => {
    const r = await smsDraft(db, { orgId, contactId, campaignId: smsCampaign, templateId, vars: ['Priya', '3pm'], createdBy: userId, now: NOON_IST })
    if (!r.ok) throw new Error(r.message)
    return r.touchId
  }
  const row = async (id: string) => (await db.select().from(schema.touches).where(eq(schema.touches.id, id)))[0]!

  it('refuses an SMS draft approved to somebody other than the person it was rendered for, and writes nothing', async () => {
    const touchId = await draftFor(priya)
    const r = await approveDraft(db, { orgId, touchId, contactId: ravi, campaignId: smsCampaign, approvedBy: userId, now: NOON_IST })
    expect(r).toEqual({ ok: false, reason: 'rendered_for_another' })
    expect(await row(touchId)).toMatchObject({ status: 'awaiting_approval', contactId: priya, approvedBy: null, approvedAt: null })
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).not.toContain('draft.approved')
  })

  it('approves it to the person it was rendered for', async () => {
    const touchId = await draftFor(priya)
    const r = await approveDraft(db, { orgId, touchId, contactId: priya, campaignId: smsCampaign, approvedBy: userId, now: NOON_IST })
    expect(r.ok).toBe(true)
    expect(await row(touchId)).toMatchObject({ status: 'approved', contactId: priya, approvedBy: userId })
  })

  /**
   * A template-channel row whose contact is gone (`contact_id` set NULL by a
   * delete) still carries words rendered for that person; there is nobody it
   * may now go to.
   */
  it('refuses a WhatsApp draft whose contact is gone, to anybody', async () => {
    const [wa] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'WhatsApp', channel: 'whatsapp', autoSend: false, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const [waTemplate] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'whatsapp', externalId: 'meeting_reminder', senderId: '+919800000000', category: 'utility', body: 'Hi {{1}}' })
      .returning({ id: schema.messageTemplates.id })
    const [t] = await db
      .insert(schema.touches)
      .values({
        orgId, companyId, contactId: null, campaignId: wa!.id, templateId: waTemplate!.id,
        channel: 'whatsapp', direction: 'out', status: 'awaiting_approval', body: 'Hi Priya',
      })
      .returning({ id: schema.touches.id })
    expect(await approveDraft(db, { orgId, touchId: t!.id, contactId: ravi, campaignId: wa!.id, approvedBy: userId, now: NOON_IST }))
      .toEqual({ ok: false, reason: 'rendered_for_another' })
  })

  /** Email is still the approver's choice: a draft from chat is written about a company, to nobody. */
  it('leaves an email draft’s recipient to the approver, as before', async () => {
    const [email] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Opener', channel: 'email', status: 'active' })
      .returning({ id: schema.campaigns.id })
    const [t] = await db
      .insert(schema.touches)
      .values({ orgId, companyId, contactId: priya, channel: 'email', direction: 'out', status: 'awaiting_approval', subject: 'Hi', body: 'words' })
      .returning({ id: schema.touches.id })
    const r = await approveDraft(db, { orgId, touchId: t!.id, contactId: ravi, campaignId: email!.id, approvedBy: userId, now: NOON_IST })
    expect(r.ok).toBe(true)
    expect(await row(t!.id)).toMatchObject({ status: 'approved', contactId: ravi })
  })
})
