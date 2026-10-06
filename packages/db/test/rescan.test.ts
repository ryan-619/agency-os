/**
 * The daily bounded rescan (§2.2): what is due, in what order, how many, and
 * that a run never starts a scan it cannot finish inside the function's
 * ceiling.
 *
 * Profiles are built by hand, the way repository.test.ts builds them — the
 * scan function is injected precisely so that nothing here touches the
 * network. The clock is injected too, so "the budget is spent" is a number
 * this file chooses rather than a race it hopes to win.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, inArray } from 'drizzle-orm'
import { parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import { SEED_DIR } from '../src/paths.js'
import { recordScan, type AgencyDb, type CompanyListRow } from '../src/repository.js'
import {
  RESCAN_MARGIN_MS, RESCAN_MIN_AGE_HOURS, RESCAN_SCAN_TIMEOUTS,
  claimRescan, listOrgIds, rescanClaimHeldUntil, rescanQueue, rescanWorstCaseMs, runRescan, selectRescanTargets,
  type RescanDeps, type RescanScan, type RescanResult,
} from '../src/rescan.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const HOUR = 3_600_000
const DAY = 24 * HOUR

function profileWith(domain: string, gaps: readonly string[] = []): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: '', evidence: { header: key, seen: 'present' } }
  }
  for (const key of gaps) observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
  return {
    domain, company: domain, title: domain,
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations,
  }
}

function unreachableProfile(domain: string): SiteProfile {
  return {
    domain, company: '', title: '', fetchOk: false, fetchError: 'TimeoutError',
    hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations: {},
  }
}

/** A scan that answers at once with a clean profile. */
const answers: RescanScan = async (domain) => ({ raw: { home: { ok: true } }, profile: profileWith(domain, ['csp']) })

/** A clock this file moves by hand. */
function clock(start = Date.now()) {
  let t = start
  return { now: () => new Date(t), advance: (ms: number) => { t += ms } }
}

/** The shape `UnscannableHostError` has, without importing the scanner. */
class RefusedHost extends Error {
  constructor(host: string) {
    super(`Refusing to scan "${host}"`)
    this.name = 'UnscannableHostError'
  }
}

// ---------------------------------------------------------------------------
// The deadline arithmetic
// ---------------------------------------------------------------------------

describe('rescanWorstCaseMs', () => {
  it('is 162 s for the timeouts the cron hands the scanner — and one such scan still fits a fresh run', () => {
    const worst = rescanWorstCaseMs(RESCAN_SCAN_TIMEOUTS)
    expect(worst).toBe(8_000 * 11 + 6_000 * 11 + 8_000)
    expect(worst).toBe(162_000)
    // The route's budget. If one worst-case scan did not fit it, the cron
    // could never scan anything at all and would say so only as remaining.
    expect(worst).toBeLessThanOrEqual(300 * 1000 - RESCAN_MARGIN_MS)
  })

  // The two numbers are restated because packages/db may not import the
  // scanner. A restated number is a claim; this makes it one that is checked.
  it('restates the scanner’s own numbers, and fails the day they move', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const fetchTs = readFileSync(join(here, '..', '..', 'scanner', 'src', 'fetch.ts'), 'utf8')
    expect(fetchTs).toMatch(/const MAX_REDIRECTS = 10\b/)
    expect(fetchTs).toMatch(/deadline = Date\.now\(\) \+ timeoutMs \* \(MAX_REDIRECTS \+ 1\)/)
    expect(fetchTs).toMatch(/tlsConnect\(\{[^}]*timeout: 8000[^}]*\}/)
  })
})

// ---------------------------------------------------------------------------
// Selection — pure
// ---------------------------------------------------------------------------

describe('selectRescanTargets', () => {
  const now = new Date('2026-09-30T03:17:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const row = (domain: string, lastScanAt: Date | null, lastScanOk: boolean | null = lastScanAt ? true : null): CompanyListRow => ({
    companyId: domain, domain, name: null, score: null, tier: null, qualified: false,
    disqualifiedReason: null, lastScanAt, lastScanOk,
  })
  const opts = { staleDays: 14, now, batch: 10, minAgeHours: RESCAN_MIN_AGE_HOURS }
  const domains = (rows: readonly CompanyListRow[]) => rows.map((r) => r.domain)

  it('takes never-scanned companies first, in the order given, then the oldest scan first', () => {
    const rows = [
      row('a-stale.test', ago(20 * DAY)),
      row('b-new.test', null),
      row('c-staler.test', ago(40 * DAY)),
      row('d-new.test', null),
      row('e-fresh.test', ago(3 * DAY)),
    ]
    expect(domains(selectRescanTargets(rows, opts))).toEqual([
      'b-new.test', 'd-new.test', 'c-staler.test', 'a-stale.test',
    ])
  })

  it('leaves a company alone until its newest scan has aged past the ICP threshold', () => {
    const rows = [row('fresh.test', ago(14 * DAY - HOUR)), row('aged.test', ago(14 * DAY + HOUR))]
    expect(domains(selectRescanTargets(rows, opts))).toEqual(['aged.test'])
  })

  // Vercel may deliver one schedule twice. A threshold short enough to make a
  // scan stale within the day is where the floor is the ONLY thing that stops
  // the second delivery doing everything again.
  it('never picks a company scanned within the 20-hour floor, however short the threshold', () => {
    const halfDay = { ...opts, staleDays: 0.5 }
    const rows = [row('twice.test', ago(15 * HOUR)), row('yesterday.test', ago(21 * HOUR))]
    expect(domains(selectRescanTargets(rows, halfDay))).toEqual(['yesterday.test'])
    expect(domains(selectRescanTargets([row('edge.test', ago(20 * HOUR))], halfDay))).toEqual([])
  })

  it('caps at the batch, keeping the head of the queue', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((d) => row(`${d}.test`, null))
    expect(domains(selectRescanTargets(rows, { ...opts, batch: 2 }))).toEqual(['a.test', 'b.test'])
    expect(rescanQueue(rows, opts)).toHaveLength(5)
  })

  // §2.2: freshness is derived from ran_at. CompanyListRow does not even carry
  // findings.stale — and that is the point: nothing here can be fooled by it.
  it('judges staleness by isStale against the scan time, at the clock it is given', () => {
    const rows = [row('acme.test', ago(2 * DAY))]
    expect(selectRescanTargets(rows, opts)).toEqual([])
    const later = new Date(now.getTime() + 13 * DAY)
    expect(domains(selectRescanTargets(rows, { ...opts, now: later }))).toEqual(['acme.test'])
  })

  it('never picks a company named after a person — a free-mail booking placeholder', () => {
    const rows = [row('jane-doe-gmail-com.inbound', null), row('acme.test', null)]
    expect(domains(selectRescanTargets(rows, opts))).toEqual(['acme.test'])
  })

  it('refuses a batch that is not a positive integer rather than guessing one', () => {
    for (const batch of [0, -1, 1.5, Number.NaN]) {
      expect(() => selectRescanTargets([], { ...opts, batch })).toThrow(/batch/)
    }
  })
})

// ---------------------------------------------------------------------------
// The run — against a real Postgres
// ---------------------------------------------------------------------------

describe('runRescan', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let icpProfile: { id: string; definition: IcpDefinition }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [p] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown> })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: p!.id, definition: icp }
  })
  afterEach(async () => { await test.close() })

  async function companies(...domains: string[]): Promise<Record<string, string>> {
    const rows = await db
      .insert(schema.companies)
      .values(domains.map((domain) => ({ orgId, domain, name: domain.split('.')[0]! })))
      .returning({ id: schema.companies.id, domain: schema.companies.domain })
    return Object.fromEntries(rows.map((r) => [r.domain, r.id]))
  }

  function deps(over: Partial<RescanDeps> = {}): RescanDeps {
    return {
      orgId, icp: icpProfile, scan: answers,
      budgetMs: 240_000, scanWorstCaseMs: 1_000, batch: 6,
      now: () => new Date(),
      unscannable: (err) => err instanceof RefusedHost,
      schedule: '17 3 * * *',
      ...over,
    }
  }

  const scansFor = (companyId: string) =>
    db.select().from(schema.scans).where(eq(schema.scans.companyId, companyId))
  const allScans = () => db.select().from(schema.scans).where(eq(schema.scans.orgId, orgId))
  const cronRuns = () =>
    db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'scan.cron_run')))

  it('writes a scan, its findings and the score computed from it for every company it picks', async () => {
    const ids = await companies('acme.test', 'beta.test')
    const r = await runRescan(db, deps())
    expect(r).toMatchObject({ picked: 2, scanned: 2, unreachable: 0, skipped: 0, remaining: 0, stoppedBy: 'done' })

    const scans = await allScans()
    expect(scans).toHaveLength(2)
    expect(scans.every((s) => s.ok)).toBe(true)
    const findings = await db.select().from(schema.findings).where(inArray(schema.findings.scanId, scans.map((s) => s.id)))
    expect(findings).toHaveLength(2 * Object.keys(icp.signals).length)
    const scores = await db.select().from(schema.scores).where(eq(schema.scores.orgId, orgId))
    expect(scores.map((s) => s.scanId).sort()).toEqual(scans.map((s) => s.id).sort())
    expect(scores.every((s) => s.icpProfileId === icpProfile.id)).toBe(true)
    expect(new Set(scans.map((s) => s.companyId))).toEqual(new Set(Object.values(ids)))
  })

  // The cache this job exists to keep honest: the sweep runs on the DATABASE's
  // clock and the scan is two days old there, so the column stays false — and
  // the run re-verifies anyway, because it asks isStale about ran_at.
  it('re-verifies a company whose scan has aged out while findings.stale still says fresh', async () => {
    const ids = await companies('acme.test')
    const first = await recordScan(db, {
      orgId, companyId: ids['acme.test']!, icpProfile, raw: {}, profile: profileWith('acme.test'),
    })
    await db.update(schema.scans).set({ ranAt: new Date(Date.now() - 2 * DAY) }).where(eq(schema.scans.id, first.scanId))

    const r = await runRescan(db, deps({ now: clock(Date.now() + 13 * DAY).now }))
    expect(r).toMatchObject({ picked: 1, scanned: 1 })

    const old = await db.select().from(schema.findings).where(eq(schema.findings.scanId, first.scanId))
    expect(old.length).toBeGreaterThan(0)
    expect(old.every((f) => f.stale === false)).toBe(true)
    expect(await scansFor(ids['acme.test']!)).toHaveLength(2)
  })

  it('records a site that did not answer as an ok:false scan with no findings, and counts it unreachable', async () => {
    const ids = await companies('down.test')
    const r = await runRescan(db, deps({ scan: async (d) => ({ raw: {}, profile: unreachableProfile(d) }) }))
    expect(r).toMatchObject({ picked: 1, scanned: 0, unreachable: 1, remaining: 0 })

    const [scan] = await scansFor(ids['down.test']!)
    expect(scan!.ok).toBe(false)
    expect(scan!.error).toBe('TimeoutError')
    expect(await db.select().from(schema.findings).where(eq(schema.findings.scanId, scan!.id))).toEqual([])
    const [score] = await db.select().from(schema.scores).where(eq(schema.scores.scanId, scan!.id))
    expect(score!.qualified).toBe(false)
  })

  it('counts a refused host as skipped and any other throw as unreachable, and carries on', async () => {
    const ids = await companies('a-refused.test', 'b-broken.test', 'c-fine.test', 'd-fine.test')
    const seen: string[] = []
    const r = await runRescan(db, deps({
      scan: async (domain, company) => {
        seen.push(domain)
        if (domain === 'a-refused.test') throw new RefusedHost(domain)
        if (domain === 'b-broken.test') throw new Error('ECONNRESET')
        return answers(domain, company)
      },
    }))
    expect(seen).toEqual(['a-refused.test', 'b-broken.test', 'c-fine.test', 'd-fine.test'])
    expect(r).toMatchObject({ picked: 4, scanned: 2, unreachable: 1, skipped: 1, remaining: 0, stoppedBy: 'done' })
    // Nothing is written for either failure: no observation was made.
    expect(await scansFor(ids['a-refused.test']!)).toEqual([])
    expect(await scansFor(ids['b-broken.test']!)).toEqual([])
  })

  // A refused host costs no request. If it cost a slot, one bad row — never
  // scanned, so always first in the queue — would take a slot every day forever.
  it('does not spend a batch slot on a refused host', async () => {
    await companies('a-refused.test', 'b-refused.test', 'c.test', 'd.test', 'e.test')
    const r = await runRescan(db, deps({
      batch: 2,
      scan: async (domain, company) => {
        if (domain.endsWith('-refused.test')) throw new RefusedHost(domain)
        return answers(domain, company)
      },
    }))
    expect(r).toMatchObject({ picked: 4, scanned: 2, skipped: 2, remaining: 1, stoppedBy: 'batch' })
  })

  // An assertion thrown INSIDE the stub would be caught and counted as
  // unreachable, so the stub records violations and the test reads them after.
  it('never runs two scans at once, and records each before starting the next', async () => {
    await companies('a.test', 'b.test', 'c.test', 'd.test')
    let inFlight = 0
    let completed = 0
    const violations: string[] = []
    const r = await runRescan(db, deps({
      scan: async (domain, company) => {
        inFlight += 1
        if (inFlight > 1) violations.push(`${domain} started beside another scan`)
        const written = (await allScans()).length
        if (written !== completed) violations.push(`${domain} started with ${written} of ${completed} recorded`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        completed += 1
        return answers(domain, company)
      },
    }))
    expect(violations).toEqual([])
    expect(r.scanned).toBe(4)
  })

  it('dispatches only what can finish: stops when the budget is spent and reports what remains', async () => {
    await companies('a.test', 'b.test', 'c.test', 'd.test', 'e.test')
    const c = clock()
    const r = await runRescan(db, deps({
      now: c.now, budgetMs: 120_000, scanWorstCaseMs: 50_000, batch: 10,
      scan: async (domain, company) => { c.advance(30_000); return answers(domain, company) },
    }))
    // 0+50 ≤ 120, 30+50 ≤ 120, 60+50 ≤ 120, 90+50 > 120.
    expect(r).toMatchObject({ picked: 3, scanned: 3, remaining: 2, stoppedBy: 'budget', elapsedMs: 90_000 })
    expect(await allScans()).toHaveLength(3)
  })

  // The skeptics' case, in the route's own numbers: a slow first site leaves
  // 150 s of a 240 s budget, and a 162 s worst case does not fit in it. The
  // old rule — stop after 240 s — would have started it.
  it('never dispatches a scan whose worst case would outrun what is left of the budget', async () => {
    await companies('a-slow.test', 'b-next.test')
    const c = clock()
    const seen: string[] = []
    const r = await runRescan(db, deps({
      now: c.now,
      budgetMs: 300_000 - RESCAN_MARGIN_MS,
      scanWorstCaseMs: rescanWorstCaseMs(RESCAN_SCAN_TIMEOUTS),
      scan: async (domain, company) => { seen.push(domain); c.advance(90_000); return answers(domain, company) },
    }))
    expect(seen).toEqual(['a-slow.test'])
    expect(r).toMatchObject({ picked: 1, scanned: 1, remaining: 1, stoppedBy: 'budget' })
  })

  it('dispatches nothing when not even one worst case fits, and still writes its audit row', async () => {
    await companies('a.test', 'b.test')
    let called = 0
    const r = await runRescan(db, deps({
      budgetMs: 100_000, scanWorstCaseMs: rescanWorstCaseMs(RESCAN_SCAN_TIMEOUTS),
      scan: async (domain, company) => { called += 1; return answers(domain, company) },
    }))
    expect(called).toBe(0)
    expect(r).toMatchObject({ picked: 0, remaining: 2, stoppedBy: 'budget' })
    expect(await cronRuns()).toHaveLength(1)
  })

  // A body that drips inside every inactivity window is bounded by no timeout,
  // so the worst case the rule relies on is enforced, not assumed.
  it('abandons a scan that outlives its worst case, records nothing for it, and stops', async () => {
    await companies('a-drip.test', 'b-next.test')
    const seen: string[] = []
    const r = await runRescan(db, deps({
      scanWorstCaseMs: 25, budgetMs: 60_000,
      scan: (domain, company) => {
        seen.push(domain)
        return domain === 'a-drip.test' ? new Promise(() => {}) : answers(domain, company)
      },
    }))
    expect(seen).toEqual(['a-drip.test'])
    expect(r).toMatchObject({ picked: 1, scanned: 0, unreachable: 1, remaining: 1, stoppedBy: 'budget' })
    expect(await allScans()).toEqual([])
  })

  it('does nothing twice when the same schedule is delivered twice', async () => {
    await companies('a.test', 'b.test')
    const c = clock()
    expect((await runRescan(db, deps({ now: c.now }))).scanned).toBe(2)
    c.advance(5 * 60_000)
    let called = 0
    const again = await runRescan(db, deps({
      now: c.now, scan: async (d, n) => { called += 1; return answers(d, n) },
    }))
    expect(called).toBe(0)
    expect(again).toMatchObject({ picked: 0, remaining: 0, stoppedBy: 'done' })
    expect(await allScans()).toHaveLength(2)
  })

  it('writes one scan.cron_run row per run, as the system, with counts and no domain', async () => {
    await companies('acme.test', 'b-refused.test')
    await runRescan(db, deps({
      scan: async (domain, company) => {
        if (domain === 'b-refused.test') throw new RefusedHost(domain)
        return answers(domain, company)
      },
    }))
    const rows = await cronRuns()
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row!.actor).toBe('system')
    expect(row!.subjectType).toBeNull()
    const detail = row!.detail as Record<string, unknown>
    expect(Object.keys(detail).sort()).toEqual(
      ['elapsedMs', 'picked', 'remaining', 'scanned', 'schedule', 'skipped', 'stoppedBy', 'unreachable'],
    )
    expect(detail).toMatchObject({ picked: 2, scanned: 1, skipped: 1, unreachable: 0, remaining: 0, schedule: '17 3 * * *' })
    const text = JSON.stringify(detail)
    expect(text).not.toContain('acme')
    expect(text).not.toContain('refused')
  })

  it('records the schedule header bounded, and null when there was none', async () => {
    await runRescan(db, deps({ schedule: 'x'.repeat(500) }))
    await runRescan(db, deps({ schedule: null }))
    const schedules = (await cronRuns()).map((r) => (r.detail as { schedule: string | null }).schedule)
    expect(schedules.map((s) => s?.length ?? null).sort()).toEqual([64, null])
  })

  it('touches only its own org', async () => {
    await companies('acme.test')
    const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
    await db.insert(schema.companies).values({ orgId: other!.id, domain: 'theirs.test' })
    const seen: string[] = []
    await runRescan(db, deps({ scan: async (d, n) => { seen.push(d); return answers(d, n) } }))
    expect(seen).toEqual(['acme.test'])
  })

  // -------------------------------------------------------------------------
  // Two deliveries at once
  // -------------------------------------------------------------------------

  const claims = () =>
    db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'scan.cron_started')))

  /** What the route does per org: claim, and run only if the claim was won. */
  async function deliver(over: Partial<RescanDeps> = {}): Promise<RescanResult | 'claimed'> {
    const d = deps(over)
    const claim = await claimRescan(db, { orgId, now: d.now(), budgetMs: d.budgetMs, schedule: d.schedule ?? null })
    return claim.claimed ? runRescan(db, d) : 'claimed'
  }

  /**
   * The floor cannot see a scan that has not been recorded yet. A second
   * delivery arriving while the first is mid-scan read the same queue head,
   * and every company was scanned twice. PGlite runs one transaction at a
   * time, so the overlap is driven the only way it can be: the second
   * delivery starts from inside the first one's scan, before that scan is
   * recorded.
   */
  it('skips an org another delivery is running, rather than scanning its companies twice', async () => {
    await companies('a.test', 'b.test', 'c.test')
    const seen: string[] = []
    let second: RescanResult | 'claimed' | null = null
    const first = await deliver({
      scan: async (domain, company) => {
        seen.push(domain)
        if (second === null) second = await deliver({ scan: async (d, n) => { seen.push(`again:${d}`); return answers(d, n) } })
        return answers(domain, company)
      },
    })
    expect(second).toBe('claimed')
    expect(seen).toEqual(['a.test', 'b.test', 'c.test'])
    expect(first).toMatchObject({ scanned: 3 })
    expect(await allScans()).toHaveLength(3)
    expect(await claims()).toHaveLength(1)
    expect(await cronRuns()).toHaveLength(1)
  })

  it('holds its claim until the run’s own ceiling: its budget plus the margin, and no longer', async () => {
    const t0 = new Date('2026-09-30T03:17:00.000Z')
    const budgetMs = 240_000
    expect(await claimRescan(db, { orgId, now: t0, budgetMs, schedule: '17 3 * * *' })).toEqual({ claimed: true })
    const until = new Date(t0.getTime() + budgetMs + RESCAN_MARGIN_MS)
    const [row] = await claims()
    expect(row!.actor).toBe('system')
    expect(row!.detail).toEqual({ until: until.toISOString(), schedule: '17 3 * * *' })

    // A duplicate a minute later — with less budget of its own — still reads the first claim's until.
    expect(await claimRescan(db, { orgId, now: new Date(t0.getTime() + 60_000), budgetMs: 10_000 }))
      .toEqual({ claimed: false, heldUntil: until })
    expect(await claimRescan(db, { orgId, now: new Date(until.getTime() - 1), budgetMs })).toMatchObject({ claimed: false })
    expect(await claims()).toHaveLength(1)

    // Past it, a delivery claims afresh.
    expect(await claimRescan(db, { orgId, now: until, budgetMs })).toEqual({ claimed: true })
    expect(await claims()).toHaveLength(2)
  })

  it('lets a manual curl later in the day run, and the floor still decides what it picks', async () => {
    await companies('a.test', 'b.test')
    const c = clock()
    expect(await deliver({ now: c.now, batch: 1 })).toMatchObject({ scanned: 1, remaining: 1 })
    c.advance(6 * HOUR)
    const later = await deliver({ now: c.now, batch: 5 })
    // b was never scanned; a is inside the twenty-hour floor.
    expect(later).toMatchObject({ picked: 1, scanned: 1, remaining: 0 })
    expect(await claims()).toHaveLength(2)
    expect(await cronRuns()).toHaveLength(2)
  })

  it('claims per org: another org’s run holds nothing here', async () => {
    const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
    const now = new Date()
    expect(await claimRescan(db, { orgId: other!.id, now, budgetMs: 240_000 })).toEqual({ claimed: true })
    expect(await claimRescan(db, { orgId, now, budgetMs: 240_000 })).toEqual({ claimed: true })
  })

  /**
   * The agent's `rescan_stale` must not scan beside a run, and must not take
   * a claim either — a claim it took would make the night's delivery skip
   * the org. So the claim can be READ on its own: the same reading of a
   * claim, under the same lock, and nothing written.
   */
  it('can be read without being taken: rescanClaimHeldUntil sees what claimRescan wrote, and writes nothing', async () => {
    const t0 = new Date('2026-09-30T03:17:00.000Z')
    const budgetMs = 240_000
    expect(await rescanClaimHeldUntil(db, orgId, t0)).toBeNull()
    expect(await claims()).toHaveLength(0)

    expect(await claimRescan(db, { orgId, now: t0, budgetMs })).toEqual({ claimed: true })
    const until = new Date(t0.getTime() + budgetMs + RESCAN_MARGIN_MS)
    expect(await rescanClaimHeldUntil(db, orgId, new Date(t0.getTime() + 60_000))).toEqual(until)
    expect(await rescanClaimHeldUntil(db, orgId, until)).toBeNull()
    expect(await claims()).toHaveLength(1)

    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '..', 'src', 'rescan.ts'), 'utf8')
    const body = source.slice(source.indexOf('export async function rescanClaimHeldUntil'))
    const lock = body.indexOf("pg_advisory_xact_lock(hashtext('cron.rescan'), hashtext(")
    expect(body.indexOf('db.transaction(')).toBeLessThan(lock)
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(body.indexOf('liveClaim(t, orgId, now)'))
  })

  /**
   * A claim's `until` is its whole budget; a run with nothing due ends in a
   * second, and the tool said the rescan "is running now" for minutes after
   * (review round 16). The `scan.cron_run` row a run writes as it ends
   * releases the claim for this reader — and only one at or after the claim.
   */
  it('reads a claim as released once its run has written scan.cron_run — an earlier run’s row releases nothing', async () => {
    const t0 = new Date('2026-09-30T03:17:00.000Z')
    const inside = new Date(t0.getTime() + 60_000)
    // Yesterday's run, before this claim.
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'scan.cron_run', detail: {}, createdAt: new Date(t0.getTime() - 86_400_000),
    })
    expect(await claimRescan(db, { orgId, now: t0, budgetMs: 240_000 })).toEqual({ claimed: true })
    const [claim] = await claims()
    // The claim row is stamped by the database's clock; place the run's end after it.
    expect(await rescanClaimHeldUntil(db, orgId, inside)).not.toBeNull()
    await db.insert(schema.auditLog).values({
      orgId, actor: 'system', action: 'scan.cron_run', detail: {}, createdAt: new Date(claim!.createdAt.getTime() + 1_000),
    })
    expect(await rescanClaimHeldUntil(db, orgId, inside)).toBeNull()
    // The nightly run's own claim keeps the plain reading: a second delivery waits out the whole claim.
    expect(await claimRescan(db, { orgId, now: inside, budgetMs: 240_000 })).toMatchObject({ claimed: false })
  })

  it('reads a claim whose until cannot be read as holding nothing', async () => {
    for (const detail of [{}, { until: 'soon' }, { until: 42 }]) {
      await db.insert(schema.auditLog).values({ orgId, actor: 'system', action: 'scan.cron_started', detail })
    }
    expect(await claimRescan(db, { orgId, now: new Date(), budgetMs: 240_000 })).toEqual({ claimed: true })
  })

  /**
   * PGlite runs one transaction at a time, so no test here can show two
   * claims racing; the lock is what makes them wait on real Postgres. It is
   * pinned by reading the source, like the digest's.
   */
  it('takes the two-key transaction lock before it reads, and the route claims before it runs', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '..', 'src', 'rescan.ts'), 'utf8')
    const body = source.slice(source.indexOf('export async function claimRescan'))
    const lock = body.indexOf("pg_advisory_xact_lock(hashtext('cron.rescan'), hashtext(")
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(body.indexOf('.from(schema.auditLog)'))
    expect(body.indexOf('db.transaction(')).toBeLessThan(lock)

    const route = readFileSync(join(here, '..', '..', '..', 'apps', 'web', 'src', 'app', 'api', 'cron', 'rescan', 'route.ts'), 'utf8')
    const claimAt = route.indexOf('await claimRescan(')
    expect(claimAt).toBeGreaterThan(-1)
    expect(claimAt).toBeLessThan(route.indexOf('await runRescan('))
  })

  it('listOrgIds returns every org', async () => {
    const more = await db.insert(schema.orgs).values([{ name: 'B' }, { name: 'C' }]).returning({ id: schema.orgs.id })
    const ids = await listOrgIds(db)
    expect(ids).toHaveLength(3)
    expect(new Set(ids)).toEqual(new Set([orgId, ...more.map((o) => o.id)]))
  })
})
