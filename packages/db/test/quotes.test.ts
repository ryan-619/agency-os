/**
 * Quotes, the agency's profile and the links a business opens (0023),
 * against a real migrated database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { noSiteDomain, parseIcpDefinition, type QuoteItem } from '@agency/core'
import seed from '../seed/icp-security-gap-saas.json' with { type: 'json' }
import {
  ORG_PROFILE_DEFAULTS, orgProfileRead, orgProfileSave, quoteCreate, quoteDecide, quoteDraftEmail, quoteItemsOf, quoteNeedsOf, quoteRead,
  quoteSend, quoteUpdate, quotesList, schema, serviceCreate, shareLinkCountView, shareLinkDraftEmail, shareLinkMint,
  shareLinkPreviewOpening, shareLinkResolve, shareLinkRevoke, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-08T07:00:00.000Z')

/** The constraint a refused statement broke: drizzle wraps the engine's error, which carries it. */
async function refusedBy(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    const cause = (e as { cause?: { constraint?: string; message?: string } }).cause
    return `${e instanceof Error ? e.message : String(e)} ${cause?.constraint ?? ''} ${cause?.message ?? ''}`
  }
  throw new Error('expected the database to reject this statement, but it succeeded')
}
const GSTIN = '29ABCDE1234F1Z5'

describe('quotes, profiles and share links', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: seed.label, definition: seed, active: true })
    void parseIcpDefinition(seed)
    const [company] = await db
      .insert(schema.companies)
      .values({
        orgId, domain: 'kumar-dental-ab12.nosite.invalid', name: 'Kumar Dental', source: 'google_maps',
        googlePlaceId: 'ChIJkumar', googleCategory: 'dentist', googleRating: '4.1', googleReviewCount: 12,
        listingWebsite: null, listingCheckedAt: new Date('2026-10-07T00:00:00Z'), phone: '+918041234567', city: 'Bengaluru',
      })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    contactId = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'dr.kumar@gmail.com', firstName: 'Ravi' }).returning({ id: schema.contacts.id }))[0]!.id
    await serviceCreate(db, { orgId, input: { name: 'New website', needs: ['no_website'], priceFrom: 15_000, priceTo: 40_000 }, actor: userId, createdBy: userId })
    await serviceCreate(db, { orgId, input: { name: 'Google profile care', needs: ['few_reviews'], priceFrom: 3_000, priceUnit: 'monthly' }, actor: userId, createdBy: userId })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const audits = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  describe('the agency’s profile', () => {
    it('reads as the defaults until it is saved, and saves what is given, audited by field name', async () => {
      expect(await orgProfileRead(db, orgId)).toEqual(ORG_PROFILE_DEFAULTS)
      const saved = await orgProfileSave(db, {
        orgId, actor: userId, updatedBy: userId,
        input: { legalName: 'Accemy Digital LLP', gstin: GSTIN.toLowerCase(), gstRate: 18, upiVpa: 'accemy@okhdfcbank', phone: '080 4123 4567', website: '' },
      })
      expect(saved.ok).toBe(false) // a phone with no country code
      const ok = await orgProfileSave(db, {
        orgId, actor: userId, updatedBy: userId,
        input: { legalName: 'Accemy Digital LLP', gstin: GSTIN.toLowerCase(), gstRate: 18, upiVpa: 'accemy@okhdfcbank', phone: '+91 80 4123 4567' },
      })
      expect(ok).toMatchObject({ ok: true, profile: { gstin: GSTIN, gstRate: 18, phone: '+918041234567' } })
      const [row] = await audits('org.profile_updated')
      expect((row!.detail as { fields: string[] }).fields.sort()).toEqual(['gstRate', 'gstin', 'legalName', 'phone', 'upiVpa'])
    })

    it('refuses GST without a GSTIN, a bad GSTIN and a bad UPI ID, with sentences', async () => {
      expect(await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { gstRate: 18 } })).toMatchObject({ ok: false, message: expect.stringMatching(/GSTIN/) })
      expect(await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { gstin: 'NOTAGSTIN' } })).toMatchObject({ ok: false })
      expect(await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { upiVpa: 'accemy' } })).toMatchObject({ ok: false })
      expect(await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { unknown: 1 } })).toMatchObject({ ok: false })
    })

    it('is held to "GST only with a GSTIN" by the database too', async () => {
      expect(await refusedBy(() => db.insert(schema.orgProfiles).values({ orgId, gstRate: '18' }))).toContain('org_profiles_gst_needs_a_gstin')
    })
  })

  describe('raising a quote', () => {
    it('prefills the lines from the services its needs point at, with GST and the advance, and numbers it', async () => {
      await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { gstin: GSTIN, gstRate: 18, advancePercent: 50 } })
      const r = await quoteCreate(db, { orgId, companyId, contactId, createdBy: userId, actor: userId, now: NOW })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.quote.number).toBe('Q-2026-0001')
      expect(quoteItemsOf(r.quote).map((i) => [i.name, i.unitPrice])).toContainEqual(['New website', 15_000])
      expect(r.quote.taxRate).toBe('18.00')
      expect(r.quote.total).toBe(r.quote.subtotal + r.quote.taxAmount)
      expect(r.quote.advanceAmount).toBe(Math.floor((r.quote.total * 50 + 50) / 100))
      expect(r.quote.validUntil).toBe('2026-10-22')
      expect(quoteNeedsOf(r.quote).map((n) => n.key)).toContain('no_website')
      expect(r.quote.status).toBe('draft')
      const second = await quoteCreate(db, { orgId, companyId, createdBy: userId, actor: userId, now: NOW })
      expect(second.ok && second.quote.number).toBe('Q-2026-0002')
      expect(await audits('quote.created')).toHaveLength(2)
    })

    it('takes lines typed by hand, and refuses a bad line or a contact at another company', async () => {
      const lines: QuoteItem[] = [{ serviceId: null, name: 'Logo', description: null, quantity: 1, unit: 'one_off', unitPrice: 5_000 }]
      const r = await quoteCreate(db, { orgId, companyId, items: lines, createdBy: userId, actor: userId, now: NOW })
      expect(r.ok && r.quote.subtotal).toBe(5_000)
      expect(r.ok && r.quote.taxAmount).toBe(0) // no GSTIN, no GST
      const bad = await quoteCreate(db, { orgId, companyId, items: [{ ...lines[0]!, quantity: 0 }], createdBy: userId, actor: userId })
      expect(bad).toMatchObject({ ok: false, reason: 'invalid' })
      const [other] = await db.insert(schema.companies).values({ orgId, domain: 'other.example', name: 'Other' }).returning({ id: schema.companies.id })
      const stranger = (await db.insert(schema.contacts).values({ orgId, companyId: other!.id, email: 'x@other.example' }).returning({ id: schema.contacts.id }))[0]!.id
      expect(await quoteCreate(db, { orgId, companyId, contactId: stranger, createdBy: userId, actor: userId })).toMatchObject({ ok: false, reason: 'invalid' })
    })

    it('is held by the database to a total that adds up', async () => {
      const r = await quoteCreate(db, { orgId, companyId, createdBy: userId, actor: userId, now: NOW })
      if (!r.ok) throw new Error(r.message)
      expect(await refusedBy(() => db.update(schema.quotes).set({ total: r.quote.total + 1 }).where(eq(schema.quotes.id, r.quote.id))))
        .toContain('quotes_total_adds_up')
    })
  })

  describe('sending, revising and deciding', () => {
    const raise = async () => {
      const r = await quoteCreate(db, { orgId, companyId, contactId, createdBy: userId, actor: userId, now: NOW })
      if (!r.ok) throw new Error(r.message)
      return r.quote
    }

    it('sends a draft, fixing the seller on it and moving the deal to proposal', async () => {
      await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { legalName: 'Accemy Digital LLP', upiVpa: 'accemy@okhdfcbank' } })
      const q = await raise()
      const sent = await quoteSend(db, { orgId, quoteId: q.id, actor: userId, now: NOW })
      expect(sent.ok).toBe(true)
      if (!sent.ok) return
      expect(sent.quote.seller).toMatchObject({ name: 'Accemy', legalName: 'Accemy Digital LLP', upiVpa: 'accemy@okhdfcbank' })
      const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deal!.stage).toBe('proposal')
      expect(await quoteSend(db, { orgId, quoteId: q.id, actor: userId })).toMatchObject({ ok: false, reason: 'not_editable' })
    })

    it('drafts the email that carries a sent quote for /approvals, addressed to its contact, claiming no conversation', async () => {
      const q = await raise()
      expect(await quoteDraftEmail(db, { orgId, quoteId: q.id, url: 'https://app.test/q/x', actor: userId })).toMatchObject({ ok: false, reason: 'not_sent' })
      await quoteSend(db, { orgId, quoteId: q.id, actor: userId, now: NOW })
      const r = await quoteDraftEmail(db, { orgId, quoteId: q.id, url: 'https://app.test/q/x', actor: userId })
      if (!r.ok) throw new Error(r.message)
      const [touch] = await db.select().from(schema.touches).where(eq(schema.touches.id, r.touchId))
      expect(touch).toMatchObject({ status: 'awaiting_approval', channel: 'email', direction: 'out', recipient: null })
      expect(touch!.subject).toBe(`Your quote ${q.number} from Accemy`)
      expect(touch!.body).toContain('https://app.test/q/x')
      expect(touch!.body).not.toMatch(/thank you for your time|as discussed/i)
      expect((await audits('quote.email_drafted'))[0]!.detail).toEqual({ touchId: r.touchId, number: q.number })
    })

    it('turns an edited sent quote back into a draft and revokes its links', async () => {
      const q = await raise()
      await quoteSend(db, { orgId, quoteId: q.id, actor: userId, now: NOW })
      const { token } = await shareLinkMint(db, { orgId, kind: 'quote', companyId, quoteId: q.id, createdBy: userId, actor: userId, expiresAt: new Date('2026-10-30T00:00:00Z') })
      expect(await shareLinkResolve(db, token, 'quote', NOW)).not.toBeNull()
      const r = await quoteUpdate(db, { orgId, quoteId: q.id, patch: { title: 'A better offer' }, actor: userId, now: NOW })
      expect(r).toMatchObject({ ok: true, revised: true, quote: { status: 'draft', seller: null, sentAt: null } })
      expect(await shareLinkResolve(db, token, 'quote', NOW)).toBeNull()
    })

    it('lands an edit only over the version the editor loaded', async () => {
      const q = await raise()
      const stale = '2020-01-01T00:00:00.000Z'
      expect(await quoteUpdate(db, { orgId, quoteId: q.id, patch: { title: 'X' }, expectedUpdatedAt: stale, actor: userId }))
        .toMatchObject({ ok: false, reason: 'changed_meanwhile' })
    })

    it('accepts through the link with a name, closes the deal won and asks for the advance', async () => {
      await orgProfileSave(db, { orgId, actor: userId, updatedBy: userId, input: { advancePercent: 50 } })
      const q = await raise()
      await quoteSend(db, { orgId, quoteId: q.id, actor: userId, now: NOW })
      expect(await quoteDecide(db, { orgId, quoteId: q.id, to: 'accepted', via: 'share_link', actor: 'share_link', now: NOW }))
        .toMatchObject({ ok: false, reason: 'invalid' })
      const r = await quoteDecide(db, { orgId, quoteId: q.id, to: 'accepted', via: 'share_link', acceptedByName: 'Ravi Kumar', actor: 'share_link', now: NOW })
      expect(r).toMatchObject({ ok: true, quote: { status: 'accepted', acceptedByName: 'Ravi Kumar' } })
      const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deal!.stage).toBe('won')
      const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.companyId, companyId))
      expect(tasks.map((t) => t.title)).toContain(`Collect the advance on ${q.number}`)
      expect(await audits('quote.accepted_via_share')).toHaveLength(1)
      expect(await quoteUpdate(db, { orgId, quoteId: q.id, patch: { title: 'Y' }, actor: userId })).toMatchObject({ ok: false, reason: 'not_editable' })
    })

    it('refuses acceptance through the link once the quote has lapsed', async () => {
      const q = await raise()
      await quoteSend(db, { orgId, quoteId: q.id, actor: userId, now: NOW })
      const later = new Date('2026-11-30T07:00:00Z')
      expect(await quoteDecide(db, { orgId, quoteId: q.id, to: 'accepted', via: 'share_link', acceptedByName: 'Ravi', actor: 'share_link', now: later }))
        .toMatchObject({ ok: false, reason: 'lapsed' })
    })

    it('declines and withdraws, withdrawing revoking its links', async () => {
      const a = await raise()
      await quoteSend(db, { orgId, quoteId: a.id, actor: userId, now: NOW })
      expect(await quoteDecide(db, { orgId, quoteId: a.id, to: 'declined', via: 'person', reason: 'Too costly', actor: userId, now: NOW }))
        .toMatchObject({ ok: true, quote: { status: 'declined', declineReason: 'Too costly' } })
      const b = await raise()
      await quoteSend(db, { orgId, quoteId: b.id, actor: userId, now: NOW })
      const { token } = await shareLinkMint(db, { orgId, kind: 'quote', companyId, quoteId: b.id, createdBy: userId, actor: userId, expiresAt: new Date('2026-10-30T00:00:00Z') })
      await quoteDecide(db, { orgId, quoteId: b.id, to: 'withdrawn', via: 'person', actor: userId, now: NOW })
      expect(await shareLinkResolve(db, token, 'quote', NOW)).toBeNull()
      expect((await quotesList(db, { orgId, companyId })).map((q) => q.status).sort()).toEqual(['declined', 'withdrawn'])
      expect((await quoteRead(db, orgId, b.id))!.status).toBe('withdrawn')
    })
  })

  describe('share links', () => {
    it('resolves only a live link of the kind asked, by its token', async () => {
      const { token, link } = await shareLinkMint(db, { orgId, kind: 'report', companyId, createdBy: userId, actor: userId, expiresAt: new Date('2026-11-01T00:00:00Z') })
      expect(link.tokenHash).not.toContain(token)
      expect((await shareLinkResolve(db, token, 'report', NOW))?.id).toBe(link.id)
      expect(await shareLinkResolve(db, token, 'preview', NOW)).toBeNull()
      expect(await shareLinkResolve(db, token, 'report', new Date('2026-11-02T00:00:00Z'))).toBeNull()
      expect(await shareLinkResolve(db, 'not-a-token', 'report', NOW)).toBeNull()
      expect(await shareLinkRevoke(db, { orgId, linkId: link.id, actor: userId })).toBe(true)
      expect(await shareLinkResolve(db, token, 'report', NOW)).toBeNull()
      expect(await shareLinkRevoke(db, { orgId, linkId: link.id, actor: userId })).toBe(false)
    })

    it('gives whoever made the link a task on the first view — a call when there is a phone — and none after', async () => {
      const { link } = await shareLinkMint(db, { orgId, kind: 'report', companyId, createdBy: userId, actor: userId, expiresAt: new Date('2026-11-01T00:00:00Z') })
      expect(await shareLinkCountView(db, { link, companyName: 'Kumar Dental', now: NOW })).toEqual({ first: true })
      expect(await shareLinkCountView(db, { link, companyName: 'Kumar Dental', now: new Date(NOW.getTime() + 60_000) })).toEqual({ first: false })
      const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.companyId, companyId), eq(schema.tasks.kind, 'call')))
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ title: 'Call Kumar Dental — your audit page link was just opened', assigneeUserId: userId })
      // Whoever holds a link opened it: "most likely" them, never more than that.
      expect(tasks[0]!.detail).toMatch(/opened for the first time just now, most likely by them/)
      const [row] = await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.id, link.id))
      expect(row).toMatchObject({ viewCount: 2, firstViewedAt: NOW })
    })

    it('raises a to-do instead of a call for a company with no phone on record', async () => {
      await db.update(schema.companies).set({ phone: null }).where(eq(schema.companies.id, companyId))
      const { link } = await shareLinkMint(db, { orgId, kind: 'preview', companyId, createdBy: userId, actor: userId, expiresAt: new Date('2026-11-01T00:00:00Z') })
      await shareLinkCountView(db, { link, companyName: 'Kumar Dental', now: NOW })
      const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.companyId, companyId))
      expect(tasks.map((t) => [t.kind, t.title])).toEqual([['todo', 'Follow up with Kumar Dental — your website preview link was just opened']])
    })

    it('never counts a view of a revoked or expired link', async () => {
      const { link } = await shareLinkMint(db, { orgId, kind: 'report', companyId, createdBy: userId, actor: userId, expiresAt: new Date('2026-11-01T00:00:00Z') })
      await shareLinkRevoke(db, { orgId, linkId: link.id, actor: userId })
      expect(await shareLinkCountView(db, { link, companyName: 'Kumar Dental', now: NOW })).toEqual({ first: false })
      // The database refuses a link made already expired, so this one expires after it is made, and is read after that.
      const expiresAt = new Date(Date.now() + 86_400_000)
      const { link: old } = await shareLinkMint(db, { orgId, kind: 'report', companyId, createdBy: userId, actor: userId, expiresAt })
      expect(await shareLinkCountView(db, { link: old, companyName: 'Kumar Dental', now: new Date(expiresAt.getTime() + 60_000) })).toEqual({ first: false })
      expect(await db.select().from(schema.tasks).where(eq(schema.tasks.companyId, companyId))).toEqual([])
    })

    it('drafts the email that carries a link for /approvals — naming no recipient, claiming only what is on record', async () => {
      const r = await shareLinkDraftEmail(db, { orgId, companyId, kind: 'preview', url: 'https://app.test/w/x', agencyName: 'Accemy', actor: userId })
      if (!r.ok) throw new Error(r.message)
      const [touch] = await db.select().from(schema.touches).where(eq(schema.touches.id, r.touchId))
      expect(touch).toMatchObject({ status: 'awaiting_approval', channel: 'email', direction: 'out', contactId: null, recipient: null, subject: 'A website for Kumar Dental' })
      expect(touch!.body).toContain('https://app.test/w/x')
      expect(touch!.body).toContain('your Google listing does not link to a website of your own')
      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'share_link.email_drafted'))
      expect(row!.detail).toEqual({ kind: 'preview', touchId: r.touchId })

      const report = await shareLinkDraftEmail(db, { orgId, companyId, kind: 'report', url: 'https://app.test/r/x', agencyName: 'Accemy', actor: userId })
      if (!report.ok) throw new Error(report.message)
      const [mail] = await db.select().from(schema.touches).where(eq(schema.touches.id, report.touchId))
      expect(mail!.body).toContain('from public information only')
      expect(mail!.body).not.toMatch(/your website on a phone|compare with/)
    })

    it('says a business has no website only when its listing was read and names none of its own', () => {
      const none = { domain: noSiteDomain('Kumar Dental', 'p1'), listingCheckedAt: NOW, listingWebsite: null }
      expect(shareLinkPreviewOpening('Kumar Dental', none)).toMatch(/^I noticed your Google listing does not link to a website of your own/)
      // A Facebook page is not a website of their own.
      expect(shareLinkPreviewOpening('Kumar Dental', { ...none, listingWebsite: 'https://facebook.com/kumardental' })).toMatch(/^I noticed/)
      // Never read: nothing is claimed about it.
      expect(shareLinkPreviewOpening('Kumar Dental', { ...none, listingCheckedAt: null })).toBe(
        'We made a quick preview of what a fresh one-page website for Kumar Dental could look like:',
      )
      // A site of their own: a fresh design, never "no website".
      expect(shareLinkPreviewOpening('Sharma Optics', { domain: 'sharmaoptics.in', listingCheckedAt: NOW, listingWebsite: 'https://sharmaoptics.in' })).toBe(
        'We made a quick preview of what a fresh one-page website for Sharma Optics could look like, from your Google listing:',
      )
    })

    it('is held to "a quote link names its quote" by the database', async () => {
      expect(await refusedBy(() => db.insert(schema.shareLinks).values({
        orgId, kind: 'quote', companyId, tokenHash: 'a'.repeat(64), expiresAt: new Date('2030-01-01T00:00:00Z'),
      }))).toContain('share_links_quote_iff_quote_kind')
    })
  })
})
