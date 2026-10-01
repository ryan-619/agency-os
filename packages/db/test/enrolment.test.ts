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
import { draftInputFromFindings, parseIcpDefinition } from '@agency/core'
import {
  addSuppression, denyDraft, dispatchTouch, enrolCampaign, latestScanWithFindings, pendingDrafts, recordScan, schema,
  type AgencyDb, type EnrolOutcome, type MessageProvider,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'
// The scanner's own extractor and recordings, by path, as repository.test.ts
// reads them: packages/db does not depend on the scanner, and only the
// real-rows test below needs a REAL profile.
import { extractProfile } from '../../scanner/src/extract.js'
import { loadFixture } from '../../scanner/test/fixtures.js'

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

  /**
   * `db`, with every draft INSERT handed to `before` first and the number of
   * rows it returned recorded. `insertDraft` runs its INSERT on a
   * transaction's handle, after the per-person lock (r4, review round 3,
   * finding 10), so the handle is what is wrapped, and the lock's own SELECT
   * is not counted. `before` gets that handle: on PGlite a write through the
   * outer `db` would wait for the open transaction for ever.
   */
  const watchInserts = (before: (tx: AgencyDb, text: string) => Promise<void> = async () => {}) => {
    const inserted: number[] = []
    const wrap = (target: AgencyDb): AgencyDb =>
      new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'transaction') {
            return (fn: (tx: AgencyDb) => Promise<unknown>) => t.transaction((tx) => fn(wrap(tx as unknown as AgencyDb)))
          }
          if (prop !== 'execute') return Reflect.get(t, prop, receiver)
          return async (query: Parameters<AgencyDb['execute']>[0]) => {
            const text = JSON.stringify(query)
            const isInsert = text.includes('INSERT INTO touches')
            if (isInsert) await before(t, text)
            const res = await t.execute(query)
            if (isInsert) inserted.push((res as unknown as { rows: unknown[] }).rows.length)
            return res
          }
        },
      })
    return { db: wrap(db), inserted }
  }

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

  it('does not let a failed row, or a refusal a correction resolves, block a draft a person will read', async () => {
    await scan()
    const a = await contact()
    const b = await contact({ email: 'sam@rentman.io' })
    await db.insert(schema.touches).values([
      { orgId, campaignId, contactId: a, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'unparseable_recipient' },
      { orgId, campaignId, contactId: b, companyId, channel: 'email', direction: 'out', status: 'failed', error: '421 try later' },
    ])
    const r = ok(await enrol())
    expect(r.queued.map((q) => q.contactId).sort()).toEqual([a, b].sort())
  })

  /**
   * The review's case, end to end. A campaign runs supervised and a person
   * denies a draft (`denyDraft`: `refused`, `needs_approval`). Enrolling again
   * must not put the same words back in front of them — and once the
   * campaign is switched to auto-send, must not queue them for the worker to
   * mail with nobody reading, which is what it used to do.
   */
  it('never brings back a draft a person denied, supervised or after switching to auto-send', async () => {
    await scan()
    const jane = await contact()
    const first = ok(await enrol())
    // Denied at NOW, while the scan the words quote is fresh: a person's no. (A
    // deny judged at the machine's clock would find that scan stale, and record
    // the refusal a re-scan resolves — the test below.)
    const denied = await denyDraft(db, { orgId, touchId: first.queued[0]!.touchId!, decidedBy: userId, note: 'not this one', now: NOW })
    expect(denied.ok).toBe(true)

    const again = ok(await enrol())
    expect(again.queued).toEqual([])
    expect(again.skipped).toEqual([{ companyId, contactId: jane, why: 'already_contacted' }])

    await db.update(schema.campaigns).set({ autoSend: true }).where(eq(schema.campaigns.id, campaignId))
    const auto = ok(await enrol())
    expect(auto.status).toBe('queued')
    expect(auto.queued).toEqual([])
    expect(auto.skipped).toEqual([{ companyId, contactId: jane, why: 'already_contacted' }])
    expect((await outbound()).map((t) => [t.status, t.refusalCode])).toEqual([['refused', 'needs_approval']])
  })

  /**
   * The recipient's own no: a reply that cancelled what was queued
   * (`consent_revoked`) and an opt-out (`suppressed`). A bounce refused
   * earlier is about an address, and its mark has since been cleared — so
   * that person IS drafted again, to the corrected address.
   */
  it('does not re-queue after a reply cancelled the row or the person opted out, under auto-send', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    await scan()
    const replied = await contact()
    const optedOut = await contact({ email: 'sam@rentman.io' })
    const corrected = await contact({ email: 'lee@rentman.io' })
    await db.insert(schema.touches).values([
      { orgId, campaignId: auto, contactId: replied, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'consent_revoked' },
      { orgId, campaignId: auto, contactId: optedOut, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed' },
      { orgId, campaignId: auto, contactId: corrected, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'bounced' },
    ])
    const r = ok(await enrol({ campaignId: auto }))
    expect(Object.fromEntries(r.skipped.map((s) => [s.contactId, s.why]))).toEqual({
      [replied]: 'already_contacted',
      [optedOut]: 'already_contacted',
    })
    expect(r.queued.map((q) => q.contactId)).toEqual([corrected])
  })

  /**
   * The review's case, end to end. A teammate paused Jane "on leave until
   * October", and the tick refused her queued opener — as `consent_revoked`
   * before a pause had its own code, which enrolment reads as her own no: once
   * she was resumed, every enrolment skipped her as already_contacted, and
   * under auto-send on every campaign on the channel. Found by review. The
   * sender now refuses it as `paused`, which a lifted pause does not keep.
   */
  it('drafts a person again once the pause that refused their queued opener is lifted', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    await scan()
    const jane = await contact()
    const first = ok(await enrol({ campaignId: auto }))
    expect(first.queued.map((q) => q.contactId)).toEqual([jane])

    await db
      .update(schema.contacts)
      .set({ pausedAt: NOW, pausedReason: 'on leave until October (by sam@agency.test)' })
      .where(eq(schema.contacts.id, jane))
    const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, first.queued[0]!.touchId!))
    const provider = countingProvider()
    const refused = await dispatchTouch(db, provider, row!, { now: NOW })
    expect(refused.decision).toMatchObject({ allowed: false, code: 'paused' })
    expect(provider.sent).toEqual([])
    expect((await outbound()).map((t) => [t.status, t.refusalCode])).toEqual([['refused', 'paused']])

    // While the pause stands she is skipped for it, before any row is read.
    expect(ok(await enrol({ campaignId: auto })).skipped).toEqual([{ companyId, contactId: jane, why: 'paused' }])

    // A person lifts it; the refused row stops nothing, in this campaign or another on the channel.
    await db.update(schema.contacts).set({ pausedAt: null, pausedReason: null }).where(eq(schema.contacts.id, jane))
    const other = await campaign({ name: 'Auto B', autoSend: true })
    expect(ok(await enrol({ campaignId: other })).queued.map((q) => q.contactId)).toEqual([jane])
  })

  /**
   * The review's other case. A supervised draft that went stale while it
   * waited is blocked on /approvals with "deny it, re-scan the company, then
   * draft it again" — and denying it wrote `needs_approval`, a person's no,
   * so after the re-scan enrolment still skipped them as already contacted.
   * Found by review. Denied on stale evidence, the row says so, and a
   * re-scan resolves it.
   */
  it('drafts a person again after a draft denied on stale evidence, once the company is re-scanned', async () => {
    await scan()
    const jane = await contact()
    const first = ok(await enrol())
    const draftId = first.queued[0]!.touchId!
    // Written at NOW, from the FRESH_AT scan — pinned, rather than the clock the insert ran at.
    await db.update(schema.touches).set({ createdAt: NOW }).where(eq(schema.touches.id, draftId))

    const later = new Date(NOW.getTime() + 16 * 86_400_000)
    const denied = await denyDraft(db, { orgId, touchId: draftId, decidedBy: userId, note: 'stale', now: later })
    expect(denied.ok).toBe(true)
    expect((await outbound()).map((t) => [t.status, t.refusalCode])).toEqual([['refused', 'stale_evidence']])
    const audit = (await db.select().from(schema.auditLog)).find((a) => a.action === 'draft.denied')
    expect(audit?.detail).toMatchObject({ note: 'stale', refusalCode: 'stale_evidence' })

    // Not before the re-scan: the company itself is stale.
    expect(ok(await enrol({ now: later })).skipped).toEqual([{ companyId, contactId: null, why: 'stale' }])

    await scan(companyId, { ranAt: new Date(later.getTime() - 3_600_000) })
    const again = ok(await enrol({ now: later }))
    expect(again.queued.map((q) => q.contactId)).toEqual([jane])
  })

  it('still records a person’s no when the draft they denied was not stale', async () => {
    await scan()
    await contact()
    const first = ok(await enrol())
    await db.update(schema.touches).set({ createdAt: NOW }).where(eq(schema.touches.id, first.queued[0]!.touchId!))
    const denied = await denyDraft(db, { orgId, touchId: first.queued[0]!.touchId!, decidedBy: userId, now: NOW })
    expect(denied.ok).toBe(true)
    expect((await outbound()).map((t) => t.refusalCode)).toEqual(['needs_approval'])
    const audit = (await db.select().from(schema.auditLog)).find((a) => a.action === 'draft.denied')
    expect(audit?.detail).toMatchObject({ refusalCode: 'needs_approval' })
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
   * Under auto-send nobody reads the words, and they depend only on the
   * company, the ICP, the agency and the sender — so campaign B would mail
   * exactly what campaign A already sent. An auto-send enrolment reads every
   * campaign's rows on its channel; a supervised one still reads its own,
   * because a person reads each draft before anything leaves.
   */
  it('under auto-send, skips a person any campaign on the channel already wrote to', async () => {
    await scan()
    const sentTo = await contact()
    const sending = await contact({ email: 'sam@rentman.io' })
    const waiting = await contact({ email: 'lee@rentman.io' })
    const onLinkedIn = await contact({ email: 'kim@rentman.io' })
    const other = await campaign({ name: 'Other' })
    const li = await campaign({ name: 'LinkedIn', channel: 'linkedin' })
    await db.insert(schema.touches).values([
      { orgId, campaignId: other, contactId: sentTo, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: FRESH_AT, providerId: 'p-1' },
      { orgId, campaignId: other, contactId: sending, companyId, channel: 'email', direction: 'out', status: 'sending' },
      { orgId, campaignId: other, contactId: waiting, companyId, channel: 'email', direction: 'out', status: 'awaiting_approval' },
      { orgId, campaignId: li, contactId: onLinkedIn, companyId, channel: 'linkedin', direction: 'out', status: 'sent', sentAt: FRESH_AT, providerId: 'human:x' },
    ])

    const auto = await campaign({ name: 'Auto', autoSend: true })
    const r = ok(await enrol({ campaignId: auto }))
    expect(Object.fromEntries(r.skipped.map((s) => [s.contactId, s.why]))).toEqual({
      [sentTo]: 'already_contacted',
      [sending]: 'already_contacted',
      [waiting]: 'already_enrolled',
    })
    // A message on another channel is not the same opener.
    expect(r.queued.map((q) => q.contactId)).toEqual([onLinkedIn])

    const supervised = ok(await enrol())
    expect(supervised.queued.map((q) => q.contactId).sort()).toEqual([sentTo, sending, waiting, onLinkedIn].sort())
  })

  /**
   * The read names the skip; the INSERT's own NOT EXISTS is what a race
   * cannot get past. Each row here lands AFTER the read and before the insert
   * — the wrapper writes it on the way into `execute` — so only the statement
   * can stop the draft, and the second read names why.
   */
  it('stops a draft in the insert itself when a row that counts lands after the read', async () => {
    const auto = await campaign({ name: 'Auto', autoSend: true })
    const other = await campaign({ name: 'Other' })
    await scan()
    const denied = await contact()
    const sentElsewhere = await contact({ email: 'sam@rentman.io' })
    const clockOnly = await contact({ email: 'lee@rentman.io' })
    const landing: Record<string, typeof schema.touches.$inferInsert> = {
      [denied]: { orgId, campaignId: auto, contactId: denied, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'needs_approval' },
      [sentElsewhere]: { orgId, campaignId: other, contactId: sentElsewhere, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: FRESH_AT, providerId: 'p-9' },
      [clockOnly]: { orgId, campaignId: auto, contactId: clockOnly, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'quiet_hours' },
    }
    const { db: watched, inserted } = watchInserts(async (tx, text) => {
      const who = Object.keys(landing).find((id) => text.includes(id))
      if (who) {
        await tx.insert(schema.touches).values(landing[who]!)
        delete landing[who]
      }
    })
    const r = ok(await enrolCampaign(watched, { orgId, campaignId: auto, actor: userId, now: NOW }))
    expect(Object.keys(landing)).toEqual([])
    expect(Object.fromEntries(r.skipped.map((s) => [s.contactId, s.why]))).toEqual({
      [denied]: 'already_contacted',
      [sentElsewhere]: 'already_contacted',
    })
    // A deferral nobody said no to does not stop it.
    expect(r.queued.map((q) => q.contactId)).toEqual([clockOnly])
    expect(inserted.sort()).toEqual([0, 0, 1])
  })

  /**
   * The sender refuses a bounced address on sight, so a draft to one is a
   * card nobody can approve — or, under auto-send, a row refused at once.
   * The mark is about the address, so it does not follow the person to
   * LinkedIn.
   */
  it('skips an email address that bounced, on the email channel only', async () => {
    await scan()
    const bounced = await contact({
      emailBouncedAt: FRESH_AT,
      emailBounceCode: '5.1.1',
      linkedinUrl: 'https://www.linkedin.com/in/priya-rentman',
    })
    const r = ok(await enrol())
    expect(r.skipped).toEqual([{ companyId, contactId: bounced, why: 'bounced' }])
    expect(await outbound()).toEqual([])

    const li = await campaign({ name: 'LinkedIn', channel: 'linkedin' })
    expect(ok(await enrol({ campaignId: li })).queued.map((q) => q.contactId)).toEqual([bounced])
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
    const { db: watched, inserted } = watchInserts()
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

  /**
   * An SMS campaign is a real thing since 0019 — every SMS is filed under
   * one — and enrolment never fills it. The refusal says where its messages
   * are written instead; on any other channel there is nowhere to point.
   */
  it('tells an SMS campaign’s refusal where SMS is drafted, and no other channel’s', async () => {
    await scan()
    await contact()
    const sms = await campaign({ name: 'Reminders', channel: 'sms' })
    expect(await enrol({ campaignId: sms, dryRun: true })).toEqual({
      ok: false,
      reason: 'campaign_channel_unsupported',
      message:
        'Reminders is on sms, which is not a cold channel. Enrolment writes email and LinkedIn drafts only. ' +
        'SMS is drafted per person with Draft SMS on /contacts.',
    })
    const wa = await campaign({ name: 'WhatsApp', channel: 'whatsapp' })
    const r = await enrol({ campaignId: wa })
    expect(r).toMatchObject({ ok: false, reason: 'campaign_channel_unsupported' })
    if (!r.ok) expect(r.message).not.toContain('Draft SMS')
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

  /**
   * §2.2, from REAL rows: the recorded rentman.io capture through the real
   * extractor and `recordScan`. Its trust_page, security_txt and
   * compliance_claim gaps are all stored with a NULL detail, and none of them
   * is a header — the opener used to say "header absent on homepage
   * response" beside each, in a body auto-send mails unread.
   */
  it('words the evidence of a real scan from what the scanner did', async () => {
    const fixture = loadFixture('rentman.io')
    const icp = parseIcpDefinition(ICP)
    const recorded = await recordScan(db, {
      orgId,
      companyId,
      icpProfile: { id: icpProfileId, definition: icp },
      raw: fixture,
      profile: extractProfile(fixture, fixture.company),
    })
    await db.update(schema.scans).set({ ranAt: FRESH_AT }).where(eq(schema.scans.id, recorded.scanId))

    const found = await latestScanWithFindings(db, orgId, companyId)
    const stored = new Map(found!.findings.map((f) => [f.signalKey, f]))
    for (const key of ['trust_page', 'security_txt', 'compliance_claim']) {
      expect(stored.get(key), key).toMatchObject({ observed: true, gap: true, detail: null })
    }
    const input = draftInputFromFindings({
      company: { domain: 'rentman.io', name: 'Rentman' },
      icp,
      findings: found!.findings.map((f) => ({ ...f, evidence: (f.evidence ?? {}) as Record<string, unknown> })),
      scan: { ranAt: FRESH_AT, ok: true, stale: false },
      score: found!.score,
    })
    const observed = new Map(input.evidence.map((e) => [e.claim, e.observed]))
    expect(observed.get(why('trust_page'))).toBe(
      'no security or trust page found at /security, /trust, /trust-center or /security-and-privacy',
    )
    expect(observed.get(why('security_txt'))).toBe('no security.txt found at /.well-known/security.txt or /security.txt')
    expect(observed.get(why('compliance_claim'))).toBe('no SOC 2 or ISO 27001 claim found on the homepage')
    const headers = ['csp', 'hsts', 'frame_protection', 'content_type_options', 'referrer_policy', 'permissions_policy'].map(why)
    for (const e of input.evidence) {
      if (e.observed === 'header absent on homepage response') expect(headers, e.claim).toContain(e.claim)
    }

    // And the draft enrolment writes from those rows says the same.
    await contact()
    ok(await enrol())
    const [row] = await outbound()
    expect(row!.body).toContain(
      `• ${why('trust_page')} — no security or trust page found at /security, /trust, /trust-center or /security-and-privacy`,
    )
    expect(row!.body).toContain(`• ${why('compliance_claim')} — no SOC 2 or ISO 27001 claim found on the homepage`)
    for (const line of row!.body!.split('\n').filter((l) => l.includes('header absent'))) {
      expect(headers.some((h) => line === `• ${h} — header absent on homepage response`), line).toBe(true)
    }
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
