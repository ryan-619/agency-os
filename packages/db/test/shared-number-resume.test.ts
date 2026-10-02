/**
 * A shared number's holder, held hard while the number's STOP is unrecorded,
 * is released once a PERSON records the number — not only by a later text.
 *
 * Review round 8, finding [0], left one path open (the r9-sms group named it,
 * in a file it did not own): `releaseSharedNumberHolds` eases a holder's
 * `sharedNumberOptOutReason` pause to the ordinary hold only when a later
 * delivery through `recordInboundSms` finds the number suppressed. A number
 * recorded by hand on /suppressions, with no later text from it — the likely
 * path once a push with no message id is answered 200 and never retried —
 * left the holder refused by Resume for good, under a sentence saying THEY
 * asked to stop. Now Resume refuses them, in words that say a text from a
 * number they share did, only while the number has no phone suppression in
 * their org; once it has one, Resume lifts the pause. A contact's OWN
 * unrecorded opt-out is unchanged: Resume still refuses it outright.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, contactPauseByHand, contactResumeByHand, isSharedNumberOptOutPause, pauseContactOverriding,
  pauseReasonClass, schema, sharedNumberOptOutReason, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const NUMBER = '+919812345678'

describe('Resume on a shared number’s holder', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let holderId: string

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
      .values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    const [holder] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, firstName: 'Reception', email: 'reception@rentman.io', phone: NUMBER, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    holderId = holder!.id
  })

  afterEach(async () => {
    await test.close()
  })

  async function reasonOf(): Promise<string | null> {
    const [c] = await db.select({ r: schema.contacts.pausedReason }).from(schema.contacts).where(eq(schema.contacts.id, holderId))
    return c!.r
  }

  it('refuses while the number is unrecorded, without saying the holder asked, and lifts it once a person records it', async () => {
    const reason = sharedNumberOptOutReason(NOW, 'record_failed')
    expect(isSharedNumberOptOutPause(reason)).toBe(true)
    expect(pauseReasonClass(reason)).toBe('opt_out_not_recorded')
    await pauseContactOverriding(db, orgId, holderId, reason, NOW)

    const refused = await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: reason, actor: userId })
    expect(refused).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!refused.ok) {
      expect(refused.message).toContain('a number this contact shares')
      expect(refused.message).not.toMatch(/This person asked to stop/)
    }
    expect(await reasonOf()).toBe(reason)

    // A person records the number by hand; no later text from it ever comes.
    const added = await addSuppression(db, { orgId, kind: 'phone', value: NUMBER, reason: 'recorded by hand', source: 'manual' })
    expect(added.ok).toBe(true)

    expect(await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: reason, actor: userId })).toEqual({ ok: true })
    expect(await reasonOf()).toBeNull()
    const [row] = await db
      .select({ detail: schema.auditLog.detail })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'contact.resumed'))
    expect(row!.detail).toEqual({ pausedFor: 'opt_out_not_recorded' })
  })

  it('keeps refusing a contact’s OWN unrecorded opt-out, whatever is on the list', async () => {
    const own = `opt-out not recorded: reply ${NOW.toISOString()} (record_failed)`
    expect(isSharedNumberOptOutPause(own)).toBe(false)
    await pauseContactOverriding(db, orgId, holderId, own, NOW)
    await addSuppression(db, { orgId, kind: 'phone', value: NUMBER, reason: 'recorded by hand', source: 'manual' })
    const r = await contactResumeByHand(db, { orgId, contact: { id: holderId }, expectedReason: own, actor: userId })
    expect(r).toMatchObject({ ok: false, reason: 'opt_out_not_recorded' })
    if (!r.ok) expect(r.message).toMatch(/This person asked to stop/)
    expect(await reasonOf()).toBe(own)
  })

  it('says, when a teammate tries to pause them over it, that the opt-out may be a shared number’s', async () => {
    await pauseContactOverriding(db, orgId, holderId, sharedNumberOptOutReason(NOW, 'suppression_failed'), NOW)
    const r = await contactPauseByHand(db, { orgId, contactId: holderId, reason: 'hold (by owner@agency.test)', now: NOW })
    expect(r).toMatchObject({ ok: false, reason: 'already_paused', pausedFor: 'opt_out_not_recorded' })
    if (!r.ok && 'message' in r) expect(r.message).toContain('a text from a number they share')
  })
})
