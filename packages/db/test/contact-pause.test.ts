/**
 * Pausing and resuming a person by hand, and the answer that resumed them
 * (PROMPT.md §2.1, §8.4), against a real engine.
 *
 * Four review findings (round 3), each a way a pause that should have held
 * did not:
 *
 *  - /contacts Resume lifted ANY pause, including the two that stand in for
 *    an opt-out nobody could record and an erasure that did not finish —
 *    the only thing left between that person and a send.
 *  - Answering a reply resumed the person when the answer was DRAFTED, and
 *    denying the answer never put the pause back: a reply nobody answered,
 *    and every campaign live for them again.
 *  - That resume cleared whatever pause the row held when the UPDATE ran,
 *    not the reply's pause the inbox had read, so an "opt-out not recorded"
 *    pause landing in between was wiped.
 *  - A teammate's Pause on somebody a reply had already paused changed
 *    nothing and answered "paused" — and answering the reply then resumed
 *    them over the teammate's hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  contactPauseByHand, contactResumeByHand, denyDraft, handleInboundEmail, pauseContact,
  pauseContactOverriding, pauseReasonClass, previewSend, replyQueueDraft, resumeContact, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
import { failOnce } from './fault-db.js'

/** Midday UTC on a Tuesday: 13:00 in London. */
const NOON = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T15:00:00.000Z')
const OUR_MESSAGE_ID = '<first-touch@agency.test>'

const NOT_RECORDED = 'opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (unparseable_address)'
const ERASURE = 'erasure requested 2026-09-15; not completed (Error)'
const TEAMMATE = 'client CISO – never contact (by sam@agency.test)'

describe('pausing and resuming by hand', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let outboundId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Olu Owner', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, firstName: 'Priya', email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4 security gaps', channel: 'email', autoSend: false, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    const [out] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent',
        subject: 'A gap on your security page', body: 'Hello.', recipient: 'priya@rentman.io',
        providerId: OUR_MESSAGE_ID, sentAt: new Date('2026-09-14T10:00:00.000Z'),
        approvedBy: userId, approvedAt: new Date('2026-09-14T09:55:00.000Z'),
      })
      .returning({ id: schema.touches.id })
    outboundId = out!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A reply that arrives the real way: it pauses them `replied <instant>`. */
  const reply = async (messageId = '<reply-1@rentman.io>') => {
    const r = await handleInboundEmail(db, {
      from: 'priya@rentman.io',
      subject: 'Re: A gap on your security page',
      text: 'Not now, maybe in the new year.',
      messageId,
      references: [OUR_MESSAGE_ID],
      now: NOON,
    })
    if (r.matched === 'none') throw new Error(`the reply was not matched: ${r.why}`)
    return r.touchId
  }
  const contactRow = async () => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!
  const setPause = async (reason: string | null) =>
    db.update(schema.contacts).set({ pausedAt: NOON, pausedReason: reason }).where(eq(schema.contacts.id, contactId))
  const answer = (inboundTouchId: string, d: AgencyDb = db) =>
    replyQueueDraft(d, {
      orgId, inboundTouchId, subject: 'Re: the gap', body: 'Happy to wait — talk in January.', actor: userId, now: NOON,
    })
  const answersTo = async (inboundId: string) =>
    db.select().from(schema.touches).where(eq(schema.touches.answersTouchId, inboundId))
  const auditRows = async (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))
  /** Resume the way the route does: on the pause the page SHOWED (`shown`), as the user who pressed it. */
  const resumeShown = async (shown: { readonly pausedReason: string | null }) =>
    contactResumeByHand(db, { orgId, contact: { id: contactId }, expectedReason: shown.pausedReason, actor: userId })

  // -------------------------------------------------------------------------
  // [0] Resume refuses a pause nobody may lift
  // -------------------------------------------------------------------------

  describe('Resume', () => {
    it('refuses the pause an opt-out nobody could record left, and changes nothing', async () => {
      await setPause(NOT_RECORDED)
      const r = await resumeShown(await contactRow())
      expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
      if (r.ok) return
      expect(r.message).toMatch(/\/suppressions/)
      expect(r.message).toMatch(/Nothing was changed/)
      expect((await contactRow()).pausedReason).toBe(NOT_RECORDED)
    })

    it('still refuses it once the opt-out has been recorded by hand: an opt-out is not something to resume', async () => {
      await setPause(NOT_RECORDED)
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'by hand' })
      expect(await resumeShown(await contactRow())).toMatchObject({
        ok: false, reason: 'opt_out_not_recorded',
      })
      expect((await contactRow()).pausedReason).toBe(NOT_RECORDED)
    })

    it('refuses the pause an unfinished erasure left, and points at finishing it', async () => {
      await setPause(ERASURE)
      const r = await resumeShown(await contactRow())
      expect(r).toMatchObject({ ok: false, reason: 'erasure' })
      if (r.ok) return
      expect(r.message).toMatch(/Erase/)
      expect((await contactRow()).pausedReason).toBe(ERASURE)
    })

    /**
     * The pause is not the only record of an unrecorded opt-out: the audit
     * row is, and so is an opted_out reply no suppression row matches. A
     * reply's own pause beside either is still not a pause to lift — the
     * inbox's own reading, `optOutNotRecorded`, decides.
     */
    for (const [action, subject] of [
      ['unsubscribe.not_recorded', 'touch'],
      ['contact.erasure_failed', 'contact'],
      ['contact.opt_out_not_recorded', 'contact'],
    ] as const) {
      it(`refuses a reply's pause while ${action} names them and no suppression row matches them`, async () => {
        await reply()
        await db.insert(schema.auditLog).values({
          orgId, actor: 'system', action, subjectType: subject,
          subjectId: subject === 'touch' ? outboundId : contactId,
          detail: subject === 'touch' ? { touchId: outboundId, contactId, why: 'Error' } : { why: 'Error' },
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        })
        const before = await contactRow()
        expect(pauseReasonClass(before.pausedReason)).toBe('replied')
        expect(await resumeShown(before)).toMatchObject({
          ok: false, reason: 'opt_out_not_recorded',
        })
        expect((await contactRow()).pausedReason).toBe(before.pausedReason)

        // Recorded by hand since: the suppression row enforces it, and the
        // reply's pause is a person's to lift again.
        await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'priya@rentman.io', reason: 'by hand' })
        expect(await resumeShown(await contactRow())).toEqual({ ok: true })
        expect((await contactRow()).pausedAt).toBeNull()
      })
    }

    it('refuses while an opted_out reply of theirs matches no suppression row, with nothing on the audit log', async () => {
      await db.insert(schema.touches).values({
        orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', subject: 'Re', body: 'Unsubscribe',
        recipient: 'priya@rentman.io', replyKind: 'opted_out', sentAt: NOON,
      })
      await reply()
      expect(await resumeShown(await contactRow())).toMatchObject({
        ok: false, reason: 'opt_out_not_recorded',
      })
    })

    it('lifts a teammate’s pause and a reply’s pause, as before', async () => {
      await setPause(TEAMMATE)
      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      expect(await contactRow()).toMatchObject({ pausedAt: null, pausedReason: null })

      await reply()
      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('lifts only the pause the page read: one that changed since is refused, and stays', async () => {
      await reply()
      const read = await contactRow()
      // An unsubscribe that could not be recorded lands between the page's
      // read and the click.
      await pauseContactOverriding(db, orgId, contactId, NOT_RECORDED, NOON)
      const r = await resumeShown(read)
      expect(r).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
      expect((await contactRow()).pausedReason).toBe(NOT_RECORDED)
    })

    /**
     * Review round 4, [20]. The route used to judge and lift the pause IT
     * read after the click, so this guard covered only the milliseconds
     * between its own read and its UPDATE. Alice's page shows the reply's
     * pause; Bob holds them since, which replaces it; Alice's Resume names
     * the pause her page showed, and Bob's hold stands.
     */
    it('lifts the pause the page SHOWED: a teammate’s hold written since the page loaded is refused, and stands', async () => {
      await reply()
      const shown = await contactRow()
      expect(pauseReasonClass(shown.pausedReason)).toBe('replied')
      expect(await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })).toEqual({
        ok: true, replaced: 'replied',
      })

      const r = await resumeShown(shown)
      expect(r).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
      if (r.ok) return
      expect(r.message).toMatch(/changed since this page loaded/)
      expect(r.message).toMatch(/Reload the page/)
      expect(r.message).toMatch(/Nothing was changed/)
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
      expect(await auditRows('contact.resumed')).toEqual([])

      // Reloaded, the page shows Bob's hold, and lifting THAT is a person's call.
      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('a second Resume from the same page, after the first lifted it, is refused as changed — one resume, one row', async () => {
      await setPause(TEAMMATE)
      const shown = await contactRow()
      expect(await resumeShown(shown)).toEqual({ ok: true })
      expect(await resumeShown(shown)).toMatchObject({ ok: false, reason: 'changed_meanwhile' })
      expect(await auditRows('contact.resumed')).toHaveLength(1)
    })

    /**
     * Review round 4, [12], the reverse case: `resumeContact`'s guard matched
     * `paused_reason IS NULL` on a contact who was not paused at all, so the
     * route answered "resumed" and wrote a `contact.resumed` row for a resume
     * that never happened — a row the re-pause guard reads as a person's
     * decision.
     */
    it('resumes nobody who is not paused, and writes no row for it', async () => {
      const r = await resumeShown({ pausedReason: null })
      expect(r).toMatchObject({ ok: false, reason: 'not_paused' })
      if (r.ok) return
      expect(r.message).toMatch(/not paused/)
      expect(await auditRows('contact.resumed')).toEqual([])
      expect(await resumeContact(db, orgId, contactId, { expectedReason: null })).toBe(false)
    })

    it('does not answer "resumed" for a contact that is not there', async () => {
      expect(
        await contactResumeByHand(db, {
          orgId, contact: { id: '00000000-0000-4000-8000-000000000000' }, expectedReason: TEAMMATE, actor: userId,
        }),
      ).toMatchObject({ ok: false, reason: 'not_found' })
    })

    /**
     * Review round 4, [12]. The route wrote `contact.resumed` after the
     * resume had committed, behind `.catch(() => {})`; the re-pause guard
     * reads that row, so a resume with no row was a resume the guard could
     * not see. Now the row is the resume's own, and is written or the resume
     * is not.
     */
    it('writes its own `contact.resumed` row — the pause’s class, never its text — as the person who pressed it', async () => {
      await setPause(TEAMMATE)
      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      const rows = await auditRows('contact.resumed')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ actor: userId, subjectType: 'contact', subjectId: contactId })
      expect(rows[0]!.detail).toEqual({ pausedFor: 'manual' })
      expect(JSON.stringify(rows[0]!.detail)).not.toContain('sam@agency.test')
    })

    it('a resume whose audit row cannot be written did not happen: the pause stands, and a retry runs clean', async () => {
      await setPause(TEAMMATE)
      const fault = await failOnce(test.pg, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'contact.resumed'" })
      const thrown = await resumeShown(await contactRow()).then(() => null, (err: unknown) => err)
      let cause = thrown as { message?: string; cause?: unknown } | null
      while (cause?.cause) cause = cause.cause as typeof cause
      expect(cause?.message).toBe(fault)
      expect(await contactRow()).toMatchObject({ pausedReason: TEAMMATE })
      expect((await contactRow()).pausedAt).not.toBeNull()
      expect(await auditRows('contact.resumed')).toEqual([])

      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await auditRows('contact.resumed')).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // [15] A teammate's Pause over a reply's pause
  // -------------------------------------------------------------------------

  describe('Pause', () => {
    it('pauses somebody who was not paused, with the teammate’s reason', async () => {
      expect(await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: NOON })).toEqual({
        ok: true, replaced: null,
      })
      expect(await contactRow()).toMatchObject({ pausedReason: TEAMMATE })
    })

    it('replaces a reply’s pause, so answering the reply no longer lifts the teammate’s hold', async () => {
      const id = await reply()
      expect(pauseReasonClass((await contactRow()).pausedReason)).toBe('replied')

      expect(await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })).toEqual({
        ok: true, replaced: 'replied',
      })
      const held = await contactRow()
      expect(held.pausedReason).toBe(TEAMMATE)
      expect(pauseReasonClass(held.pausedReason)).toBe('manual')

      expect(await answer(id)).toMatchObject({ ok: false, reason: 'paused_for_another_reason' })
      expect(await answersTo(id)).toEqual([])
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
    })

    for (const existing of [
      TEAMMATE,
      'unsubscribed 2026-09-15T11:00:00.000Z',
      NOT_RECORDED,
      ERASURE,
      'paused for a reason nobody wrote down',
    ]) {
      it(`never replaces "${existing.slice(0, 28)}…" — says it stands, and changes nothing`, async () => {
        await setPause(existing)
        const r = await contactPauseByHand(db, { orgId, contactId, reason: 'hold until Q1 (by sam@agency.test)', now: LATER })
        expect(r).toMatchObject({ ok: false, reason: 'already_paused', pausedFor: pauseReasonClass(existing) })
        if (r.ok) return
        expect(r.message).toMatch(/stands/)
        expect((await contactRow()).pausedReason).toBe(existing)
      })
    }

    it('does not answer "paused" for a contact that is not there', async () => {
      expect(
        await contactPauseByHand(db, { orgId, contactId: '00000000-0000-4000-8000-000000000000', reason: TEAMMATE }),
      ).toMatchObject({ ok: false, reason: 'not_found' })
    })
  })

  // -------------------------------------------------------------------------
  // [9] The resume lifts only the reason that was read
  // -------------------------------------------------------------------------

  describe('the reason a resume expects', () => {
    it('resumeContact with an expected reason leaves a pause whose reason changed', async () => {
      await pauseContact(db, orgId, contactId, `replied ${NOON.toISOString()}`, NOON)
      await pauseContactOverriding(db, orgId, contactId, NOT_RECORDED, NOON)
      expect(await resumeContact(db, orgId, contactId, { expectedReason: `replied ${NOON.toISOString()}` })).toBe(false)
      expect((await contactRow()).pausedReason).toBe(NOT_RECORDED)

      expect(await resumeContact(db, orgId, contactId, { expectedReason: NOT_RECORDED })).toBe(true)
      expect((await contactRow()).pausedAt).toBeNull()
    })

    /**
     * The sequential version of the race: an override pause lands after the
     * inbox read the contact and before its resume runs. Driven by a wrapper
     * that writes the override in the transaction, immediately before the
     * inbox's own UPDATE of the contact — what a concurrent writer that
     * committed first looks like to that UPDATE under READ COMMITTED.
     */
    it('answering a reply does not wipe a pause that replaced the reply’s since it was read', async () => {
      const id = await reply()
      let armed = true
      const wrap = (inner: AgencyDb): AgencyDb =>
        new Proxy(inner as object, {
          get(target, prop, receiver) {
            if (prop === 'transaction') {
              return (fn: (tx: AgencyDb) => Promise<unknown>) =>
                (target as AgencyDb).transaction((tx) => fn(wrap(tx as unknown as AgencyDb)) as never)
            }
            if (prop === 'update') {
              return (table: unknown) => {
                if (armed && table === schema.contacts) {
                  armed = false
                  const t = target as AgencyDb
                  const override = t
                    .update(schema.contacts)
                    .set({ pausedReason: NOT_RECORDED })
                    .where(eq(schema.contacts.id, contactId))
                  const real = t.update(schema.contacts)
                  // The override runs first, then the inbox's own statement.
                  return {
                    set: (values: Record<string, unknown>) => ({
                      where: (w: unknown) => ({
                        returning: async (r: unknown) => {
                          await override
                          return real.set(values as never).where(w as never).returning(r as never)
                        },
                      }),
                    }),
                  }
                }
                return (target as AgencyDb).update(table as typeof schema.contacts)
              }
            }
            const v = Reflect.get(target, prop, receiver)
            return typeof v === 'function' ? v.bind(target) : v
          },
        }) as AgencyDb

      const r = await answer(id, wrap(db))
      expect(armed).toBe(false)
      expect(r).toMatchObject({ ok: false, reason: 'paused_for_another_reason' })
      expect(await answersTo(id)).toEqual([])
      expect((await contactRow()).pausedAt).not.toBeNull()
    })

    it('the inbox resumes on the reason it read, under a lock on the contact (pinned by source)', () => {
      const src = readFileSync(fileURLToPath(new URL('../src/inbox.ts', import.meta.url)), 'utf8')
      const draftFn = src.slice(src.indexOf('export async function replyQueueDraft'), src.indexOf('async function optOutNotRecorded'))
      expect(draftFn).toMatch(/resumeContact\(tx, args\.orgId, contact\.id, \{ expectedReason: contact\.pausedReason \}\)/)
      const contactRead = draftFn.slice(draftFn.indexOf('.from(schema.contacts)'), draftFn.indexOf('const contact ='))
      expect(contactRead).toMatch(/\.for\('update'\)/)
      const outreach = readFileSync(fileURLToPath(new URL('../src/outreach.ts', import.meta.url)), 'utf8')
      const resumeFn = outreach.slice(outreach.indexOf('export async function resumeContact'))
      expect(resumeFn.slice(0, resumeFn.indexOf('\n}\n'))).toMatch(/pausedReason/)
    })
  })

  // -------------------------------------------------------------------------
  // [3] Denying the answer puts the reply's pause back
  // -------------------------------------------------------------------------

  describe('denying an answer', () => {
    it('puts the pause their reply caused back on, with the reply’s own reason, and says so in the audit log', async () => {
      const id = await reply()
      const replied = (await contactRow()).pausedReason
      const drafted = await answer(id)
      expect(drafted).toMatchObject({ ok: true, resumed: true })
      if (!drafted.ok) return
      expect((await contactRow()).pausedAt).toBeNull()

      expect(await denyDraft(db, { orgId, touchId: drafted.touchId, decidedBy: userId, note: 'wrong tone', now: LATER }))
        .toMatchObject({ ok: true })
      const after = await contactRow()
      expect(after.pausedAt).not.toBeNull()
      expect(after.pausedReason).toBe(replied)
      expect(pauseReasonClass(after.pausedReason)).toBe('replied')

      // A cold opener in any campaign is refused for them again.
      const preview = await previewSend(db, { orgId, contactId, campaignId, now: LATER })
      expect(preview).toMatchObject({ ok: true, decision: { allowed: false, code: 'paused' } })

      const [paused] = await auditRows('contact.paused')
      expect(paused).toMatchObject({ actor: userId, subjectType: 'contact', subjectId: contactId })
      expect(paused!.detail).toMatchObject({ alreadyPaused: false, inboundTouchId: id })
      // The class, never the reason's text.
      expect(JSON.stringify(paused!.detail)).not.toContain('replied 20')

      // And answering again resumes them, as the first answer did.
      expect(await answer(id)).toMatchObject({ ok: true, resumed: true })
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('pauses nobody when the answer did not resume them', async () => {
      const id = await reply()
      await resumeContact(db, orgId, contactId)
      const drafted = await answer(id)
      expect(drafted).toMatchObject({ ok: true, resumed: false })
      if (!drafted.ok) return
      await denyDraft(db, { orgId, touchId: drafted.touchId, decidedBy: userId, now: LATER })
      expect((await contactRow()).pausedAt).toBeNull()
      expect(await auditRows('contact.paused')).toEqual([])
    })

    it('leaves a teammate’s pause since as it is', async () => {
      const id = await reply()
      const drafted = await answer(id)
      if (!drafted.ok) throw new Error('unreachable')
      await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })
      await denyDraft(db, { orgId, touchId: drafted.touchId, decidedBy: userId, now: LATER })
      expect((await contactRow()).pausedReason).toBe(TEAMMATE)
    })

    it('does not undo a person’s own Resume since the answer was drafted', async () => {
      const id = await reply()
      const drafted = await answer(id)
      if (!drafted.ok) throw new Error('unreachable')
      // A teammate paused them, and somebody resumed them on /contacts. The
      // resume writes its own `contact.resumed` row, in its own transaction
      // (review round 4, [12] — probe R): nothing here writes it by hand,
      // which is the case where the route's post-commit row never landed.
      await contactPauseByHand(db, { orgId, contactId, reason: TEAMMATE, now: LATER })
      expect(await resumeShown(await contactRow())).toEqual({ ok: true })
      await denyDraft(db, { orgId, touchId: drafted.touchId, decidedBy: userId, now: LATER })
      expect((await contactRow()).pausedAt).toBeNull()
    })

    it('a cold draft denied is only a no — it pauses nobody', async () => {
      const [cold] = await db
        .insert(schema.touches)
        .values({
          orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval',
          subject: 'Hello', body: 'A gap.',
        })
        .returning({ id: schema.touches.id })
      await denyDraft(db, { orgId, touchId: cold!.id, decidedBy: userId, now: LATER })
      expect((await contactRow()).pausedAt).toBeNull()
    })
  })
})
