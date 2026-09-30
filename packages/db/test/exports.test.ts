/**
 * The reads behind the CSV exports. An export is where a NULL most easily
 * becomes a FALSE — a spreadsheet reads a blank as "no" — so the assertions
 * here are mostly about nulls staying null, absences being named, and one
 * org's rows never reaching another's file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  exportsConsentLedgerRows, exportsFindingsForLatestScans, exportsOpenDealStages, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('exports', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    const [other] = await db.insert(schema.orgs).values({ name: 'Elsewhere' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    otherOrgId = other!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const company = async (org: string, domain: string, name: string | null = null) => {
    const [c] = await db.insert(schema.companies).values({ orgId: org, domain, name }).returning({ id: schema.companies.id })
    return c!.id
  }

  const scan = async (org: string, companyId: string, ranAt: Date, ok = true) => {
    const [s] = await db.insert(schema.scans).values({ orgId: org, companyId, ranAt, ok }).returning({ id: schema.scans.id })
    return s!.id
  }

  describe('exportsFindingsForLatestScans', () => {
    it('returns the latest scan only, and an unobserved finding keeps gap NULL', async () => {
      const acme = await company(orgId, 'acme.example', 'Acme')
      const older = await scan(orgId, acme, new Date('2026-09-01T08:00:00Z'))
      await db.insert(schema.findings).values({
        orgId, scanId: older, companyId: acme, signalKey: 'hsts', observed: true, gap: true, weight: 8,
        detail: 'old gap', evidence: { header: 'absent' },
      })
      const latest = await scan(orgId, acme, new Date('2026-09-20T08:00:00Z'))
      await db.insert(schema.findings).values([
        { orgId, scanId: latest, companyId: acme, signalKey: 'trust_page', observed: false, gap: null, weight: 0, detail: 'every candidate timed out' },
        { orgId, scanId: latest, companyId: acme, signalKey: 'csp', observed: true, gap: true, weight: 10, detail: 'no CSP', evidence: { header: 'absent' } },
        { orgId, scanId: latest, companyId: acme, signalKey: 'hsts', observed: true, gap: false, weight: 0, evidence: { header: 'max-age=31536000' } },
        { orgId, scanId: latest, companyId: acme, signalKey: 'server_banner', observed: true, gap: false, weight: 0, scored: false, evidence: { server: 'nginx' } },
      ])

      const out = await exportsFindingsForLatestScans(db, orgId)
      expect(out).toHaveLength(1)
      const [only] = out
      expect(only!.company).toEqual({ id: acme, domain: 'acme.example', name: 'Acme' })
      expect(only!.scan.id).toBe(latest)
      expect(only!.scan.ranAt.toISOString()).toBe('2026-09-20T08:00:00.000Z')
      // Signal-key order, and nothing from the superseded scan.
      expect(only!.findings.map((f) => f.signalKey)).toEqual(['csp', 'hsts', 'server_banner', 'trust_page'])
      expect(only!.findings.some((f) => f.detail === 'old gap')).toBe(false)

      const unobserved = only!.findings.find((f) => f.signalKey === 'trust_page')!
      expect(unobserved.observed).toBe(false)
      // NULL, not false: "we could not see it" is not "they have it".
      expect(unobserved.gap).toBeNull()
      expect(only!.findings.find((f) => f.signalKey === 'hsts')!.gap).toBe(false)
      expect(only!.findings.find((f) => f.signalKey === 'server_banner')!.scored).toBe(false)
    })

    it('never returns the cached stale column — freshness is the caller\'s to derive from ran_at', async () => {
      const acme = await company(orgId, 'acme.example')
      const s = await scan(orgId, acme, new Date('2026-01-01T00:00:00Z'))
      await db.insert(schema.findings).values({
        orgId, scanId: s, companyId: acme, signalKey: 'csp', observed: true, gap: true, weight: 10,
        evidence: { header: 'absent' }, stale: false,
      })
      const [only] = await exportsFindingsForLatestScans(db, orgId)
      expect(only!.findings[0]).not.toHaveProperty('stale')
    })

    it('keeps a failed latest scan with no findings, and leaves out a company never scanned', async () => {
      const down = await company(orgId, 'down.example')
      await company(orgId, 'never.example')
      const s = await scan(orgId, down, new Date('2026-09-20T08:00:00Z'), false)

      const out = await exportsFindingsForLatestScans(db, orgId)
      expect(out.map((g) => g.company.domain)).toEqual(['down.example'])
      expect(out[0]!.scan).toMatchObject({ id: s, ok: false })
      expect(out[0]!.findings).toEqual([])
    })

    it('never returns another org\'s scans or findings', async () => {
      const theirs = await company(otherOrgId, 'theirs.example')
      const s = await scan(otherOrgId, theirs, new Date('2026-09-20T08:00:00Z'))
      await db.insert(schema.findings).values({
        orgId: otherOrgId, scanId: s, companyId: theirs, signalKey: 'csp', observed: true, gap: true, weight: 10,
        evidence: { header: 'absent' },
      })
      // Same domain in this org, never scanned here.
      await company(orgId, 'theirs.example')

      expect(await exportsFindingsForLatestScans(db, orgId)).toEqual([])
      expect(await exportsFindingsForLatestScans(db, otherOrgId)).toHaveLength(1)
    })
  })

  describe('exportsConsentLedgerRows', () => {
    const contact = async (org: string, companyId: string, email: string) => {
      const [c] = await db.insert(schema.contacts).values({ orgId: org, companyId, email }).returning({ id: schema.contacts.id })
      return c!.id
    }

    it('writes all four channels for every contact and synthesises never_asked for a missing row', async () => {
      const acme = await company(orgId, 'acme.example')
      const jane = await contact(orgId, acme, 'jane@acme.example')
      const sam = await contact(orgId, acme, 'sam@acme.example')
      const at = new Date('2026-09-10T12:00:00Z')
      await db.insert(schema.consents).values([
        { orgId, contactId: jane, channel: 'email', granted: true, source: 'booking form', recordedAt: at },
        { orgId, contactId: jane, channel: 'sms', granted: false, source: 'reply: stop texting me', recordedAt: at },
      ])

      const rows = await exportsConsentLedgerRows(db, orgId)
      expect(rows).toHaveLength(8)

      const janes = rows.filter((r) => r.contactId === jane)
      expect(janes.map((r) => [r.channel, r.state])).toEqual([
        ['email', 'granted'], ['sms', 'refused'], ['voice', 'never_asked'], ['whatsapp', 'never_asked'],
      ])
      expect(janes[0]).toMatchObject({ email: 'jane@acme.example', companyDomain: 'acme.example', source: 'booking form' })
      expect(janes[0]!.recordedAt?.toISOString()).toBe('2026-09-10T12:00:00.000Z')
      // Synthesised rows carry no source and no time — nothing was recorded.
      expect(janes[2]).toMatchObject({ state: 'never_asked', source: null, recordedAt: null })

      // A contact with no consent rows at all is still in the file, as four NOs.
      const sams = rows.filter((r) => r.contactId === sam)
      expect(sams.map((r) => r.state)).toEqual(['never_asked', 'never_asked', 'never_asked', 'never_asked'])
    })

    it('never returns another org\'s contacts or consents', async () => {
      const theirs = await company(otherOrgId, 'theirs.example')
      const them = await contact(otherOrgId, theirs, 'them@theirs.example')
      await db.insert(schema.consents).values({ orgId: otherOrgId, contactId: them, channel: 'email', granted: true, source: 'form' })

      expect(await exportsConsentLedgerRows(db, orgId)).toEqual([])
      const theirRows = await exportsConsentLedgerRows(db, otherOrgId)
      expect(theirRows).toHaveLength(4)
      expect(theirRows[0]).toMatchObject({ email: 'them@theirs.example', state: 'granted' })
    })
  })

  describe('exportsOpenDealStages', () => {
    it('maps each company to its OPEN deal and ignores closed ones', async () => {
      const open = await company(orgId, 'open.example')
      const won = await company(orgId, 'won.example')
      const reopened = await company(orgId, 'reopened.example')
      await company(orgId, 'none.example')
      const closedAt = new Date('2026-09-01T00:00:00Z')
      await db.insert(schema.deals).values([
        { orgId, companyId: open, stage: 'meeting' },
        { orgId, companyId: won, stage: 'won', closedAt },
        // Lost, then worked again: the closed deal is history, the new one is open.
        { orgId, companyId: reopened, stage: 'lost', closedAt, lostReason: 'budget' },
        { orgId, companyId: reopened, stage: 'new' },
      ])

      const stages = await exportsOpenDealStages(db, orgId)
      expect(Object.fromEntries(stages)).toEqual({ [open]: 'meeting', [reopened]: 'new' })
      expect(stages.has(won)).toBe(false)
    })

    it('never returns another org\'s deals, nor a deal filed against another org\'s company', async () => {
      const theirs = await company(otherOrgId, 'theirs.example')
      await db.insert(schema.deals).values({ orgId: otherOrgId, companyId: theirs, stage: 'proposal' })
      expect((await exportsOpenDealStages(db, orgId)).size).toBe(0)

      // deals.company_id is a plain FK to companies(id), so the database
      // accepts this row; the read must not.
      const mismatched = await company(otherOrgId, 'mismatched.example')
      await db.insert(schema.deals).values({ orgId, companyId: mismatched, stage: 'replied' })
      expect((await exportsOpenDealStages(db, orgId)).size).toBe(0)
      expect((await exportsOpenDealStages(db, otherOrgId)).get(theirs)).toBe('proposal')
    })
  })
})
