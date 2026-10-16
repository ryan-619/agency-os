/**
 * Suggested answers (0026) against a migrated database: the gate in front of
 * the model refuses every reply nobody should answer with its help, a
 * suggestion is written once, the inbox carries it, a person can put it
 * away or start from it, the sweep finds only replies with no row, and an
 * erasure takes it with the person.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, erasureErase, inboxTouches, recordInboundReply, replyMarkHandled, replyQueueDraft, repliesAwaitingSuggestion,
  replySuggestionDismiss, replySuggestionFacts, replySuggestionMarkUsed, replySuggestionRows, replySuggestionSkip,
  replySuggestionWrite, schema, servicePriceWords, type AgencyDb,
} from '../src/index.js'
import { expectRejection, migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-10-09T10:00:00.000Z')

describe('suggested answers', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let openerId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy', bookingSlug: 'accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental', timeZone: 'Asia/Kolkata' }).returning({ id: schema.companies.id }))[0]!.id
    contactId = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'ravi@kumardental.in', firstName: 'Ravi', timeZone: 'Asia/Kolkata' }).returning({ id: schema.contacts.id }))[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Clinics', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
    openerId = (await db.insert(schema.touches).values({
      orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent', subject: 'Kumar Dental: a note',
      body: 'Hi,\n\nI had a look at Kumar Dental’s public pages…', recipient: 'ravi@kumardental.in', providerId: '<opener@accemy>', sentAt: NOW,
    }).returning({ id: schema.touches.id }))[0]!.id
    await db.insert(schema.services).values({ orgId, name: 'Website build', needs: [], priceFrom: 25000, priceTo: 60000, currency: 'INR', priceUnit: 'one_off' })
    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted', ownerUserId: ownerId })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const reply = async (body: string, over: { from?: string; autoReply?: boolean; messageId?: string } = {}) => {
    const r = await recordInboundReply(db, {
      orgId, contactId, channel: 'email', from: over.from ?? 'ravi@kumardental.in', subject: 'Re: Kumar Dental: a note', body,
      inReplyTo: openerId, providerId: over.messageId ?? `<reply-${Math.random()}@kumardental.in>`, now: NOW,
      ...(over.autoReply !== undefined ? { autoReply: over.autoReply } : {}),
    })
    return r.touchId
  }
  const facts = (touchId: string) => replySuggestionFacts(db, { orgId, touchId, now: NOW, webOrigin: 'https://myagencyos.in' })

  it('gathers what the model may be shown for an ordinary reply', async () => {
    const touchId = await reply('Sounds useful. What would a new website cost?\n\nOn Thu, Accemy wrote:\n> I had a look')
    const r = await facts(touchId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.facts).toMatchObject({ orgId, touchId, contactId, companyId })
    expect(r.facts.input).toMatchObject({
      orgName: 'Accemy', contactFirstName: 'Ravi', companyName: 'Kumar Dental', replyKind: 'other',
      ownWords: 'Sounds useful. What would a new website cost?', ourSubject: 'Kumar Dental: a note', dealStage: 'replied',
      bookingUrl: 'https://myagencyos.in/book/accemy',
    })
    expect(r.facts.input.ownWords).not.toContain('I had a look')
    expect(r.facts.input.services).toEqual([{ name: 'Website build', price: '₹25,000–₹60,000 one-off' }])
    expect(r.facts.input.observed).toEqual([])
    expect(r.facts.allowed).toEqual({ urls: ['https://myagencyos.in/book/accemy'], amounts: ['25000', '60000'] })
  })

  it('offers no booking link without the web’s origin, and allows an amount the playbook carries', async () => {
    await db.insert(schema.assistantSettings).values({ orgId, playbook: 'A care plan is ₹2,000 a month.' })
    const touchId = await reply('Tell me more')
    const r = await replySuggestionFacts(db, { orgId, touchId, now: NOW })
    expect(r.ok && r.facts.input.bookingUrl).toBeNull()
    expect(r.ok && r.facts.allowed.amounts).toEqual(['25000', '60000', '2000'])
  })

  it('refuses every reply nobody should answer with a model’s help', async () => {
    expect(await facts('00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, why: 'not_found' })
    expect(await facts(openerId)).toEqual({ ok: false, why: 'not_a_reply' })
    expect(await facts(await reply('I have left the company — try Priya'))).toEqual({ ok: false, why: 'opted_out' })
    expect(await facts(await reply('I am out of office until Monday', { autoReply: true }))).toEqual({ ok: false, why: 'auto_reply' })
    expect(await facts(await reply('Please send details to me instead', { from: 'priya@kumardental.in' }))).toEqual({ ok: false, why: 'colleague' })
    expect(await facts(await reply('\n\nOn Thu, Accemy wrote:\n> hello'))).toEqual({ ok: false, why: 'no_words' })

    const handled = await reply('Interesting, call me')
    await replyMarkHandled(db, { orgId, touchId: handled, userId: ownerId })
    expect(await facts(handled)).toEqual({ ok: false, why: 'handled' })

    const answered = await reply('Can you call Tuesday?')
    const drafted = await replyQueueDraft(db, { orgId, inboundTouchId: answered, subject: 'Re: yes', body: 'Yes — Tuesday at 11?', campaignId, actor: ownerId })
    expect(drafted).toMatchObject({ ok: true })
    expect(await facts(answered)).toEqual({ ok: false, why: 'answered' })

    // Last, because a stop in so many words suppresses the address, and every later reply from it reads as suppressed.
    expect(await facts(await reply('Please remove me from your list'))).toEqual({ ok: false, why: 'opted_out' })
  })

  it('refuses a contact on the suppression list, and one held by a pause that is not their reply’s', async () => {
    const touchId = await reply('What does it cost?')
    expect((await facts(touchId)).ok).toBe(true)
    await db.update(schema.contacts).set({ pausedAt: NOW, pausedReason: 'hold until the audit is done (by ryan)' }).where(eq(schema.contacts.id, contactId))
    expect(await facts(touchId)).toEqual({ ok: false, why: 'held' })
    await db.update(schema.contacts).set({ pausedAt: NOW, pausedReason: `replied ${NOW.toISOString()}` }).where(eq(schema.contacts.id, contactId))
    expect((await facts(touchId)).ok).toBe(true)
    await addSuppression(db, { orgId, kind: 'email', value: 'ravi@kumardental.in', reason: 'asked by phone', source: 'manual' })
    expect(await facts(touchId)).toEqual({ ok: false, why: 'suppressed' })
  })

  it('is written once, read by the inbox, used or put away, and found by the sweep only while it has no row', async () => {
    const touchId = await reply('What does it cost?')
    const other = await reply('And for a care plan?')
    expect(await repliesAwaitingSuggestion(db, { since: new Date(NOW.getTime() - 60_000), limit: 10 })).toEqual([
      { orgId, touchId }, { orgId, touchId: other },
    ])

    const w = await replySuggestionWrite(db, { orgId, touchId, contactId, companyId, body: 'Thanks Ravi — ₹25,000–₹60,000 one-off.', model: 'fake/fake-1' })
    expect(w.ok).toBe(true)
    expect(await replySuggestionWrite(db, { orgId, touchId, contactId, companyId, body: 'again', model: 'fake/fake-1' })).toEqual({ ok: false, why: 'already' })
    expect(await facts(touchId)).toEqual({ ok: false, why: 'already' })
    await replySuggestionSkip(db, { orgId, touchId: other, why: 'model_declined' })
    await replySuggestionSkip(db, { orgId, touchId: other, why: 'invented_price' })
    expect(await repliesAwaitingSuggestion(db, { since: new Date(NOW.getTime() - 60_000), limit: 10 })).toEqual([])
    expect((await replySuggestionRows(db, [other]))[0]).toMatchObject({ status: 'skipped', skippedWhy: 'model_declined', body: null })

    const rows = await inboxTouches(db, orgId)
    const shown = rows.find((r) => r.touch.id === touchId)!
    expect(shown.suggestion).toMatchObject({ body: 'Thanks Ravi — ₹25,000–₹60,000 one-off.', model: 'fake/fake-1', usedAt: null })
    expect(rows.find((r) => r.touch.id === other)!.suggestion).toBeNull()

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'reply.suggested'))
    expect(audit).toHaveLength(1)
    expect(audit[0]!.detail).toEqual({ contactId, companyId, model: 'fake/fake-1', chars: 38 })
    expect(JSON.stringify(audit[0]!.detail)).not.toContain('Thanks Ravi')

    // Used: the answer the person drafted started from it.
    const answer = await replyQueueDraft(db, { orgId, inboundTouchId: touchId, subject: 'Re: cost', body: 'Thanks Ravi — ₹25,000 to start.', campaignId, actor: ownerId })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(await replySuggestionMarkUsed(db, { orgId, touchId, suggestionId: shown.suggestion!.id, answerTouchId: answer.touchId, actor: ownerId, now: NOW })).toBe(true)
    expect(await replySuggestionMarkUsed(db, { orgId, touchId, suggestionId: shown.suggestion!.id, answerTouchId: answer.touchId, actor: ownerId, now: NOW })).toBe(false)
    expect((await inboxTouches(db, orgId)).find((r) => r.touch.id === touchId)!.suggestion?.usedAt).toEqual(NOW)

    // Put away: gone from the inbox, kept on the row.
    expect(await replySuggestionDismiss(db, { orgId, touchId, actor: ownerId, now: NOW })).toEqual({ ok: true })
    expect(await replySuggestionDismiss(db, { orgId, touchId, actor: ownerId, now: NOW })).toEqual({ ok: false, reason: 'already' })
    expect(await replySuggestionDismiss(db, { orgId, touchId: other, actor: ownerId, now: NOW })).toEqual({ ok: false, reason: 'not_found' })
    expect((await inboxTouches(db, orgId)).find((r) => r.touch.id === touchId)!.suggestion).toBeNull()
    expect((await replySuggestionRows(db, [touchId]))[0]).toMatchObject({ status: 'drafted', dismissedAt: NOW })
  })

  it('cannot store a drafted row without words or a skipped row without why, and never two for one reply', async () => {
    const touchId = await reply('Hello')
    // Raw SQL: the engine's own message names the constraint, which drizzle's wrapper does not.
    const refused = (org: string, touch: string, status: string, body: string | null, model: string | null, why: string | null) =>
      expectRejection(() =>
        test.pg.query('INSERT INTO reply_suggestions (org_id, touch_id, status, body, model, skipped_why) VALUES ($1, $2, $3, $4, $5, $6)', [org, touch, status, body, model, why]),
      )
    expect(await refused(orgId, touchId, 'drafted', null, null, null)).toMatch(/reply_suggestions_drafted_has_words/)
    expect(await refused(orgId, touchId, 'skipped', null, null, null)).toMatch(/reply_suggestions_skipped_says_why/)
    expect(await refused(orgId, touchId, 'shown', null, null, null)).toMatch(/reply_suggestions_status_is_known/)
    await db.insert(schema.replySuggestions).values({ orgId, touchId, status: 'drafted', body: 'x', model: 'm' })
    expect(await refused(orgId, touchId, 'skipped', null, null, 'held')).toMatch(/reply_suggestions_one_per_reply/)
    // Another org cannot name this org's reply.
    const otherOrg = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
    const another = await reply('Again')
    expect(await refused(otherOrg, another, 'drafted', 'x', 'm', null)).toMatch(/reply_suggestions_touch_in_org/)
  })

  it('goes with the person when they are erased', async () => {
    const touchId = await reply('What does it cost?')
    await replySuggestionWrite(db, { orgId, touchId, contactId, companyId, body: 'Thanks Ravi — here is what it costs.', model: 'fake/fake-1' })
    const erased = await erasureErase(db, { orgId, contactId, actor: ownerId, now: NOW, log: { error: () => {} } })
    expect(erased.ok).toBe(true)
    expect(await replySuggestionRows(db, [touchId])).toEqual([])
  })

  it('words a service’s price as the catalogue stores it', () => {
    expect(servicePriceWords({ priceFrom: 25000, priceTo: 60000, currency: 'INR', priceUnit: 'one_off' })).toBe('₹25,000–₹60,000 one-off')
    expect(servicePriceWords({ priceFrom: 2000, priceTo: 2000, currency: 'INR', priceUnit: 'monthly' })).toBe('₹2,000 a month')
    expect(servicePriceWords({ priceFrom: 500, priceTo: null, currency: 'USD', priceUnit: 'hourly' })).toBe('from USD 500 an hour')
    expect(servicePriceWords({ priceFrom: null, priceTo: null, currency: 'INR', priceUnit: 'one_off' })).toBeNull()
  })
})
