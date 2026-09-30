/**
 * Enrolling a campaign, against a real engine (§8.4, under §2.1, §2.2, §2.4).
 *
 * The rules are proved pure in `packages/core/test/enrolment.test.ts`. This
 * proves the wiring: that the drafts land as rows the single send path picks
 * up — never `approved` — that freshness comes from the scan's `ran_at` and
 * not from the `findings.stale` cache, that the suppression list is NOT read
 * here and IS read by the sender, and that the audit row says how many and
 * never who or what.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import {
  addSuppression, dispatchTouch, enrolCampaign, pendingDrafts, schema,
  type AgencyDb, type EnrolOutcome, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const ICP = JSON.parse(readFileSync(fileURLToPath(new URL('../seed/icp-security-gap-saas.json', import.meta.url)), 'utf8')) as {
  signals: Record<string, { weight: number; why: string }>
}
const why = (key: string): string => ICP.signals[key]!.why

/** Midday in London on a Tuesday: outside every default quiet window. */
const NOW = new Date('2026-09-15T12:00:00.000Z')
const FRESH_AT = new Date('2026-09-12T08:00:00.000Z')
/** Thirty-five days before NOW: past the seeded 14-day threshold. */
const STALE_AT = new Date('2026-08-11T08:00:00.000Z')

/** Counts, never sends. */
function countingProvider(): MessageProvider & { sent: { to: string; subject: string }[] } {
  const sent: { to: string; subject: string }[] = []
  return {
    name: 'test',
    channels: ['email', 'linkedin'],
    sent,
    async send(m) {
      sent.push({ to: m.to, subject: m.subject })
      return { providerId: `test-${sent.length}` }
    },
  }
}

describe('enrolling a campaign', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let icpProfileId: string
  let companyId: string
  let campaignId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [icp] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: 'ICP', definition: ICP, active: true })
      .returning({ id: schema.icpProfiles.id })
    icpProfileId = icp!.id
    companyId = await company('rentman.io', 'Rentman')
    campaignId = await campaign({ name: 'Q4 security gaps' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  async function company(domain: string, name: string | null, timeZone: string | null = 'Europe/London', org = orgId) {
    const [c] = await db.insert(schema.companies).values({ orgId: org, domain, name, timeZone }).returning({ id: schema.companies.id })
    return c!.id
  }

  async function campaign(over: Partial<typeof schema.campaigns.$inferInsert> = {}, org = orgId) {
    const [c] = await db
      .insert(schema.campaigns)
      .values({ orgId: org, name: 'Campaign', channel: 'email', autoSend: false, dailyCap: 25, status: 'active', ...over })
      .returning({ id: schema.campaigns.id })
    return c!.id
  }

  async function contact(over: Partial<typeof schema.contacts.$inferInsert> = {}, forCompany = companyId) {
    const [c] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId: forCompany, email: 'priya@rentman.io', timeZone: 'Europe/London', ...over })
      .returning({ id: schema.contacts.id })
    return c!.id
  }

  /**
   * One scan, its findings and the score computed from it — the shape
   * `recordScan` writes. `findings.stale` is always written false here, so a
   * test that expects `stale` can only pass by reading the scan's `ran_at`.
   */
  async function scan(
    forCompany = companyId,
    o: {
      ranAt?: Date
      ok?: boolean
      gaps?: string[]
      unobserved?: string[]
      qualified?: boolean
      disqualifiedReason?: string | null
      extra?: (typeof schema.findings.$inferInsert)[]
    } = {},
  ) {
    const ok = o.ok ?? true
    const gaps = o.gaps ?? ['csp', 'security_txt']
    const unobserved = o.unobserved ?? ['trust_page']
    const [s] = await db
      .insert(schema.scans)
      .values({ orgId, companyId: forCompany, ranAt: o.ranAt ?? FRESH_AT, ok, error: ok ? null : 'timeout' })
      .returning({ id: schema.scans.id })
    const rows = Object.entries(ICP.signals).map(([key, sig]) => {
      const observed = ok && !unobserved.includes(key)
      const gap = observed ? gaps.includes(key) : null
      return {
        orgId,
        scanId: s!.id,
        companyId: forCompany,
        signalKey: key,
        observed,
        gap,
        weight: gap ? sig.weight : 0,
        detail: gap ? `${key} missing on https://www.rentman.io/` : null,
        evidence: gap ? { url: 'https://www.rentman.io/', seen: 'absent' } : {},
        stale: false,
      }
    })
    await db.insert(schema.findings).values([...rows, ...(o.extra ?? []).map((e) => ({ ...e, scanId: s!.id }))])
    await db.insert(schema.scores).values({
      orgId,
      companyId: forCompany,
      scanId: s!.id,
      icpProfileId,
      score: o.qualified === false ? 20 : 71,
      tier: o.qualified === false ? null : 'A — call first',
      qualified: o.qualified ?? true,
      disqualifiedReason: o.disqualifiedReason ?? (ok ? null : 'unreachable (timeout)'),
    })
    return s!.id
  }

  const enrol = (over: Partial<Parameters<typeof enrolCampaign>[1]> = {}) =>
    enrolCampaign(db, { orgId, campaignId, actor: userId, senderName: 'Priya', now: NOW, ...over })

  const ok = (r: EnrolOutcome) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`)
    return r
  }

  const outbound = () => db.select().from(schema.touches).where(eq(schema.touches.direction, 'out'))

  it('writes one draft per contact, parked on a person, about the company', async () => {
    await scan()
    const a = await contact()
    const b = await contact({ email: 'sam@rentman.io', timeZone: null }) // the company's zone covers them
    const r = ok(await enrol())

    expect(r.status).toBe('awaiting_approval')
    expect(r.queued.map((q) => q.contactId).sort()).toEqual([a, b].sort())
    expect(r.skipped).toEqual([])

    const rows = await outbound()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status).toBe('awaiting_approval')
      expect(row.campaignId).toBe(campaignId)
      expect(row.companyId).toBe(companyId)
      expect(row.channel).toBe('email')
      expect(row.approvedBy).toBeNull()
      // The dispatcher writes the recipient; enrolment only names the person.
      expect(row.recipient).toBeNull()
      expect(row.subject).toContain('Rentman')
      expect(row.body).toContain('Northwind Security')
      expect(row.body).toContain('Priya')
    }
    expect(rows[0]!.body).toBe(rows[1]!.body)
    expect(r.queued.map((q) => q.touchId).sort()).toEqual(rows.map((t) => t.id).sort())

    // The approvals queue lists them with the person already named.
    const pending = await pendingDrafts(db, orgId)
    expect(pending.map((p) => p.contact?.id).sort()).toEqual([a, b].sort())
  })

  it('queues under auto-send, and never writes approved', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    await scan()
    await contact()
    const r = ok(await enrol({ campaignId: auto }))
    expect(r.status).toBe('queued')
    const rows = await outbound()
    expect(rows.map((t) => t.status)).toEqual(['queued'])
    expect(rows.some((t) => t.status === 'approved')).toBe(false)
    expect(rows[0]!.approvedBy).toBeNull()
  })

  it('writes LinkedIn drafts to the people who have a profile', async () => {
    const li = await campaign({ name: 'LinkedIn', channel: 'linkedin' })
    await scan()
    const withProfile = await contact({ email: null, linkedinUrl: 'https://www.linkedin.com/in/priya-rentman' })
    const withoutProfile = await contact({ email: 'sam@rentman.io' })
    const r = ok(await enrol({ campaignId: li }))
    expect(r.queued.map((q) => q.contactId)).toEqual([withProfile])
    expect(r.skipped).toEqual([{ companyId, contactId: withoutProfile, why: 'no_address' }])
    expect((await outbound())[0]!.channel).toBe('linkedin')
  })

  /**
   * §2.2. The `findings.stale` column is a cache as of the last scan; this
   * scan's findings all say fresh, and the scan is thirty-five days old.
   */
  it('skips a stale company even though findings.stale says fresh', async () => {
    await scan(companyId, { ranAt: STALE_AT })
    await contact()
    const flags = await db.select({ stale: schema.findings.stale }).from(schema.findings)
    expect(flags.every((f) => f.stale === false)).toBe(true)

    const r = ok(await enrol())
    expect(r.queued).toEqual([])
    expect(r.skipped).toEqual([{ companyId, contactId: null, why: 'stale' }])
    expect(await outbound()).toEqual([])
  })

  it('skips an unreachable company — nothing was observed, so nothing is written', async () => {
    await scan(companyId, { ok: false, qualified: false })
    await contact()
    const r = ok(await enrol())
    expect(r.skipped).toEqual([{ companyId, contactId: null, why: 'unreachable' }])
    expect(await outbound()).toEqual([])
  })

  it('skips each company-side reason, and a company never scanned as stale', async () => {
    const never = await company('never.io', 'Never')
    const dq = await company('vendor.io', 'Vendor')
    const low = await company('low.io', 'Low')
    const fine = await company('fine.io', 'Fine')
    const nobody = await company('nobody.io', 'Nobody')
    await scan(dq, { qualified: false, disqualifiedReason: 'Sells security themselves' })
    await scan(low, { qualified: false })
    await scan(fine, { gaps: [] })
    await scan(nobody)
    for (const c of [never, dq, low, fine]) await contact({ email: `x@${c.slice(0, 8)}.io` }, c)

    const r = ok(await enrol())
    const by = new Map(r.skipped.map((s) => [s.companyId, s]))
    expect(by.get(never)).toEqual({ companyId: never, contactId: null, why: 'stale' })
    expect(by.get(dq)?.why).toBe('disqualified')
    expect(by.get(low)?.why).toBe('not_qualified')
    expect(by.get(fine)?.why).toBe('no_evidence')
    expect(by.get(nobody)).toEqual({ companyId: nobody, contactId: null, why: 'no_contact' })
    expect(r.queued).toEqual([])
  })

  it('skips each person-side reason by name', async () => {
    await scan()
    const noAddress = await contact({ email: null, linkedinUrl: 'https://www.linkedin.com/in/x' })
    const paused = await contact({ email: 'p@rentman.io', pausedAt: NOW, pausedReason: 'replied' })
    const declined = await contact({ email: 'd@rentman.io' })
    await db.insert(schema.consents).values({ orgId, contactId: declined, channel: 'email', granted: false, source: 'said no on a call' })
    const zoneless = await company('zoneless.io', 'Zoneless', null)
    await scan(zoneless)
    const noZone = await contact({ email: 'z@zoneless.io', timeZone: null }, zoneless)
    const fine = await contact({ email: 'f@rentman.io' })

    const r = ok(await enrol())
    expect(r.queued.map((q) => q.contactId)).toEqual([fine])
    const why = Object.fromEntries(r.skipped.map((s) => [s.contactId, s.why]))
    expect(why).toEqual({ [noAddress]: 'no_address', [paused]: 'paused', [declined]: 'declined', [noZone]: 'no_timezone' })
  })

  /**
   * §2.1: suppression is checked in the send path, never in the campaign
   * builder. So the suppressed person IS enrolled — and the sender, which is
   * the one place the rule lives, refuses them without calling the provider.
   */
  it('enrols a suppressed contact, and the send path refuses them as suppressed', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    await scan()
    await contact()
    const added = await addSuppression(db, { orgId, kind: 'email', value: 'priya@rentman.io', reason: 'asked to stop', source: 'manual' })
    expect(added.ok).toBe(true)

    const r = ok(await enrol({ campaignId: auto }))
    expect(r.queued).toHaveLength(1)

    const [row] = await outbound()
    const provider = countingProvider()
    const sent = await dispatchTouch(db, provider, row!, { now: NOW })
    expect(sent.sent).toBe(false)
    expect(sent.decision).toMatchObject({ allowed: false, code: 'suppressed' })
    expect(provider.sent).toEqual([])
    const [after] = await db.select().from(schema.touches).where(eq(schema.touches.id, row!.id))
    expect(after!.status).toBe('refused')
    expect(after!.refusalCode).toBe('suppressed')
  })

  it('skips a second enrolment of the same person as already_enrolled', async () => {
    await scan()
    const a = await contact()
    ok(await enrol())
    const again = ok(await enrol())
    expect(again.queued).toEqual([])
    expect(again.skipped).toEqual([{ companyId, contactId: a, why: 'already_enrolled' }])
    expect(await outbound()).toHaveLength(1)
  })

  /**
   * The skeptic's case: a contact who was SENT the opener and did not answer
   * is not paused and has nothing live — and must not get it twice.
   */
  it('skips a person already sent to as already_contacted, and re-drafts after a refusal', async () => {
    await scan()
    const sentTo = await contact()
    const refusedOnce = await contact({ email: 'sam@rentman.io' })
    await db.insert(schema.touches).values([
      { orgId, campaignId, contactId: sentTo, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: FRESH_AT, providerId: 'p-1' },
      { orgId, campaignId, contactId: refusedOnce, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'quiet_hours' },
    ])
    const r = ok(await enrol())
    expect(r.skipped).toEqual([{ companyId, contactId: sentTo, why: 'already_contacted' }])
    expect(r.queued.map((q) => q.contactId)).toEqual([refusedOnce])
  })

  it('does not let a refused or failed earlier row block a draft a person will read', async () => {
    await scan()
    const a = await contact()
    const b = await contact({ email: 'sam@rentman.io' })
    await db.insert(schema.touches).values([
      { orgId, campaignId, contactId: a, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'needs_approval', decisionNote: 'denied' },
      { orgId, campaignId, contactId: b, companyId, channel: 'email', direction: 'out', status: 'failed', error: '421 try later' },
    ])
    const r = ok(await enrol())
    expect(r.queued.map((q) => q.contactId).sort()).toEqual([a, b].sort())
  })

  /**
   * A `failed` row is also what `recoverStuckSends` leaves when the worker
   * died mid-send — possibly delivered. With nobody reading each message,
   * queuing it again is the guess that recovery refuses to make.
   */
  it('does not re-queue a failed row under auto-send', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    await scan()
    const a = await contact()
    await db.insert(schema.touches).values({
      orgId, campaignId: auto, contactId: a, companyId, channel: 'email', direction: 'out', status: 'failed',
      error: 'The worker restarted while this was being sent.',
    })
    const r = ok(await enrol({ campaignId: auto }))
    expect(r.skipped).toEqual([{ companyId, contactId: a, why: 'already_contacted' }])
  })

  it('counts rows per campaign: the same person in another campaign is enrolled', async () => {
    await scan()
    await contact()
    ok(await enrol())
    const other = await campaign({ name: 'Other' })
    const r = ok(await enrol({ campaignId: other }))
    expect(r.queued).toHaveLength(1)
  })

  /**
   * Both enrolments read "no earlier row" before either writes, so the read
   * cannot be what stops the second — the INSERT's own NOT EXISTS must. The
   * wrapper records what each INSERT returned, so the test fails if the
   * guard is ever moved out of the statement and the race is won by luck.
   */
  it('writes one draft per person when two enrolments race, stopped by the insert itself', async () => {
    await scan()
    await contact()
    await contact({ email: 'sam@rentman.io' })
    const inserted: number[] = []
    const watched = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'execute') return Reflect.get(target, prop, receiver)
        return async (query: Parameters<AgencyDb['execute']>[0]) => {
          const res = await target.execute(query)
          inserted.push((res as unknown as { rows: unknown[] }).rows.length)
          return res
        }
      },
    })
    const race = () => enrolCampaign(watched, { orgId, campaignId, actor: userId, now: NOW })
    const [x, y] = await Promise.all([race(), race()])
    expect(ok(x!).queued.length + ok(y!).queued.length).toBe(2)
    expect([...ok(x!).skipped, ...ok(y!).skipped].map((s) => s.why)).toEqual(['already_enrolled', 'already_enrolled'])
    expect(inserted.filter((n) => n === 0)).toHaveLength(2)
    expect(await outbound()).toHaveLength(2)
  })

  it('writes nothing on a dry run, and returns the same plan with a suppression hint', async () => {
    await scan()
    const a = await contact()
    const b = await contact({ email: 'sam@rentman.io' })
    await addSuppression(db, { orgId, kind: 'email', value: 'sam@rentman.io', reason: 'asked to stop', source: 'manual' })
    const auditBefore = (await db.select().from(schema.auditLog)).length

    const dry = ok(await enrol({ dryRun: true }))
    expect(dry.dryRun).toBe(true)
    expect(dry.queued.map((q) => q.contactId).sort()).toEqual([a, b].sort())
    expect(dry.queued.every((q) => q.touchId === null)).toBe(true)
    // A hint only: the suppressed person is still in the plan.
    expect(dry.suppressedHint).toBe(1)
    expect(await outbound()).toEqual([])
    expect((await db.select().from(schema.auditLog)).length).toBe(auditBefore)

    const real = ok(await enrol())
    expect(real.suppressedHint).toBeNull()
    expect(real.queued.map((q) => q.contactId).sort()).toEqual(dry.queued.map((q) => q.contactId).sort())
  })

  it('stops at the limit, says so, and continues on the next enrolment', async () => {
    await scan()
    await contact()
    await contact({ email: 'sam@rentman.io' })
    const first = ok(await enrol({ limit: 1 }))
    expect(first.queued).toHaveLength(1)
    expect(first.truncated).toBe(true)
    const second = ok(await enrol({ limit: 1 }))
    expect(second.queued).toHaveLength(1)
    expect(second.truncated).toBe(false)
    expect(second.skipped.map((s) => s.why)).toEqual(['already_enrolled'])
    expect(await outbound()).toHaveLength(2)
  })

  it('takes the highest-scoring companies first when the limit bites', async () => {
    const low = await company('aaa.io', 'Aaa')
    await scan(low)
    await db.update(schema.scores).set({ score: 50 }).where(eq(schema.scores.companyId, low))
    await scan()
    await contact({ email: 'a@aaa.io' }, low)
    await contact()
    const r = ok(await enrol({ limit: 1 }))
    expect(r.queued.map((q) => q.companyId)).toEqual([companyId])
  })

  it('refuses a campaign marked done, one in another org, and one on a channel that is not cold', async () => {
    await scan()
    await contact()
    const done = await campaign({ name: 'Done', status: 'done' })
    expect(await enrol({ campaignId: done })).toMatchObject({ ok: false, reason: 'campaign_done' })

    const [otherOrg] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
    const theirs = await campaign({ name: 'Theirs' }, otherOrg!.id)
    expect(await enrol({ campaignId: theirs })).toMatchObject({ ok: false, reason: 'no_such_campaign' })

    const sms = await campaign({ name: 'SMS', channel: 'sms' })
    expect(await enrol({ campaignId: sms })).toMatchObject({ ok: false, reason: 'campaign_channel_unsupported' })
    expect(await outbound()).toEqual([])
  })

  it('refuses when there is no active ICP to qualify against', async () => {
    await db.update(schema.icpProfiles).set({ active: false }).where(eq(schema.icpProfiles.orgId, orgId))
    expect(await enrol()).toMatchObject({ ok: false, reason: 'no_icp' })
  })

  /**
   * §2.2. The trust page was not observed (a timeout, a WAF): its `why` must
   * not appear in the body. Nor may an informational row — observed and
   * recorded, never scored — even one that says "gap".
   */
  it('quotes only observed, scored gaps in the body', async () => {
    await scan(companyId, {
      gaps: ['csp', 'hsts'],
      unobserved: ['trust_page', 'compliance_claim'],
      extra: [
        {
          orgId, scanId: '', companyId, signalKey: 'cookie_flags', observed: true, gap: true, weight: 0,
          detail: 'session cookie without Secure', evidence: { cookie: 'sid' }, scored: false,
        },
      ],
    })
    await contact()
    ok(await enrol())
    const [row] = await outbound()
    expect(row!.body).toContain(why('csp'))
    expect(row!.body).toContain(why('hsts'))
    expect(row!.body).not.toContain(why('trust_page'))
    expect(row!.body).not.toContain(why('compliance_claim'))
    expect(row!.body).not.toContain('session cookie without Secure')
    // The ICP's own outreach rule: never send a numeric score.
    expect(row!.body).not.toMatch(/\b71\b/)
  })

  it('audits counts only — never who, and never what was said', async () => {
    await scan()
    const a = await contact()
    await contact({ email: 'p@rentman.io', pausedAt: NOW, pausedReason: 'replied' })
    await company('empty.io', 'Empty')
    ok(await enrol())

    const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'campaign.enrolled')))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subjectId).toBe(campaignId)
    expect(rows[0]!.detail).toEqual({
      campaignId,
      queued: 1,
      skipped: { paused: 1, stale: 1 },
      status: 'awaiting_approval',
      limit: 50,
      truncated: false,
    })
    const [draft] = await outbound()
    const dumped = JSON.stringify(rows)
    expect(dumped).not.toContain('priya@rentman.io')
    expect(dumped).not.toContain(a)
    expect(dumped).not.toContain(draft!.subject!)
    expect(dumped).not.toContain(why('csp'))
  })
})
