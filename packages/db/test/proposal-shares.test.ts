/**
 * Buyer links to a proposal, against a real engine (0018, PROMPT.md §8.6).
 *
 * The second place a stranger writes to the database, so each of the
 * booking page's rules is pinned here rather than argued in a comment:
 *
 *   * the token is a bearer credential and no row, audit line or listing
 *     ever holds it — only its sha256 (§2.3);
 *   * a link exists only for a proposal a person has already marked `sent`,
 *     and only while its evidence is fresh (§2.4, §2.2);
 *   * a link whose evidence ages out stops working — it EXPIRES at the
 *     moment the evidence goes stale, and the read and the accept re-derive
 *     freshness anyway, because the threshold can move after minting;
 *   * accepting is the same `setProposalStatus` the team's button is, closes
 *     the deal `won`, happens once, and is audited with ids only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  SHARE_TOKEN_SHAPE, generateProposal, openDealFor, readProposal, schema, setProposalStatus, shareAccept,
  shareHashToken, shareList, shareMint, shareNormaliseName, shareReadByToken, shareRevoke, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const ICP = JSON.parse(readFileSync(fileURLToPath(new URL('../seed/icp-security-gap-saas.json', import.meta.url)), 'utf8'))
const DAY = 86_400_000

/** The scan every test's proposal is written from. Stale after 14 days: 2026-09-15T08:00Z. */
const SCAN_AT = new Date('2026-09-01T08:00:00.000Z')
const at = (days: number): Date => new Date(SCAN_AT.getTime() + days * DAY)

describe('proposal share links', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string
  let proposalId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'o@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ICP, active: true })
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id

    const [s] = await db.insert(schema.scans).values({ orgId, companyId, ranAt: SCAN_AT, ok: true }).returning()
    const gaps = ['csp', 'security_txt']
    await db.insert(schema.findings).values(
      Object.entries(ICP.signals as Record<string, { weight: number }>).map(([key, sig]) => ({
        orgId, scanId: s!.id, companyId, signalKey: key,
        observed: key !== 'trust_page',
        gap: key === 'trust_page' ? null : gaps.includes(key),
        weight: sig.weight,
        detail: gaps.includes(key) ? `${key} absent` : null,
        evidence: key === 'trust_page' ? {} : { seen: gaps.includes(key) ? 'absent' : 'present' },
      })),
    )
    const r = await generateProposal(db, { orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: at(1) })
    if (!r.ok) throw new Error(r.message)
    proposalId = r.proposal.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const markSent = () => setProposalStatus(db, { orgId, id: proposalId, status: 'sent', actor: userId, now: at(1) })
  const mint = (over: Partial<Parameters<typeof shareMint>[1]> = {}) =>
    shareMint(db, { orgId, proposalId, createdBy: userId, actor: userId, now: at(2), ...over })
  const minted = async (over: Partial<Parameters<typeof shareMint>[1]> = {}) => {
    const r = await mint(over)
    if (!r.ok) throw new Error(`mint refused: ${r.reason}`)
    return r
  }
  const shareRows = () => test.pg.query<Record<string, unknown>>('SELECT * FROM proposal_shares')
  const auditRows = () => db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))
  const setStaleAfter = async (days: number) => {
    await db
      .update(schema.icpProfiles)
      .set({ definition: { ...ICP, freshness: { ...ICP.freshness, stale_after_days: days } } })
      .where(eq(schema.icpProfiles.orgId, orgId))
  }

  describe('minting', () => {
    it('stores only the sha256 of the token — never the token', async () => {
      await markSent()
      const r = await minted()
      expect(r.token).toMatch(SHARE_TOKEN_SHAPE)
      const { rows } = await shareRows()
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.token_hash).not.toBe(r.token)
      expect(row.token_hash).toBe(shareHashToken(r.token))
      // Nowhere in the row, under any column.
      expect(JSON.stringify(rows)).not.toContain(r.token)
      // And not in what the team is handed back either.
      expect(Object.keys(r.share)).not.toContain('tokenHash')
      expect(JSON.stringify(r.share)).not.toContain(row.token_hash as string)
    })

    it('mints a different token every time', async () => {
      await markSent()
      const a = await minted()
      const b = await minted()
      expect(a.token).not.toBe(b.token)
      expect(a.share.id).not.toBe(b.share.id)
    })

    it('refuses a draft: the link is not the send, and does not make one', async () => {
      const r = await mint()
      expect(r).toMatchObject({ ok: false, reason: 'not_sent' })
      expect((await shareRows()).rows).toEqual([])
      // Still a draft. There is no implicit draft → sent.
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('draft')
    })

    it('refuses a decided proposal', async () => {
      await markSent()
      await setProposalStatus(db, { orgId, id: proposalId, status: 'declined', actor: userId, now: at(2) })
      expect(await mint()).toMatchObject({ ok: false, reason: 'decided' })
      await setProposalStatus(db, { orgId, id: proposalId, status: 'withdrawn', actor: userId, now: at(2) })
      expect(await mint()).toMatchObject({ ok: false, reason: 'decided' })
    })

    it('refuses another org’s proposal and an unknown one', async () => {
      await markSent()
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await mint({ orgId: other!.id })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await mint({ proposalId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, reason: 'not_found' })
    })

    it('refuses a proposal whose evidence has aged out, and writes nothing (§2.2)', async () => {
      await markSent()
      expect(await mint({ now: at(15) })).toMatchObject({ ok: false, reason: 'stale' })
      // Exactly on the deadline: isStale still says fresh, but the link would
      // expire as it was created.
      expect(await mint({ now: at(14) })).toMatchObject({ ok: false, reason: 'stale' })
      expect((await shareRows()).rows).toEqual([])
    })

    it('ends a link when its evidence goes stale — a link minted on day 13 expires on day 14', async () => {
      await markSent()
      const r = await minted({ now: at(13) })
      expect(r.cappedByEvidence).toBe(true)
      expect(r.share.expiresAt.toISOString()).toBe(at(14).toISOString())
    })

    it('uses the full lifetime when the evidence outlasts it', async () => {
      await markSent()
      const r = await minted({ now: at(2), ttlDays: 5 })
      expect(r.cappedByEvidence).toBe(false)
      expect(r.share.expiresAt.toISOString()).toBe(at(7).toISOString())
    })

    it('refuses a lifetime past thirty days rather than quietly shortening it', async () => {
      await markSent()
      await expect(mint({ ttlDays: 31 })).rejects.toThrow(/ttlDays/)
      await expect(mint({ ttlDays: 0 })).rejects.toThrow(/ttlDays/)
    })

    it('audits the mint with ids and the expiry — never the token or its hash', async () => {
      await markSent()
      const r = await minted()
      const row = (await shareRows()).rows[0]!
      const audit = (await auditRows()).filter((a) => a.action === 'proposal.share_created')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actor: userId, subjectType: 'proposal', subjectId: proposalId })
      expect(audit[0]!.detail).toMatchObject({ shareId: r.share.id, cappedByEvidence: true })
      expect(JSON.stringify(audit)).not.toContain(r.token)
      expect(JSON.stringify(audit)).not.toContain(row.token_hash as string)
    })
  })

  describe('reading by token', () => {
    it('shows the stored document and counts each view: a count and two instants, nothing else', async () => {
      await markSent()
      const { token } = await minted()
      const first = await shareReadByToken(db, token, at(3))
      expect(first).toMatchObject({
        state: 'open',
        org: { name: 'Northwind Security' },
        company: { domain: 'rentman.io', name: 'Rentman' },
        proposal: { status: 'sent' },
      })
      if (!first || first.state === 'reverifying') throw new Error('expected a document')
      expect(first.evidenceAsOf.toISOString()).toBe(SCAN_AT.toISOString())
      let [seen] = await shareList(db, orgId, proposalId)
      expect(seen!.viewCount).toBe(1)
      expect(seen!.firstViewedAt!.toISOString()).toBe(at(3).toISOString())

      expect(await shareReadByToken(db, token, at(4))).toMatchObject({ state: 'open' })
      ;[seen] = await shareList(db, orgId, proposalId)
      expect(seen!.viewCount).toBe(2)
      expect(seen!.firstViewedAt!.toISOString()).toBe(at(3).toISOString())
      expect(seen!.lastViewedAt!.toISOString()).toBe(at(4).toISOString())

      // The view record has no column for who looked.
      const columns = Object.keys((await shareRows()).rows[0]!)
      expect(columns.filter((c) => /ip|agent|address|referr/i.test(c))).toEqual([])
    })

    it('hands the page nothing it could leak: no ids, no counts, no hash', async () => {
      await markSent()
      const { token, share } = await minted()
      const view = await shareReadByToken(db, token, at(3))
      if (!view || view.state === 'reverifying') throw new Error('expected a document')
      expect(Object.keys(view.proposal).sort()).toEqual(['decidedAt', 'document', 'status'])
      expect(JSON.stringify(view)).not.toContain(proposalId)
      expect(JSON.stringify(view)).not.toContain(companyId)
      expect(JSON.stringify(view)).not.toContain(share.id)
      expect(JSON.stringify(view)).not.toContain(userId)
      expect(JSON.stringify(view)).not.toContain(shareHashToken(token))
      expect(Object.keys(view).sort()).toEqual(['company', 'evidenceAsOf', 'org', 'proposal', 'state'])
    })

    it('is null for an unknown, malformed, revoked or expired token — the same null for each', async () => {
      await markSent()
      const { token, share } = await minted({ now: at(13) })
      expect(await shareReadByToken(db, 'A'.repeat(43), at(13))).toBeNull()
      expect(await shareReadByToken(db, 'not a token', at(13))).toBeNull()
      expect(await shareReadByToken(db, `${token}x`, at(13))).toBeNull()
      // Expired: the moment the evidence went stale.
      expect(await shareReadByToken(db, token, at(14))).toBeNull()
      expect(await shareReadByToken(db, token, at(20))).toBeNull()

      const live = await minted({ now: at(2) })
      expect(await shareRevoke(db, { orgId, shareId: live.share.id, actor: userId, now: at(3) })).toBe(true)
      expect(await shareReadByToken(db, live.token, at(4))).toBeNull()
      // None of those refusals counted a view.
      const rows = (await shareRows()).rows
      expect(rows.map((r) => r.view_count)).toEqual([0, 0])
      expect(share.viewCount).toBe(0)
    })

    it('stops showing the document when the ICP threshold drops below the link’s age — and counts nothing', async () => {
      await markSent()
      const { token } = await minted({ now: at(2) })
      await setStaleAfter(3)
      expect(await shareReadByToken(db, token, at(5))).toEqual({ state: 'reverifying', org: { name: 'Northwind Security' } })
      expect((await shareRows()).rows[0]!.view_count).toBe(0)
    })

    it('renders a decided proposal read-only', async () => {
      await markSent()
      const { token } = await minted()
      await setProposalStatus(db, { orgId, id: proposalId, status: 'declined', actor: userId, now: at(3) })
      expect(await shareReadByToken(db, token, at(4))).toMatchObject({ state: 'closed', proposal: { status: 'declined' } })
    })
  })

  describe('accepting', () => {
    it('closes the deal as won, through the same call the team’s button makes', async () => {
      await markSent()
      const { token, share } = await minted()
      const r = await shareAccept(db, { token, acceptedByName: '  Priya   Shah ', now: at(5) })
      expect(r).toEqual({ ok: true, proposalId, orgId, companyDomain: 'rentman.io', shareId: share.id })

      const proposal = await readProposal(db, orgId, proposalId)
      expect(proposal!.status).toBe('accepted')
      expect(proposal!.decidedAt!.toISOString()).toBe(at(5).toISOString())
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
      const deals = await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))
      expect(deals).toHaveLength(1)
      expect(deals[0]!.stage).toBe('won')
      expect(deals[0]!.closedAt!.toISOString()).toBe(at(5).toISOString())

      const row = (await shareRows()).rows[0]!
      expect(row.accepted_by_name).toBe('Priya Shah')
      expect(new Date(row.accepted_at as string).toISOString()).toBe(at(5).toISOString())

      // The page now renders it closed.
      expect(await shareReadByToken(db, token, at(6))).toMatchObject({ state: 'closed', proposal: { status: 'accepted' } })
    })

    it('audits the acceptance by the share link, with ids — never the name, never the token', async () => {
      await markSent()
      const { token, share } = await minted()
      await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(5) })
      const audit = await auditRows()
      const via = audit.filter((a) => a.action === 'proposal.accepted_via_share')
      expect(via).toHaveLength(1)
      expect(via[0]).toMatchObject({ actor: 'share_link', subjectType: 'proposal', subjectId: proposalId })
      expect(via[0]!.detail).toMatchObject({ proposalId, shareId: share.id })
      // setProposalStatus audits its own transition, under the same actor.
      expect(audit.filter((a) => a.action === 'proposal.accepted').map((a) => a.actor)).toEqual(['share_link'])
      const all = JSON.stringify(audit)
      expect(all).not.toContain(token)
      expect(all).not.toContain(shareHashToken(token))
      expect(all).not.toContain('Priya')
    })

    it('accepts once: a second click is refused and nothing moves', async () => {
      await markSent()
      const { token } = await minted()
      expect((await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(5) })).ok).toBe(true)
      expect(await shareAccept(db, { token, acceptedByName: 'Somebody Else', now: at(6) })).toEqual({
        ok: false, reason: 'already_accepted', status: 409,
      })
      expect((await shareRows()).rows[0]!.accepted_by_name).toBe('Priya Shah')
      expect((await auditRows()).filter((a) => a.action === 'proposal.accepted_via_share')).toHaveLength(1)
    })

    it('two clicks at once produce one acceptance', async () => {
      await markSent()
      const { token } = await minted()
      const results = await Promise.all([
        shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(5) }),
        shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(5) }),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.find((r) => !r.ok)).toMatchObject({ reason: 'already_accepted', status: 409 })
      expect((await auditRows()).filter((a) => a.action === 'proposal.accepted_via_share')).toHaveLength(1)
      expect(await db.select().from(schema.deals).where(eq(schema.deals.companyId, companyId))).toHaveLength(1)
    })

    it('two links to one proposal accept it once', async () => {
      await markSent()
      const a = await minted()
      const b = await minted()
      expect((await shareAccept(db, { token: a.token, acceptedByName: 'Priya Shah', now: at(5) })).ok).toBe(true)
      expect(await shareAccept(db, { token: b.token, acceptedByName: 'Sam Lee', now: at(5) })).toMatchObject({
        ok: false, reason: 'decided', status: 409,
      })
      expect((await shareRows()).rows.filter((r) => r.accepted_at !== null)).toHaveLength(1)
    })

    it('refuses after the link is revoked, as if it never existed', async () => {
      await markSent()
      const { token, share } = await minted()
      await shareRevoke(db, { orgId, shareId: share.id, actor: userId, now: at(3) })
      expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(4) })).toEqual({
        ok: false, reason: 'revoked', status: 404,
      })
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('sent')
    })

    it('refuses a declined proposal', async () => {
      await markSent()
      const { token } = await minted()
      await setProposalStatus(db, { orgId, id: proposalId, status: 'declined', actor: userId, now: at(3) })
      expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(4) })).toEqual({
        ok: false, reason: 'decided', status: 409,
      })
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('declined')
      expect((await shareRows()).rows[0]!.accepted_at).toBeNull()
    })

    it('refuses a blank name, whatever shape the blank takes', async () => {
      await markSent()
      const { token } = await minted()
      for (const name of ['', '   ', '\n\t', '\u0000\u0007', null, 42, { name: 'x' }]) {
        expect(await shareAccept(db, { token, acceptedByName: name, now: at(4) }), String(name)).toEqual({
          ok: false, reason: 'blank_name', status: 400,
        })
      }
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('sent')
    })

    it('refuses an unknown or malformed token with 404', async () => {
      await markSent()
      await minted()
      for (const token of ['A'.repeat(43), 'short', '', '../../etc/passwd']) {
        expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(4) })).toEqual({
          ok: false, reason: 'not_found', status: 404,
        })
      }
    })

    it('refuses after the boundary — a link minted on day 13 cannot accept on day 14', async () => {
      await markSent()
      const { token } = await minted({ now: at(13) })
      expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(14) })).toEqual({
        ok: false, reason: 'expired', status: 410,
      })
      expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(20) })).toMatchObject({ ok: false, status: 410 })
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('sent')
      expect(await openDealFor(db, orgId, companyId)).not.toBeNull()
    })

    it('still accepts a moment before that boundary — the boundary is the evidence’s, not a rounding', async () => {
      await markSent()
      const { token } = await minted({ now: at(13) })
      const r = await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: new Date(at(14).getTime() - 1000) })
      expect(r.ok).toBe(true)
    })

    it('refuses when the evidence aged out under a live link, and writes nothing', async () => {
      await markSent()
      const { token } = await minted({ now: at(2) })
      await setStaleAfter(3)
      expect(await shareAccept(db, { token, acceptedByName: 'Priya Shah', now: at(5) })).toEqual({
        ok: false, reason: 'reverifying', status: 410,
      })
      expect((await shareRows()).rows[0]!.accepted_at).toBeNull()
      expect((await readProposal(db, orgId, proposalId))!.status).toBe('sent')
      expect((await auditRows()).filter((a) => a.action.startsWith('proposal.accepted'))).toEqual([])
    })

    it('bounds the stored name at 120 characters, cut at a character rather than half of one', async () => {
      await markSent()
      const { token } = await minted()
      const long = `${'😀'.repeat(119)}ab`
      expect((await shareAccept(db, { token, acceptedByName: long, now: at(4) })).ok).toBe(true)
      const stored = (await shareRows()).rows[0]!.accepted_by_name as string
      expect(Array.from(stored)).toHaveLength(120)
      expect(stored.endsWith('😀a')).toBe(true)
      expect(shareNormaliseName('  Jane \u0000 Doe  ')).toBe('Jane Doe')
    })
  })

  describe('the team’s side', () => {
    it('lists every link newest first, and never the hash', async () => {
      await markSent()
      const a = await minted({ now: at(2) })
      const b = await minted({ now: at(3) })
      const list = await shareList(db, orgId, proposalId)
      expect(list.map((s) => s.id)).toEqual([b.share.id, a.share.id])
      expect(JSON.stringify(list)).not.toContain(shareHashToken(a.token))
      expect(list.every((s) => !('tokenHash' in s))).toBe(true)
    })

    it('revokes once, only in its own org, and audits it', async () => {
      await markSent()
      const { share } = await minted()
      const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
      expect(await shareRevoke(db, { orgId: other!.id, shareId: share.id, actor: userId })).toBe(false)
      expect(await shareRevoke(db, {
        orgId, shareId: share.id, actor: userId, proposalId: '00000000-0000-4000-8000-000000000000',
      })).toBe(false)
      expect(await shareRevoke(db, { orgId, shareId: share.id, actor: userId, proposalId, now: at(3) })).toBe(true)
      expect(await shareRevoke(db, { orgId, shareId: share.id, actor: userId, now: at(4) })).toBe(false)
      const audit = (await auditRows()).filter((a) => a.action === 'proposal.share_revoked')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ subjectId: proposalId, detail: { shareId: share.id } })
      expect((await shareList(db, orgId, proposalId))[0]!.revokedAt!.toISOString()).toBe(at(3).toISOString())
    })
  })
})
