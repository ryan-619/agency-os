/**
 * `POST /api/contacts/[id]/sms`'s own call (`smsComposerAnswer`), against a
 * real database: the composer's Check and its Draft are one function,
 * `smsDraft` — with `dryRun: true` for Check — so they cannot disagree.
 *
 * Check used to be a restatement of smsDraft's checks in the route, and it
 * skipped two: a paused campaign and an SMS already waiting. Check then
 * enabled Draft, and Draft answered 409. And a database fault escaped the
 * route whole, which put drizzle's message — every bound parameter, the
 * number and the words — in the platform log.
 *
 * The route itself reaches `server-only` and is pinned by reading its source.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schema, type AgencyDb } from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  SMS_FAULT, smsComposerAnswer, smsDryRunAnswer, smsRenderAnswer, type ComposerLog, type SmsDraftInput,
} from '../src/app/api/contacts/[id]/sms/outcome'
import { atSending, checkLine, holdLine, type CheckAnswer } from '../src/components/contacts/sms-composer'
import { DEFERRED_CODES } from '../src/lib/approval-view'

const PHONE = '+919876543210'
const BODY = 'Hi {#var#}, your call with Acme is at {#var#}. Reply STOP to opt out.'
/** Noon in India. */
const NOON_IST = new Date('2026-09-15T06:30:00.000Z')
/** 23:00 in India: the campaign's own quiet hours. */
const NIGHT_IST = new Date('2026-09-15T17:30:00.000Z')

describe('POST /api/contacts/[id]/sms — Check and Draft are one function', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let contactId: string
  let campaignId: string
  let templateId: string
  let lines: { message: string; fields: Record<string, unknown> }[]
  const log: ComposerLog = { error: (message, fields = {}) => lines.push({ message, fields }) }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.in', timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.companies.id })
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: company!.id, firstName: 'Priya', phone: PHONE, timeZone: 'Asia/Kolkata' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    await db.insert(schema.consents).values({ orgId, contactId, channel: 'sms', granted: true, source: 'booking form' })
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Meeting reminders', channel: 'sms', autoSend: false, dailyCap: 50, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
    const [template] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', body: BODY })
      .returning({ id: schema.messageTemplates.id })
    templateId = template!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ask = (dryRun: boolean, over: Partial<SmsDraftInput> = {}, now = NOON_IST, on: AgencyDb = db) =>
    smsComposerAnswer(
      on,
      { orgId, contactId, createdBy: userId, input: { campaignId, templateId, vars: ['Priya', '3pm'], dryRun, ...over }, now, nothingWillSend: null },
      log,
    )
  const outbound = async () => (await db.select().from(schema.touches)).filter((t) => t.direction === 'out')

  it('checks the words and the send path’s decision, and writes nothing', async () => {
    const check = await ask(true)
    expect(check).toEqual({
      status: 200,
      body: {
        rendered: true,
        body: 'Hi Priya, your call with Acme is at 3pm. Reply STOP to opt out.',
        decision: { allowed: true, code: 'send_now' },
        wouldNeedApproval: true,
        blocked: false,
      },
    })
    expect(await outbound()).toHaveLength(0)
    expect((await db.select().from(schema.auditLog)).filter((a) => a.action === 'sms.drafted')).toHaveLength(0)
  })

  it('refuses a campaign paused since the page loaded exactly as Draft does — never an enabled Draft that then answers 409', async () => {
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, campaignId))
    const check = await ask(true)
    expect(check).toMatchObject({ status: 409, body: { reason: 'campaign_not_active' } })
    expect(check).toEqual(await ask(false))
    expect(await outbound()).toHaveLength(0)
  })

  it('refuses a second SMS while one is waiting exactly as Draft does', async () => {
    expect((await ask(false)).status).toBe(201)
    const check = await ask(true)
    expect(check).toEqual({
      status: 409,
      body: { error: 'An SMS to this contact under this campaign is already waiting to be approved or sent.', reason: 'already_queued' },
    })
    expect(check).toEqual(await ask(false))
    expect(await outbound()).toHaveLength(1)
  })

  it('answers a refusal nobody may approve past as a blocked check, and Draft refuses it by its code', async () => {
    await db.delete(schema.consents).where(eq(schema.consents.contactId, contactId))
    expect(await ask(true)).toMatchObject({
      status: 200,
      body: { blocked: true, decision: { allowed: false, code: 'cold_channel_forbidden', humanCanResolve: false } },
    })
    expect(await ask(false)).toMatchObject({ status: 409, body: { reason: 'refused', code: 'cold_channel_forbidden' } })
  })

  it('answers a hold a person can resolve as an open check, and Draft writes it reporting the hold', async () => {
    expect(await ask(true, {}, NIGHT_IST)).toMatchObject({ status: 200, body: { blocked: false, decision: { code: 'quiet_hours' } } })
    expect(await ask(false, {}, NIGHT_IST)).toMatchObject({ status: 201, body: { wouldHold: { code: 'quiet_hours' } } })
  })

  it('answers values that do not render as the answer to the question, saying once that nothing was drafted', async () => {
    const check = await ask(true, { vars: ['Priya'] })
    expect(check).toMatchObject({ status: 200, body: { rendered: false, slot: 2 } })
    const said = String(check.body.error)
    expect(said.match(/Nothing was drafted\./g)).toHaveLength(1)
    expect(await ask(false, { vars: ['Priya'] })).toMatchObject({ status: 422, body: { reason: 'render_failed', slot: 2, error: said } })
  })

  it('says why a contact with no readable number cannot be texted — smsDraft’s own sentence, for Check and Draft alike', async () => {
    await db.update(schema.contacts).set({ phone: '98765 43210' }).where(eq(schema.contacts.id, contactId))
    const check = await ask(true)
    expect(check).toMatchObject({ status: 409, body: { reason: 'no_phone' } })
    expect(String(check.body.error)).toContain('no phone number in international form')
    expect(check).toEqual(await ask(false))
  })

  /** drizzle's message quotes every bound parameter; Next would log an escaping error whole. */
  it.each([true, false])('answers a database fault 500 and logs its class only (dryRun %s)', async (dryRun) => {
    class DrizzleQueryError extends Error {
      override name = 'DrizzleQueryError'
    }
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' || prop === 'transaction') {
          return () => {
            throw new DrizzleQueryError(`Failed query: insert into "touches" … params: ${orgId},sms,out,Hi Priya-DECOY,${PHONE}`)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const answer = await ask(dryRun, { vars: ['Priya-DECOY', '3pm'] }, NOON_IST, broken)
    expect(answer).toEqual({ status: 500, body: { error: SMS_FAULT } })
    expect(lines).toEqual([
      { message: dryRun ? 'SMS check could not be run' : 'SMS draft could not be written', fields: { error: 'DrizzleQueryError' } },
    ])
    const all = JSON.stringify({ answer, lines })
    expect(all).not.toContain('DECOY')
    expect(all).not.toContain('9876543210')
  })
})

describe('the dry run on the wire', () => {
  it('answers each of smsDraft’s refusals as a draft’s would be, and a render failure as the answer', () => {
    expect(smsDryRunAnswer({ ok: false, reason: 'campaign_not_active', message: 'That campaign is paused.' })).toEqual({
      status: 409, body: { error: 'That campaign is paused.', reason: 'campaign_not_active' },
    })
    expect(smsDryRunAnswer({ ok: false, reason: 'render_failed', slot: 1, message: 'Variable 1: blank. Nothing was drafted.' })).toEqual({
      status: 200, body: { rendered: false, error: 'Variable 1: blank. Nothing was drafted.', slot: 1 },
    })
    // The renderer's own sentence still gains it.
    expect(smsRenderAnswer({ message: 'Variable 1: blank.' }).body.error).toBe('Variable 1: blank. Nothing was drafted.')
  })
})

describe('the route is the session and one call', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/app/api/contacts/[id]/sms/route.ts', import.meta.url)), 'utf8')

  it('asks campaigns:write before it reads anything, then hands Check and Draft to the same call', () => {
    expect(src.indexOf("'campaigns:write'")).toBeLessThan(src.indexOf('request.text()'))
    expect(src).toContain('smsComposerAnswer(')
    // No second copy of smsDraft's checks to drift from it.
    expect(src).not.toMatch(/previewSend\(|renderTemplate\(|readCampaign\(|templatesList\(|smsDraft\(/)
  })
})

/**
 * What the composer says the worker would do. Only the clock's refusals are
 * held at sending; a contact with no timezone is refused for good. It said
 * "would wait" for both, and an approver who believed it approved an SMS
 * that never went.
 */
describe('what the composer says the worker would do', () => {
  const answer = (code: string, humanCanResolve: boolean): CheckAnswer => ({
    rendered: true,
    body: 'Hi',
    blocked: !humanCanResolve,
    wouldNeedApproval: true,
    decision: { allowed: false, code, reason: 'The rule says so.', humanCanResolve },
  })

  it('holds only the clock’s refusals — the worker’s own deferred codes', () => {
    for (const code of ['quiet_hours', 'daily_cap', 'campaign_inactive']) expect(atSending(code)).toBe('held')
    for (const code of ['unknown_timezone', 'unparseable_recipient', 'bounced', 'stale_evidence']) expect(atSending(code)).toBe('refused')
    expect([...DEFERRED_CODES].sort()).toEqual(['campaign_inactive', 'daily_cap', 'quiet_hours'])
  })

  it('says a draft would wait only where the worker waits', () => {
    expect(holdLine({ code: 'quiet_hours', reason: 'It is 23:00 where they are.' })).toBe(
      'If it were approved right now it would wait: It is 23:00 where they are.',
    )
    const tz = holdLine({ code: 'unknown_timezone', reason: 'This contact has no timezone, so quiet hours cannot be checked.' })
    expect(tz).toBe(
      'If it were approved right now it would be refused at sending: This contact has no timezone, so quiet hours cannot be checked — fix it before approving.',
    )
    expect(tz).not.toContain('wait')
  })

  it('says under Check what a draft would meet at sending, keeping Draft as humanCanResolve says', () => {
    expect(checkLine(answer('quiet_hours', true))).toMatch(/A person can resolve this\. If it were approved now, the worker would hold it and try again later\.$/)
    expect(checkLine(answer('unknown_timezone', true))).toMatch(
      /A person can resolve this\. The worker would refuse it at sending as things stand — fix it before drafting\.$/,
    )
    expect(checkLine(answer('suppressed', false))).toMatch(/Nobody may approve past this\. The draft is not offered\.$/)
    expect(checkLine({ rendered: true, body: 'Hi', blocked: false, wouldNeedApproval: true, decision: { allowed: true, code: 'send_now' } })).toBe(
      'Nothing stops a message to them under this campaign right now. It would still wait for a person to approve it.',
    )
  })

  it('renders those lines, and no other "would wait"', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/contacts/sms-composer.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('{checkLine(current.answer)}')
    expect(src).toContain('lines.push(holdLine(')
    // The old line said "would wait" for every resolvable refusal.
    expect(src).not.toContain('lines.push(`If it were approved right now it would wait')
  })
})
