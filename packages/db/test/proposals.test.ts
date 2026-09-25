/**
 * Proposals, against a real engine (PROMPT.md §8.6, under §2.2).
 *
 * The generator is proved in packages/core; this proves the wiring — that a
 * proposal is written from the LATEST scan, tied to it, refused when that
 * scan has aged out, and that accepting one closes the deal as won.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import {
  generateProposal, listProposals, openDealFor, proposalsForCompany, readProposal, schema,
  setProposalStatus, type AgencyDb,
} from '../src/index.js'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'

const ICP = JSON.parse(readFileSync(fileURLToPath(new URL('../seed/icp-security-gap-saas.json', import.meta.url)), 'utf8'))
const NOW = new Date('2026-09-15T12:00:00.000Z')

describe('proposals', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'o@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ICP, active: true })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A scan with two gaps, one strength and one unobserved signal. */
  const scan = async (ranAt: Date, gaps = ['csp', 'security_txt']) => {
    const [s] = await db.insert(schema.scans).values({ orgId, companyId, ranAt, ok: true }).returning()
    const rows = Object.entries(ICP.signals as Record<string, { weight: number }>).map(([key, sig]) => ({
      orgId, scanId: s!.id, companyId, signalKey: key,
      observed: key !== 'trust_page',
      gap: key === 'trust_page' ? null : gaps.includes(key),
      weight: sig.weight,
      detail: gaps.includes(key) ? `${key} absent` : null,
      evidence: key === 'trust_page' ? {} : { seen: gaps.includes(key) ? 'absent' : 'present' },
    }))
    await db.insert(schema.findings).values(rows)
    return s!
  }

  const generate = (over: Record<string, unknown> = {}) =>
    generateProposal(db, { orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: NOW, ...over })

  it('writes a proposal from the latest scan and ties it to that scan', async () => {
    await scan(new Date('2026-09-01T08:00:00.000Z'), ['hsts'])
    const latest = await scan(new Date('2026-09-12T08:00:00.000Z'))
    const r = await generate()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.proposal.scanId).toBe(latest.id)
    expect(r.proposal.status).toBe('draft')
    expect(r.proposal.totalLow).toBeGreaterThan(0)
    expect(r.proposal.totalHigh).toBeGreaterThanOrEqual(r.proposal.totalLow!)
    // From the latest scan's gaps, not the older one's.
    const keys = r.document.workstreams.flatMap((w) => w.items.map((i) => i.signalKey)).sort()
    expect(keys).toEqual(['csp', 'security_txt'])
    expect(r.document.notAssessed.map((n) => n.signalKey)).toEqual(['trust_page'])
  })

  it('moves the deal to proposal', async () => {
    await scan(new Date('2026-09-12T08:00:00.000Z'))
    await generate()
    expect((await openDealFor(db, orgId, companyId))!.stage).toBe('proposal')
  })

  /**
   * THE refusal. A proposal is the most outbound draft there is, and §2.2
   * says stale findings are re-verified before appearing in one.
   */
  it('refuses to write from a scan that has aged out', async () => {
    await scan(new Date('2026-08-01T08:00:00.000Z'))
    const r = await generate()
    expect(r).toMatchObject({ ok: false, reason: 'stale' })
    expect(await proposalsForCompany(db, orgId, companyId)).toEqual([])
    expect(await openDealFor(db, orgId, companyId)).toBeNull()
  })

  it('refuses a company that was never scanned', async () => {
    expect(await generate()).toMatchObject({ ok: false, reason: 'no_scan' })
  })

  it('refuses when the last scan found nothing to fix', async () => {
    await scan(new Date('2026-09-12T08:00:00.000Z'), [])
    expect(await generate()).toMatchObject({ ok: false, reason: 'no_gaps' })
  })

  it('refuses another org’s company', async () => {
    await scan(new Date('2026-09-12T08:00:00.000Z'))
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    expect((await generate({ orgId: other!.id })).ok).toBe(false)
  })

  describe('status', () => {
    it('accepting closes the deal as won, with a time', async () => {
      await scan(new Date('2026-09-12T08:00:00.000Z'))
      const r = await generate()
      if (!r.ok) throw new Error(r.message)
      const accepted = await setProposalStatus(db, { orgId, id: r.proposal.id, status: 'accepted', actor: userId, now: NOW })
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.decidedAt).not.toBeNull()
      // Closed, so no open deal — and the closed one says won.
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
      const deals = await db.select().from(schema.deals)
      expect(deals[0]!.stage).toBe('won')
      expect(deals[0]!.closedAt).not.toBeNull()
    })

    it('declining records a time and leaves the deal open', async () => {
      await scan(new Date('2026-09-12T08:00:00.000Z'))
      const r = await generate()
      if (!r.ok) throw new Error(r.message)
      const declined = await setProposalStatus(db, { orgId, id: r.proposal.id, status: 'declined', actor: userId })
      expect(declined!.decidedAt).not.toBeNull()
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('proposal')
    })

    it('sent and withdrawn carry no decision time', async () => {
      await scan(new Date('2026-09-12T08:00:00.000Z'))
      const r = await generate()
      if (!r.ok) throw new Error(r.message)
      expect((await setProposalStatus(db, { orgId, id: r.proposal.id, status: 'sent', actor: userId }))!.decidedAt).toBeNull()
      expect((await setProposalStatus(db, { orgId, id: r.proposal.id, status: 'withdrawn', actor: userId }))!.decidedAt).toBeNull()
    })

    it('will not touch another org’s proposal', async () => {
      await scan(new Date('2026-09-12T08:00:00.000Z'))
      const r = await generate()
      if (!r.ok) throw new Error(r.message)
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await setProposalStatus(db, { orgId: other!.id, id: r.proposal.id, status: 'accepted', actor: userId })).toBeNull()
      expect(await readProposal(db, other!.id, r.proposal.id)).toBeNull()
    })
  })

  /** 0012: the evidence a proposal was written from stays readable. */
  it('will not let the scan a proposal was written from be deleted', async () => {
    const s = await scan(new Date('2026-09-12T08:00:00.000Z'))
    const r = await generate()
    if (!r.ok) throw new Error(r.message)
    const msg = await expectRejection(() => test.driver.select('DELETE FROM scans WHERE id = $1', [s.id]))
    expect(msg.length).toBeGreaterThan(0)
  })

  it('refuses a decision status with no time, at the database', async () => {
    const s = await scan(new Date('2026-09-12T08:00:00.000Z'))
    const msg = await expectRejection(() =>
      test.driver.select(
        `INSERT INTO proposals (org_id, company_id, scan_id, status, title, document)
         VALUES ($1, $2, $3, 'accepted', 't', '{}'::jsonb)`,
        [orgId, companyId, s.id],
      ),
    )
    expect(msg).toContain('proposals_decided_has_time')
  })

  it('lists newest first', async () => {
    await scan(new Date('2026-09-12T08:00:00.000Z'))
    const a = await generate({ now: new Date('2026-09-15T12:00:00.000Z') })
    const b = await generate({ now: new Date('2026-09-15T13:00:00.000Z') })
    if (!a.ok || !b.ok) throw new Error('setup')
    const list = await listProposals(db, orgId)
    expect(list).toHaveLength(2)
  })
})
