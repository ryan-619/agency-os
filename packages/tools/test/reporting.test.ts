/**
 * The reporting tools, against a real Postgres engine.
 *
 * What a careless handler here breaks silently, and so what is asserted:
 * a ratio of two printed as a rate; a message body reaching the model's
 * context through a timeline; a teammate's note read back as though the
 * scanner had seen it; a search that reaches a connector or a chat; a role
 * `can()` does not know reading anything at all; and another org's rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { z } from 'zod'
import type { Principal } from '@agency/core'
import { SEED_DIR, advanceDeal, notesAdd, tasksCreate, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  getCompanyTimeline, getComplianceSummary, getPipelineMetrics, searchCrm, type AgencyToolSpec, type ToolContext,
} from '../src/index.js'

const DAY = 86_400_000

describe('the reporting tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let icpProfileId: string
  let staleDays: number
  let companyId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    // A real users row: notes and tasks name their author by a same-org key.
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'priya@agency.test', name: 'Priya Shah', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const definition = JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')) as Record<string, unknown>
    staleDays = (definition as { freshness: { stale_after_days: number } }).freshness.stale_after_days
    const [icp] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: 'ICP', definition, active: true })
      .returning({ id: schema.icpProfiles.id })
    icpProfileId = icp!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => new Date(),
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  const stranger = (): Partial<ToolContext> => ({
    principal: { id: userId, orgId, role: 'guest' as unknown as Principal['role'] },
  })

  const newCompany = async (domain: string, org = orgId): Promise<string> =>
    (await db.insert(schema.companies).values({ orgId: org, domain }).returning({ id: schema.companies.id }))[0]!.id

  // -------------------------------------------------------------------------
  describe('get_pipeline_metrics', () => {
    const closedDeals = async (won: number, lost: number, closedAt = new Date(Date.now() - DAY)): Promise<void> => {
      let i = 0
      for (const stage of [...Array<string>(won).fill('won'), ...Array<string>(lost).fill('lost')]) {
        const c = await newCompany(`closed${i++}.example`)
        await db.insert(schema.deals).values({
          orgId, companyId: c, stage, closedAt, createdAt: new Date(closedAt.getTime() - 10 * DAY),
          ...(stage === 'lost' ? { lostReason: 'budget' } : {}),
        })
      }
    }

    it('says "insufficient data" below five, and never prints a ratio of two as a rate', async () => {
      await closedDeals(2, 1)
      const out = await run(getPipelineMetrics, {})
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { winRate: { won: number; closed: number; rate: number | null }; minSample: number }
      expect(data.minSample).toBe(5)
      expect(data.winRate).toEqual({ won: 2, closed: 3, rate: null })
      expect(out.summary).toContain('Win rate: 2 of 3 closed deals won — insufficient data (< 5)')
      expect(out.summary).not.toMatch(/Win rate: \d+%/)
      // The lower-bound note travels with the numbers.
      expect(out.summary).toContain('lower bounds')
      expect(audited.map((a) => a.action)).toEqual(['agent.get_pipeline_metrics'])
    })

    it('gives the rate, with its denominator, from five', async () => {
      await closedDeals(3, 2)
      const out = await run(getPipelineMetrics, {})
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('Win rate: 60% (3 of 5 closed deals won)')
    })

    it('leaves out a deal that closed before the window and keeps every open one', async () => {
      await closedDeals(1, 0, new Date(Date.now() - 200 * DAY))
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting', createdAt: new Date(Date.now() - 300 * DAY) })
      const out = await run(getPipelineMetrics, { sinceDays: 90 })
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { deals: number; winRate: { closed: number } }
      expect(data.deals).toBe(1)
      expect(data.winRate.closed).toBe(0)
      expect(out.summary).toContain('meeting 1 open')

      const all = await run(getPipelineMetrics, { sinceDays: 365 })
      if (!all.ok) throw new Error(all.message)
      expect((all.data as { deals: number }).deals).toBe(2)
    })

    it('counts recorded moves into conversion', async () => {
      await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      await advanceDeal(db, { orgId, companyId, to: 'replied' })
      const out = await run(getPipelineMetrics, {})
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { movesRead: number; conversion: Array<{ from: string; entered: number; advanced: number }> }
      expect(data.movesRead).toBe(2)
      expect(data.conversion.find((c) => c.from === 'contacted')).toMatchObject({ entered: 1, advanced: 1 })
      expect(out.summary).toContain('contacted → replied or further: 1 of 1 went on — insufficient data (< 5)')
    })

    it('does not count another org’s deals', async () => {
      const theirs = await newCompany('theirs.example', otherOrgId)
      await db.insert(schema.deals).values({ orgId: otherOrgId, companyId: theirs, stage: 'won', closedAt: new Date() })
      const out = await run(getPipelineMetrics, {})
      if (!out.ok) throw new Error(out.message)
      expect((out.data as { deals: number }).deals).toBe(0)
    })

    it('refuses a role can() does not know', async () => {
      const out = await run(getPipelineMetrics, {}, stranger())
      expect(out).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('get_company_timeline', () => {
    const plant = async (): Promise<void> => {
      await db.insert(schema.touches).values({
        orgId, companyId, channel: 'email', direction: 'out', status: 'sent', sentAt: new Date(Date.now() - 5 * DAY),
        subject: 'Your CSP header', body: 'Hi Priya,\nSECOND LINE OF THE OUTBOUND BODY\nthird line', recipient: 'priya@rentman.io',
      })
      await db.insert(schema.touches).values({
        orgId, companyId, channel: 'email', direction: 'in', status: 'replied', replyKind: 'interested',
        subject: 'Re: Your CSP header', body: '\n\nSounds useful, call me.\n> PLEASE KEEP THIS QUOTED PART OUT', recipient: 'priya@rentman.io',
      })
      const [ok] = await db.insert(schema.scans).values({ orgId, companyId, ok: true, ranAt: new Date(Date.now() - 7 * DAY) }).returning({ id: schema.scans.id })
      await db.insert(schema.scores).values({ orgId, companyId, scanId: ok!.id, icpProfileId, score: 77, tier: 'A', qualified: true })
      const [down] = await db.insert(schema.scans).values({ orgId, companyId, ok: false, error: 'TimeoutError', ranAt: new Date(Date.now() - 6 * DAY) }).returning({ id: schema.scans.id })
      // recordScan writes a 0 for an unreachable scan; the timeline must not repeat it.
      await db.insert(schema.scores).values({ orgId, companyId, scanId: down!.id, icpProfileId, score: 0, qualified: false, disqualifiedReason: 'unreachable (TimeoutError)' })
      await advanceDeal(db, { orgId, companyId, to: 'contacted' })
      await advanceDeal(db, { orgId, companyId, to: 'replied', actor: userId })
      await db.insert(schema.meetings).values({ orgId, companyId, title: 'Intro call', startsAt: new Date('2026-10-03T14:00:00Z'), timeZone: 'Europe/London' })
      await db.insert(schema.proposals).values({ orgId, companyId, scanId: ok!.id, title: 'Posture review', document: {}, totalLow: 9600, totalHigh: 15600 })
      await db.insert(schema.calls).values({
        orgId, companyId, direction: 'in', status: 'completed', fromNumber: '+14155550101', startedAt: new Date(Date.now() - 3 * DAY),
        answeredAt: new Date(Date.now() - 3 * DAY), disclosedAiAt: new Date(Date.now() - 3 * DAY), durationS: 192, outcome: 'qualified',
        transcript: [{ role: 'caller', text: 'TRANSCRIPT WORDS' }],
      })
      const note = await notesAdd(db, { orgId, companyId, authorUserId: userId, body: 'They told me they have no CSP.\nSECOND LINE OF THE NOTE' })
      if (!note.ok) throw new Error(note.message)
      const task = await tasksCreate(db, { orgId, kind: 'todo', title: 'Send the scope', companyId, createdBy: userId, actor: userId })
      if (!task.ok) throw new Error(task.message)
    }

    const events = (data: unknown) => (data as { events: Array<{ at: string; kind: string; text: string }> }).events

    it('merges every record, newest first', async () => {
      await plant()
      const out = await run(getCompanyTimeline, { domain: 'https://www.rentman.io/' })
      if (!out.ok) throw new Error(out.message)
      const list = events(out.data)
      expect(new Set(list.map((e) => e.kind))).toEqual(new Set(['message', 'scan', 'deal', 'meeting', 'proposal', 'call', 'note', 'task']))
      const times = list.map((e) => Date.parse(e.at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
      expect(out.summary).toContain('Deal now: open at replied.')
      expect(list.map((e) => e.text)).toContain('deal moved from contacted to replied by Priya Shah')
      expect(list.map((e) => e.text)).toContain('deal opened at contacted, automatically')
      // In the meeting's own zone, with the instant beside it — never the UTC
      // time next to the zone's name.
      expect(list.find((e) => e.kind === 'meeting')!.text).toContain(
        'meeting “Intro call” booked for 2026-10-03 15:00 Europe/London (2026-10-03 14:00 UTC)',
      )
      expect(audited).toEqual([{ action: 'agent.get_company_timeline', detail: { companyId, returned: list.length } }])
    })

    it('never carries a message body beyond its first line, nor a transcript', async () => {
      await plant()
      const out = await run(getCompanyTimeline, { domain: 'rentman.io' })
      if (!out.ok) throw new Error(out.message)
      const everything = JSON.stringify(out)
      expect(everything).toContain('Your CSP header')
      expect(everything).toContain('Hi Priya,')
      expect(everything).toContain('Sounds useful, call me.')
      for (const hidden of ['SECOND LINE OF THE OUTBOUND BODY', 'third line', 'PLEASE KEEP THIS QUOTED PART OUT', 'SECOND LINE OF THE NOTE', 'TRANSCRIPT WORDS', '+14155550101']) {
        expect(everything, hidden).not.toContain(hidden)
      }
    })

    it('labels a note as somebody’s words, and never as observed', async () => {
      await plant()
      const out = await run(getCompanyTimeline, { domain: 'rentman.io' })
      if (!out.ok) throw new Error(out.message)
      const note = events(out.data).find((e) => e.kind === 'note')!
      expect(note.text).toMatch(/^note by Priya Shah: “They told me they have no CSP\./)
      expect(note.text).not.toMatch(/observ/i)
      const line = out.summary.split('\n').find((l) => l.includes('note by'))!
      expect(line).not.toMatch(/observ/i)
      expect(out.summary).toContain('Notes are a teammate’s words, not evidence')
    })

    it('says an unreachable scan was unreachable, never that it scored 0', async () => {
      await plant()
      const out = await run(getCompanyTimeline, { domain: 'rentman.io' })
      if (!out.ok) throw new Error(out.message)
      const scans = events(out.data).filter((e) => e.kind === 'scan').map((e) => e.text)
      expect(scans).toEqual([
        'scan: unreachable (TimeoutError) — nothing was observed, so there is no score',
        'scan reached the site — score 77/100, tier A, qualified',
      ])
      expect(out.summary).not.toContain('0/100')
    })

    it('keeps to the limit and says how many there were', async () => {
      await plant()
      const out = await run(getCompanyTimeline, { domain: 'rentman.io', limit: 3 })
      if (!out.ok) throw new Error(out.message)
      expect(events(out.data)).toHaveLength(3)
      expect((out.data as { omitted: number }).omitted).toBeGreaterThan(0)
      expect(out.summary).toMatch(/^rentman\.io: 3 of \d+ events, newest first\./)
    })

    it('reads nothing of another org’s company with the same domain', async () => {
      const theirs = await newCompany('rentman.io', otherOrgId)
      const [rival] = await db.insert(schema.users).values({ orgId: otherOrgId, email: 'r@rival.test', role: 'owner' }).returning({ id: schema.users.id })
      await notesAdd(db, { orgId: otherOrgId, companyId: theirs, authorUserId: rival!.id, body: 'RIVAL NOTE' })
      await db.insert(schema.touches).values({ orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'out', status: 'sent', subject: 'RIVAL SUBJECT' })

      const out = await run(getCompanyTimeline, { domain: 'rentman.io' })
      if (!out.ok) throw new Error(out.message)
      expect(events(out.data)).toEqual([])
      expect(JSON.stringify(out)).not.toMatch(/RIVAL/)

      await newCompany('only-theirs.example', otherOrgId)
      expect(await run(getCompanyTimeline, { domain: 'only-theirs.example' })).toMatchObject({ ok: false, code: 'not_found' })
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(getCompanyTimeline, { domain: 'rentman.io' }, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('get_compliance_summary', () => {
    it('reports counts and no rows — no address, domain or id reaches the model', async () => {
      const [contact] = await db.insert(schema.contacts).values({ orgId, companyId, email: 'hidden@rentman.io' }).returning({ id: schema.contacts.id })
      await db.insert(schema.consents).values({ orgId, contactId: contact!.id, channel: 'email', granted: false, source: 'replied no' })
      await db.insert(schema.suppressions).values({ orgId, kind: 'email', value: 'secret@hidden.example', reason: 'asked', source: 'manual' })
      const [refused] = await db.insert(schema.touches).values({
        orgId, companyId, contactId: contact!.id, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed',
        recipient: 'secret@hidden.example', subject: 'SUBJECT OF A REFUSED MESSAGE',
      }).returning({ id: schema.touches.id })

      const out = await run(getComplianceSummary, {})
      if (!out.ok) throw new Error(out.message)
      const everything = JSON.stringify(out)
      for (const hidden of ['secret@hidden.example', 'hidden@rentman.io', 'rentman.io', refused!.id, contact!.id, companyId, 'SUBJECT OF']) {
        expect(everything, hidden).not.toContain(hidden)
      }
      expect(out.summary).toContain('Suppressions: 1 added in the last 30 days (manual 1)')
      expect(out.summary).toContain('Refusals in the last 30 days: 1 — suppressed 1; 0 a person could resolve, 1 nobody may approve past.')
      expect(out.summary).toContain('email 0 granted / 1 refused')
      expect(out.summary).toContain('of 1 companies, 0 fresh, 0 stale, 0 unreachable, 1 never scanned')
      // The ICP's window, as the page reads it — not a default.
      expect(out.summary).toContain(`stale after ${staleDays} days`)
      expect(audited).toEqual([{ action: 'agent.get_compliance_summary', detail: { staleDays } }])
    })

    // The two counts a review found under-reporting: a queued auto-send row
    // leaves with nobody looking again, and a failed unsubscribe is an
    // unrecorded opt-out as much as a failed reply is. A message on MISSING
    // evidence is one the send path does not judge by evidence — the one
    // kind of listed row that really does go as written.
    it('counts a queued message on missing evidence and an unsubscribe that failed to store', async () => {
      await db.insert(schema.touches).values({ orgId, companyId, channel: 'email', direction: 'out', status: 'queued' })
      await db.insert(schema.auditLog).values({
        orgId, actor: 'system', action: 'unsubscribe.not_recorded', subjectType: 'touch', detail: { why: 'no_recipient' },
      })
      const out = await run(getComplianceSummary, {})
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).toContain('Opt-outs that failed to store: 1 in the last 30 days, 1 all time.')
      expect(out.summary).toContain(
        'Outbound messages not yet sent on stale or missing evidence: 1 of 1 not yet sent (must be 0) — 0 awaiting approval, ' +
          '0 approved, 1 queued, 0 sending. 0 were written from a scan that is stale now and are refused at sending ' +
          '(stale_evidence) — waiting to be refused, or to be re-drafted after a re-scan; 1 have no successful scan behind ' +
          'them or answer a reply, so the send path does not judge them by evidence and they go as written unless another ' +
          'rule stops them — 1 of those with nobody looking again (approved, queued or sending).',
      )
    })

    // The round-1 review made the send path refuse, at sending, a message
    // whose words were written from a scan that is stale now. The summary
    // said such approved and queued rows "go with no further look" — the
    // opposite of what the sender does, repeated by the model to a person.
    it('says a message written from a stale scan is refused at sending, not that it goes unlooked-at', async () => {
      const [contact] = await db.insert(schema.contacts).values({ orgId, companyId, email: 'p@rentman.io' }).returning({ id: schema.contacts.id })
      const scanAt = new Date(Date.now() - (staleDays + 6) * DAY)
      await db.insert(schema.scans).values({ orgId, companyId, ranAt: scanAt, ok: true })
      for (const status of ['approved', 'queued'] as const) {
        await db.insert(schema.touches).values({
          orgId, companyId, contactId: contact!.id, channel: 'email', direction: 'out', status,
          createdAt: new Date(scanAt.getTime() + DAY),
          ...(status === 'approved' ? { approvedBy: userId, approvedAt: new Date(scanAt.getTime() + DAY) } : {}),
        })
      }
      const out = await run(getComplianceSummary, {})
      if (!out.ok) throw new Error(out.message)
      expect(out.summary).not.toContain('go with no further look')
      expect(out.summary).toContain('2 were written from a scan that is stale now and are refused at sending (stale_evidence)')
      expect(out.summary).toContain('0 of those with nobody looking again')
      expect((out.data as { draftsOnStaleEvidence: Record<string, unknown> }).draftsOnStaleEvidence).toMatchObject({
        count: 2, refusedAtSending: 2, notJudgedAtSending: 0, notJudgedNoFurtherLook: 0,
        byWhy: { stale: 2, no_evidence: 0, rescanned_since: 0 },
      })
    })

    it('counts one org only', async () => {
      await db.insert(schema.suppressions).values({ orgId: otherOrgId, kind: 'email', value: 'x@rival.example', reason: 'asked', source: 'manual' })
      await newCompany('rival.example', otherOrgId)
      const out = await run(getComplianceSummary, {})
      if (!out.ok) throw new Error(out.message)
      const data = out.data as { suppressions: { allTime: { total: number } }; freshness: { companies: number } }
      expect(data.suppressions.allTime.total).toBe(0)
      expect(data.freshness.companies).toBe(1)
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(getComplianceSummary, {}, stranger())).toMatchObject({ ok: false, code: 'not_permitted' })
    })
  })

  // -------------------------------------------------------------------------
  describe('search_crm', () => {
    type Hit = { kind: string; label: string; domain: string | null }
    const hitsOf = (data: unknown) => (data as { hits: Hit[] }).hits

    it('finds companies and people and names the domain get_company takes', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, email: 'kestrel@rentman.io', firstName: 'Kestrel' })
      const out = await run(searchCrm, { query: 'rentman' })
      if (!out.ok) throw new Error(out.message)
      const hits = hitsOf(out.data)
      expect(hits).toContainEqual(expect.objectContaining({ kind: 'company', domain: 'rentman.io' }))
      expect(hits).toContainEqual(expect.objectContaining({ kind: 'contact', domain: 'rentman.io' }))
      expect(out.summary).toContain('Searched companies, contacts, deals, campaigns, meetings, proposals, touches.')
    })

    it('never returns a connector, a chat or an agent prompt', async () => {
      await db.insert(schema.chatSessions).values({ orgId, userId, title: 'kestrel plan' })
      await db.insert(schema.connectors).values({ orgId, name: 'kestrel', kind: 'http', config: { url: 'https://kestrel.example/mcp' } })
      await db.insert(schema.agentDefs).values({ orgId, slug: 'kestrel', name: 'Kestrel', description: 'kestrel', systemPrompt: 'kestrel' })
      const out = await run(searchCrm, { query: 'kestrel' })
      if (!out.ok) throw new Error(out.message)
      expect(hitsOf(out.data)).toEqual([])
      expect(out.summary).toMatch(/^Nothing in this org matches "kestrel"/)
      expect(out.summary).not.toContain('kestrel plan')
      expect(out.summary).not.toContain('kestrel.example')
    })

    it('searches only the sections asked for', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, email: 'rentfan@rentman.io', firstName: 'Rent' })
      const out = await run(searchCrm, { query: 'rent', sections: ['contacts'] })
      if (!out.ok) throw new Error(out.message)
      expect(hitsOf(out.data).map((h) => h.kind)).toEqual(['contact'])
      expect(audited).toEqual([{ action: 'agent.search_crm', detail: { sections: ['contacts'], returned: 1, truncated: false } }])
    })

    /**
     * The shape admits `[]`, and `?? SEARCH_SECTION_NAMES` does not replace
     * it: an owner asking with an empty list used to be told "The person you
     * are helping cannot read ." — a permission refusal for nothing refused.
     */
    it('reads an empty list of sections as all of them, never as a refusal', async () => {
      await db.insert(schema.contacts).values({ orgId, companyId, email: 'kestrel@rentman.io', firstName: 'Kestrel' })
      const out = await run(searchCrm, { query: 'rentman', sections: [] })
      if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
      const hits = hitsOf(out.data)
      expect(hits).toContainEqual(expect.objectContaining({ kind: 'company', domain: 'rentman.io' }))
      expect(hits).toContainEqual(expect.objectContaining({ kind: 'contact', domain: 'rentman.io' }))
      expect(out.summary).toContain('Searched companies, contacts, deals, campaigns, meetings, proposals, touches.')
      expect(out.summary).not.toContain('not permitted')
      expect(audited[0]?.detail).toMatchObject({
        sections: ['companies', 'contacts', 'deals', 'campaigns', 'meetings', 'proposals', 'touches'],
      })
    })

    it('still refuses a role that may read nothing, with a sentence rather than an empty list', async () => {
      const out = await run(searchCrm, { query: 'rentman', sections: [] }, stranger())
      expect(out).toMatchObject({ ok: false, code: 'not_permitted' })
      if (out.ok) return
      expect(out.message).not.toMatch(/read \.$/)
      expect(audited).toEqual([])
    })

    it('does not audit the query, which is somebody’s words', async () => {
      await run(searchCrm, { query: 'Priya Shah' })
      expect(JSON.stringify(audited)).not.toContain('Priya')
    })

    it('gives a role can() does not know no sections at all', async () => {
      const out = await run(searchCrm, { query: 'rentman' }, stranger())
      expect(out).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })

    it('treats a query of spaces as no query', async () => {
      expect(await run(searchCrm, { query: '    ' })).toMatchObject({ ok: false, code: 'invalid_state' })
    })

    it('never returns another org’s rows', async () => {
      await newCompany('rentman-rival.example', otherOrgId)
      const out = await run(searchCrm, { query: 'rentman' })
      if (!out.ok) throw new Error(out.message)
      expect(hitsOf(out.data).map((h) => h.domain)).toEqual(['rentman.io'])
    })
  })
})
