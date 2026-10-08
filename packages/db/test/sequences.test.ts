/**
 * Follow-up sequences (0024), against a real migrated database: a run starts
 * when a campaign with steps has sent its opener, drafts the next message on
 * its day as a draft for /approvals, makes call and visit tasks, and stops
 * for good the moment the person replies — and two advancers take each step
 * once. And review's three (2026-10-08): a pass reads only runs it can act
 * on, one run that throws does not stop the rest, a message step on a
 * channel a sequence cannot write on is skipped, and a stopped run puts its
 * queued or approved follow-up email back on /approvals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_FOLLOW_UP_BODY, type SequenceStep } from '@agency/core'
import {
  SEQUENCE_START_WINDOW_DAYS, advanceSequences, campaignStepsRead, campaignStepsSave, schema, sequenceRunsSummary, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const DAY = 86_400_000
const SENT = new Date('2026-10-01T09:00:00.000Z')
const at = (days: number) => new Date(SENT.getTime() + days * DAY)

describe('follow-up sequences', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let companyId: string
  let contactId: string
  let campaignId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental', phone: '+918041234567' }).returning({ id: schema.companies.id }))[0]!.id
    contactId = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'ravi@kumardental.in', firstName: 'Ravi' }).returning({ id: schema.contacts.id }))[0]!.id
    campaignId = (await db.insert(schema.campaigns).values({ orgId, name: 'Clinics in Bengaluru', channel: 'email', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted', ownerUserId: ownerId })
    // The opener, sent.
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out', status: 'sent', subject: 'A quick look at Kumar Dental',
      body: 'Hello', recipient: 'ravi@kumardental.in', sentAt: SENT, approvedBy: ownerId, approvedAt: SENT,
    })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const STEPS: SequenceStep[] = [
    { position: 2, kind: 'message', afterDays: 3, subject: null, body: DEFAULT_FOLLOW_UP_BODY },
    { position: 3, kind: 'call', afterDays: 2, subject: null, body: null },
    { position: 4, kind: 'visit', afterDays: 5, subject: null, body: null },
  ]
  const save = (steps = STEPS) => campaignStepsSave(db, { orgId, campaignId, steps, actor: ownerId })
  const run = async () => (await db.select().from(schema.sequenceRuns))[0]
  const followUps = () =>
    db.select().from(schema.touches).where(and(eq(schema.touches.campaignId, campaignId), eq(schema.touches.status, 'awaiting_approval')))

  it('saves steps by replacing them, audited by kind, and refuses a message on an SMS campaign', async () => {
    expect(await save()).toMatchObject({ ok: true })
    expect(await campaignStepsRead(db, orgId, campaignId)).toEqual(STEPS)
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'campaign.steps_saved'))
    expect(audit!.detail).toEqual({ steps: 3, messages: 1, calls: 1, visits: 1 })
    expect(await save([{ ...STEPS[0]!, position: 3 }])).toMatchObject({ ok: false, reason: 'invalid' })
    const sms = (await db.insert(schema.campaigns).values({ orgId, name: 'Texts', channel: 'sms', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
    expect(await campaignStepsSave(db, { orgId, campaignId: sms, steps: STEPS, actor: ownerId })).toMatchObject({ ok: false, reason: 'channel' })
    expect(await campaignStepsSave(db, { orgId, campaignId: sms, steps: [{ ...STEPS[1]!, position: 2 }], actor: ownerId })).toMatchObject({ ok: true })
  })

  it('starts when the opener has gone, drafts the follow-up on its day, then a call and a visit, then finishes', async () => {
    await save()
    // A run with nothing to do yet is not even read: `waiting` counts only runs a pass read and could not move.
    expect(await advanceSequences(db, { now: at(1) })).toMatchObject({ started: 1, messages: 0, waiting: 0, failed: 0 })
    expect(await followUps()).toEqual([])

    expect(await advanceSequences(db, { now: at(3) })).toMatchObject({ started: 0, messages: 1 })
    const [draft] = await followUps()
    expect(draft).toMatchObject({ channel: 'email', contactId, companyId, subject: 'Re: A quick look at Kumar Dental' })
    expect(draft!.body).toMatch(/^Hi Ravi,/)
    expect(draft!.body).toMatch(/Accemy$/)

    // The call waits for the follow-up to GO, then counts two days from then.
    expect(await advanceSequences(db, { now: at(9) })).toMatchObject({ tasks: 0, waiting: 0 })
    await db.update(schema.touches).set({ status: 'sent', sentAt: at(10), approvedBy: ownerId, approvedAt: at(10) }).where(eq(schema.touches.id, draft!.id))
    expect(await advanceSequences(db, { now: at(11) })).toMatchObject({ tasks: 0, waiting: 1 })
    expect(await advanceSequences(db, { now: at(12) })).toMatchObject({ tasks: 1 })
    const [call] = await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'call'))
    expect(call).toMatchObject({ title: 'Call Ravi at Kumar Dental — follow-up step 3', assigneeUserId: ownerId })

    expect(await advanceSequences(db, { now: at(17) })).toMatchObject({ tasks: 1 })
    expect(await advanceSequences(db, { now: at(30) })).toMatchObject({ stopped: { finished: 1 } })
    expect(await sequenceRunsSummary(db, orgId, campaignId)).toMatchObject({ live: 0, stopped: { finished: 1 } })
  })

  it('stops for good the moment they reply — even a reply that came before the run existed — but not for an auto-reply', async () => {
    await save()
    await db.insert(schema.touches).values({ orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', body: 'Out of office', replyKind: 'auto_reply', createdAt: at(1) })
    await advanceSequences(db, { now: at(2) })
    expect((await run())!.stoppedAt).toBeNull()
    await db.insert(schema.touches).values({ orgId, contactId, companyId, channel: 'email', direction: 'in', status: 'replied', body: 'Interested', replyKind: 'interested', createdAt: at(2) })
    expect(await advanceSequences(db, { now: at(5) })).toMatchObject({ messages: 0, stopped: { replied: 1 } })
    expect(await followUps()).toEqual([])
    expect((await run())).toMatchObject({ stopReason: 'replied' })
  })

  it('stops when a follow-up is refused, the person is paused or the deal closes; waits while the campaign is paused', async () => {
    await save()
    await advanceSequences(db, { now: at(3) })
    const [draft] = await followUps()
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
    await db.update(schema.touches).set({ status: 'sent', sentAt: at(4), approvedBy: ownerId, approvedAt: at(4) }).where(eq(schema.touches.id, draft!.id))
    expect(await advanceSequences(db, { now: at(20) })).toMatchObject({ tasks: 0, waiting: 1 })
    await db.update(schema.campaigns).set({ status: 'active' }).where(eq(schema.campaigns.id, campaignId))
    await db.update(schema.deals).set({ stage: 'lost', closedAt: at(20), lostReason: 'Chose someone else' }).where(eq(schema.deals.companyId, companyId))
    expect(await advanceSequences(db, { now: at(21) })).toMatchObject({ stopped: { deal_closed: 1 } })
  })

  it('stops when the follow-up did not go', async () => {
    await save()
    await advanceSequences(db, { now: at(3) })
    const [draft] = await followUps()
    await db.update(schema.touches).set({ status: 'refused', refusalCode: 'needs_approval', error: 'Denied' }).where(eq(schema.touches.id, draft!.id))
    expect(await advanceSequences(db, { now: at(4) })).toMatchObject({ stopped: { refused: 1 } })
  })

  it('skips a call step with no number to call, and moves on', async () => {
    await db.update(schema.companies).set({ phone: null }).where(eq(schema.companies.id, companyId))
    await save([{ position: 2, kind: 'call', afterDays: 1, subject: null, body: null }, { position: 3, kind: 'visit', afterDays: 1, subject: null, body: null }])
    expect(await advanceSequences(db, { now: at(2) })).toMatchObject({ tasks: 0, skipped: 1 })
    const [skip] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'sequence.step_skipped'))
    expect(skip!.detail).toMatchObject({ position: 2, kind: 'call', why: 'invalid' })
    expect(await advanceSequences(db, { now: at(4) })).toMatchObject({ tasks: 1 })
  })

  it('takes each step once when two advancers run, and wakes nobody whose opener is older than its window', async () => {
    await save()
    await advanceSequences(db, { now: at(1) })
    const [a, b] = await Promise.all([advanceSequences(db, { now: at(3) }), advanceSequences(db, { now: at(3) })])
    expect(a.messages + b.messages).toBe(1)
    expect(await followUps()).toHaveLength(1)

    const old = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'old@kumardental.in' }).returning({ id: schema.contacts.id }))[0]!.id
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId: old, companyId, channel: 'email', direction: 'out', status: 'sent', subject: 'Hi', body: 'Hello',
      recipient: 'old@kumardental.in', sentAt: at(-SEQUENCE_START_WINDOW_DAYS - 2), approvedBy: ownerId, approvedAt: at(-40),
    })
    expect(await advanceSequences(db, { now: at(3) })).toMatchObject({ started: 0 })
  })

  const secondContact = async (email: string, sentAt: Date) => {
    const id = (await db.insert(schema.contacts).values({ orgId, companyId, email, firstName: 'Asha' }).returning({ id: schema.contacts.id }))[0]!.id
    await db.insert(schema.touches).values({
      orgId, campaignId, contactId: id, companyId, channel: 'email', direction: 'out', status: 'sent', subject: 'Hello', body: 'Hello',
      recipient: email, sentAt, approvedBy: ownerId, approvedAt: sentAt,
    })
    return id
  }

  it('reads only runs it can act on, so runs waiting on drafts nobody approved never crowd out a run that is due', async () => {
    await save()
    await advanceSequences(db, { now: at(3) })
    expect(await followUps()).toHaveLength(1) // Ravi's follow-up now waits on /approvals, with the oldest anchor.
    const asha = await secondContact('asha@kumardental.in', at(1))
    await advanceSequences(db, { now: at(2) }) // Asha's run starts.
    // One run a pass: the first version read Ravi's (oldest, waiting) every time and never reached Asha's.
    expect(await advanceSequences(db, { now: at(5), limit: 1 })).toMatchObject({ messages: 1 })
    const drafts = await followUps()
    expect(drafts.map((d) => d.contactId).sort()).toEqual([contactId, asha].sort())
  })

  it('goes on past a run that throws, and says which', async () => {
    await save()
    const asha = await secondContact('asha@kumardental.in', SENT)
    await advanceSequences(db, { now: at(1) })
    // A fault on one person's insert, made by hand: the other's follow-up is still drafted.
    await test.pg.exec(`
      CREATE FUNCTION refuse_one() RETURNS trigger AS $$
      BEGIN IF NEW.contact_id = '${contactId}' AND NEW.direction = 'out' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_one BEFORE INSERT ON touches FOR EACH ROW EXECUTE FUNCTION refuse_one();`)
    const ravisRun = (await db.select().from(schema.sequenceRuns).where(eq(schema.sequenceRuns.contactId, contactId)))[0]!
    const r = await advanceSequences(db, { now: at(3) })
    expect(r).toMatchObject({ messages: 1, failed: 1 })
    expect(r.faults).toEqual([{ runId: ravisRun.id, error: expect.any(String) }])
    expect((await followUps()).map((d) => d.contactId)).toEqual([asha])
    // Left as it was: the next pass, with the fault gone, takes the step.
    expect((await db.select().from(schema.sequenceRuns).where(eq(schema.sequenceRuns.id, ravisRun.id)))[0]!.nextPosition).toBe(2)
    await test.pg.exec('DROP TRIGGER refuse_one ON touches')
    expect(await advanceSequences(db, { now: at(3) })).toMatchObject({ messages: 1, failed: 0 })
  })

  it('skips a message step once the campaign sends on a channel a sequence cannot write on, and moves on', async () => {
    await save()
    await advanceSequences(db, { now: at(1) })
    await db.update(schema.campaigns).set({ channel: 'sms' }).where(eq(schema.campaigns.id, campaignId))
    expect(await advanceSequences(db, { now: at(3) })).toMatchObject({ messages: 0, skipped: 1, failed: 0 })
    expect(await db.select().from(schema.touches).where(eq(schema.touches.channel, 'sms'))).toEqual([])
    const [skip] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'sequence.step_skipped'))
    expect(skip!.detail).toMatchObject({ position: 2, kind: 'message', why: 'channel' })
    expect((await run())!.nextPosition).toBe(3)
  })

  it('puts a queued or approved follow-up email back on /approvals when the run stops — never a LinkedIn step', async () => {
    await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
    await save()
    await advanceSequences(db, { now: at(3) })
    const [queued] = await db.select().from(schema.touches).where(and(eq(schema.touches.campaignId, campaignId), eq(schema.touches.status, 'queued')))
    expect(queued).toBeDefined()
    await db.update(schema.deals).set({ stage: 'won', closedAt: at(3) }).where(eq(schema.deals.companyId, companyId))
    expect(await advanceSequences(db, { now: at(4) })).toMatchObject({ stopped: { deal_closed: 1 }, returned: 1 })
    expect((await db.select().from(schema.touches).where(eq(schema.touches.id, queued!.id)))[0]).toMatchObject({
      status: 'awaiting_approval', approvedBy: null, approvedAt: null, scheduledFor: null,
    })
    const [stop] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'sequence.stopped'))
    expect(stop!.detail).toMatchObject({ reason: 'deal_closed', returnedTouchId: queued!.id })
  })

  it('clears the approver of an approved follow-up it puts back, and leaves a LinkedIn step where a person may be holding it', async () => {
    await save()
    await advanceSequences(db, { now: at(3) })
    const [draft] = await followUps()
    await db.update(schema.touches).set({ status: 'approved', approvedBy: ownerId, approvedAt: at(3), scheduledFor: at(4) }).where(eq(schema.touches.id, draft!.id))
    await db.update(schema.campaigns).set({ status: 'done' }).where(eq(schema.campaigns.id, campaignId))
    expect(await advanceSequences(db, { now: at(4) })).toMatchObject({ stopped: { campaign_ended: 1 }, returned: 1 })
    expect((await db.select().from(schema.touches).where(eq(schema.touches.id, draft!.id)))[0]).toMatchObject({
      status: 'awaiting_approval', approvedBy: null, approvedAt: null, scheduledFor: null,
    })

    // The same stop on a LinkedIn campaign leaves its approved step alone.
    const li = (await db.insert(schema.campaigns).values({ orgId, name: 'LinkedIn', channel: 'linkedin', status: 'active' }).returning({ id: schema.campaigns.id }))[0]!.id
    await campaignStepsSave(db, { orgId, campaignId: li, steps: [STEPS[0]!], actor: ownerId })
    await db.update(schema.contacts).set({ linkedinUrl: 'https://www.linkedin.com/in/ravi-kumar' }).where(eq(schema.contacts.id, contactId))
    await db.insert(schema.touches).values({
      orgId, campaignId: li, contactId, companyId, channel: 'linkedin', direction: 'out', status: 'sent', body: 'Hello',
      recipient: 'in/ravi-kumar', sentAt: at(4), approvedBy: ownerId, approvedAt: at(4),
    })
    await advanceSequences(db, { now: at(8) })
    const [step] = await db.select().from(schema.touches).where(and(eq(schema.touches.campaignId, li), eq(schema.touches.status, 'awaiting_approval')))
    await db.update(schema.touches).set({ status: 'approved', approvedBy: ownerId, approvedAt: at(8) }).where(eq(schema.touches.id, step!.id))
    await db.update(schema.campaigns).set({ status: 'done' }).where(eq(schema.campaigns.id, li))
    expect(await advanceSequences(db, { now: at(9) })).toMatchObject({ stopped: { campaign_ended: 1 }, returned: 0 })
    expect((await db.select().from(schema.touches).where(eq(schema.touches.id, step!.id)))[0]!.status).toBe('approved')
  })
})
