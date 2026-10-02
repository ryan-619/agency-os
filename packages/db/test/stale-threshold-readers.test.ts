/**
 * Every packages/db reader of the ICP's `freshness.stale_after_days` takes it
 * through `staleAfterDaysOf` — against a real engine, with the value a hand
 * edit can leave in the row.
 *
 * `isStale` THROWS on a threshold that is not a positive number, and
 * `parseIcpDefinition` does not check `freshness`. Each reader here passed
 * the raw value between the two, so an active profile with
 * `stale_after_days: 0` made the share link's mint, read and accept, the
 * proposal generator, the meeting brief and the nightly rescan throw, while
 * `/compliance` fell back to the default. Now each answers at the default.
 *
 * Five files are read by other groups and are listed in the source pin below
 * rather than tested here: outreach.ts, send-preview.ts, enrolment.ts,
 * inbox.ts and digest.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition, type IcpDefinition, type Observation } from '@agency/core'
import {
  briefForMeeting, generateProposal, readProposal, schema, setProposalStatus, shareAccept, shareMint, shareReadByToken,
  type AgencyDb,
} from '../src/index.js'
import { runRescan } from '../src/rescan.js'
import { SEED_DIR } from '../src/paths.js'
import { migratedDb, type TestDb } from './helpers.js'

const SEED = JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')) as Record<string, unknown>
/** The seeded profile with the one value changed — a readable ICP whose threshold isStale refuses. */
const ZERO = { ...SEED, freshness: { ...(SEED.freshness as object), stale_after_days: 0 } }
const DAY = 86_400_000
const SCAN_AT = new Date('2026-09-01T08:00:00.000Z')
const at = (days: number): Date => new Date(SCAN_AT.getTime() + days * DAY)

describe('a stale threshold isStale would refuse, read by packages/db', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'o@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ZERO, active: true })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [s] = await db.insert(schema.scans).values({ orgId, companyId, ranAt: SCAN_AT, ok: true }).returning()
    await db.insert(schema.findings).values(
      Object.entries(SEED.signals as Record<string, { weight: number }>).map(([key, sig]) => ({
        orgId, scanId: s!.id, companyId, signalKey: key, observed: true, gap: key === 'csp',
        weight: sig.weight, detail: key === 'csp' ? 'csp absent' : null,
        evidence: { seen: key === 'csp' ? 'absent' : 'present' },
      })),
    )
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('the premise: the profile is readable, and its raw threshold throws in isStale', () => {
    expect(parseIcpDefinition(ZERO).freshness?.stale_after_days).toBe(0)
    expect(() => isStale(SCAN_AT, 0, at(1))).toThrow(/positive number/)
  })

  it('generates a proposal, at the default threshold', async () => {
    const r = await generateProposal(db, { orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: at(1) })
    expect(r.ok).toBe(true)
    // And refuses at the default's edge, not at zero's.
    const late = await generateProposal(db, {
      orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: at(DEFAULT_STALE_AFTER_DAYS + 1),
    })
    expect(late).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('mints, reads and accepts a share link, at the default threshold', async () => {
    const r = await generateProposal(db, { orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: at(1) })
    if (!r.ok) throw new Error(r.message)
    await setProposalStatus(db, { orgId, id: r.proposal.id, status: 'sent', actor: userId, now: at(1) })
    const minted = await shareMint(db, { orgId, proposalId: r.proposal.id, createdBy: userId, actor: userId, now: at(2) })
    if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`)
    // Capped at the evidence deadline the DEFAULT sets.
    expect(minted.share.expiresAt.getTime()).toBe(at(DEFAULT_STALE_AFTER_DAYS).getTime())
    expect(await shareReadByToken(db, minted.token, at(3))).toMatchObject({ state: 'open' })
    expect(await shareAccept(db, { token: minted.token, acceptedByName: 'Priya Shah', now: at(4) })).toMatchObject({ ok: true })
    expect((await readProposal(db, orgId, r.proposal.id))!.status).toBe('accepted')
  })

  it('writes a meeting brief, at the default threshold', async () => {
    const [meeting] = await db
      .insert(schema.meetings)
      .values({ orgId, companyId, startsAt: at(3), timeZone: 'Europe/London', title: 'Intro' })
      .returning({ id: schema.meetings.id })
    const fresh = await briefForMeeting(db, orgId, meeting!.id, at(2))
    expect(fresh).not.toBeNull()
    expect(fresh!.brief).toBeTruthy()
    // The same brief a day past the default's deadline is written from stale evidence — the rule still applies.
    expect(await briefForMeeting(db, orgId, meeting!.id, at(DEFAULT_STALE_AFTER_DAYS + 1))).not.toBeNull()
  })

  it('runs the nightly rescan, at the default threshold', async () => {
    const icp: IcpDefinition = parseIcpDefinition(ZERO)
    const [profile] = await db.select({ id: schema.icpProfiles.id }).from(schema.icpProfiles).where(eq(schema.icpProfiles.orgId, orgId))
    const observations: Record<string, Observation> = {}
    for (const key of Object.keys(icp.signals)) observations[key] = { observed: true, gap: false, detail: '', evidence: { seen: 'present' } }
    const r = await runRescan(db, {
      orgId,
      icp: { id: profile!.id, definition: icp },
      scan: async (domain) => ({
        raw: { home: { ok: true } },
        profile: {
          domain, company: domain, title: domain, fetchOk: true, fetchError: '', hasLoginSurface: true,
          isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
        },
      }),
      budgetMs: 240_000, scanWorstCaseMs: 1_000, batch: 6,
      // Sixteen days after the only scan: stale at the default, and so due.
      now: () => at(DEFAULT_STALE_AFTER_DAYS + 2),
    })
    expect(r.picked).toBe(1)
    expect(r.scanned).toBe(1)
  })
})

/**
 * The readers the tests above cannot reach, pinned by their source: nothing in
 * packages/db/src reads `stale_after_days` except through `staleAfterDaysOf`,
 * outside the files other work owns — each listed with what it does instead,
 * so the list shrinks rather than grows.
 */
describe('packages/db/src reads stale_after_days only through staleAfterDaysOf', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))
  /** Comments out, so prose about the field is not a read of it. */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /**
   * Readers owned elsewhere, each already guarding the value itself or
   * handed it by a caller that does. Remove a name when its file is folded in.
   */
  // Every reader in this package goes through staleAfterDaysOf now.
  const ELSEWHERE = new Set<string>([])

  it.each(readdirSync(SRC).filter((f) => f.endsWith('.ts')))('%s', (file) => {
    if (ELSEWHERE.has(file)) return
    const src = code(readFileSync(join(SRC, file), 'utf8'))
    expect(src).not.toMatch(/\bstale_after_days\b/)
  })
})
