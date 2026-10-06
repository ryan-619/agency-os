/**
 * The proposals, meetings, deal-owner and task tools, against a real
 * migrated Postgres engine.
 *
 * Each write goes through the function its web route calls, so what is
 * asserted here is the row the route would have written — a proposal tied
 * to the latest scan, a meeting marked rescheduled with its replacement, a
 * deal owner, a task done — and the refusals the route makes, in its words.
 * Beside that, what a careless handler gets wrong: another org's row reached
 * by its id or domain, a role `can()` refuses let through, a title or a note
 * in the audit log, a write whose summary does not say nothing was sent, and
 * evidence that is stale or superseded presented as current (§2.2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENCY_TOOL_NAMES, AGENCY_TOOL_RISK, parseIcpDefinition,
  type IcpDefinition, type Observation, type Principal, type SiteProfile,
} from '@agency/core'
import {
  SEED_DIR, generateProposal, openDealFor, recordScan, rescheduleMeeting, type AgencyDb,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, cancelMeetingTool, completeTask, generateProposalTool, getProposal, listMeetings,
  recordMeetingOutcome, rescheduleMeetingTool, setDealOwnerTool,
  type AgencyToolSpec, type ToolContext, type ToolOutcome,
} from '../src/index.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const NOW = new Date('2026-09-15T12:00:00.000Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const at = (ms: number): Date => new Date(NOW.getTime() + ms)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTHING_SENT = 'Nothing was sent.'

const TOOLS = [
  'generate_proposal', 'get_proposal', 'list_meetings', 'reschedule_meeting', 'cancel_meeting',
  'record_meeting_outcome', 'set_deal_owner', 'complete_task',
] as const

/** A scan that reached the site: every ICP signal observed and clear, but the gaps and the unobserved. */
function reached(over: { gaps?: string[]; unobserved?: string[] } = {}): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  for (const key of over.gaps ?? []) {
    observations[key] = { observed: true, gap: true, detail: `${key} absent`, evidence: { header: key, seen: 'absent' } }
  }
  for (const key of over.unobserved ?? []) {
    observations[key] = { observed: false, gap: null, detail: 'timed out', evidence: { outcome: 'no response' } }
  }
  return {
    domain: 'rentman.io', company: 'Rentman', title: 'Rentman',
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false,
    outdatedLibs: [], observations,
  }
}

const unreachable: SiteProfile = {
  domain: 'rentman.io', company: '', title: '', fetchOk: false, fetchError: 'TimeoutError',
  hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false,
  outdatedLibs: [], observations: {},
}

describe('the proposals, meetings, deal-owner and task tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let samId: string
  let goneId: string
  let outsiderId: string
  let companyId: string
  let otherCompanyId: string
  const profiles = new Map<string, { id: string; definition: IcpDefinition }>()
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    profiles.clear()

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'priya@agency.test', name: 'Priya Shah', role: 'owner' },
        { orgId, email: 'sam@agency.test', name: 'Sam Okafor', role: 'member' },
        { orgId, email: 'gone@agency.test', name: 'Gone Away', role: 'member', revokedAt: at(-5 * DAY) },
        { orgId: otherOrgId, email: 'outsider@rival.test', name: 'Outsider', role: 'owner' },
      ])
      .returning({ id: schema.users.id, email: schema.users.email })
    const idOf = (email: string): string => users.find((u) => u.email === email)!.id
    userId = idOf('priya@agency.test')
    samId = idOf('sam@agency.test')
    goneId = idOf('gone@agency.test')
    outsiderId = idOf('outsider@rival.test')

    for (const id of [orgId, otherOrgId]) {
      const [profile] = await db
        .insert(schema.icpProfiles)
        .values({ orgId: id, name: icp.label, definition: icp as unknown as Record<string, unknown>, active: true })
        .returning({ id: schema.icpProfiles.id })
      profiles.set(id, { id: profile!.id, definition: icp })
    }

    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [theirs] = await db
      .insert(schema.companies)
      .values({ orgId: otherOrgId, domain: 'theirs.io', name: 'Theirs' })
      .returning({ id: schema.companies.id })
    otherCompanyId = theirs!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: userId, orgId, role: 'owner' },
    turnId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    ...over,
  })
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))
  /** A role `can()` does not know: every capability is refused. */
  const guest = (): Partial<ToolContext> => ({
    principal: { id: userId, orgId, role: 'guest' as unknown as Principal['role'] },
  })
  const later = (ms: number): Partial<ToolContext> => ({ now: () => at(ms) })

  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }
  const messageOf = (out: ToolOutcome<unknown>): string => {
    if (out.ok) throw new Error(`expected a refusal, got: ${out.summary}`)
    return out.message
  }

  /**
   * An audit detail carries ids, counts, booleans and fixed words — and a
   * company's domain, an ISO instant and an IANA zone where a key says so.
   * Never a title, a note, a name or an address.
   */
  const SHAPED: Readonly<Record<string, RegExp>> = {
    domain: /^[a-z0-9.-]+\.[a-z]{2,}$/,
    startsAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    timeZone: /^[A-Za-z]+(?:\/[A-Za-z_]+)+$/,
    outcome: /^(held|no_show)$/,
    previous: /^(held|no_show|rescheduled)$/,
  }
  const idsOnly = (detail: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === 'string') expect(value, key).toMatch(SHAPED[key] ?? UUID)
      else expect(value === null || typeof value === 'number' || typeof value === 'boolean', key).toBe(true)
    }
  }
  const agentRows = () => audited.filter((a) => a.action.startsWith('agent.'))
  const logOf = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  /** Record a scan through the real writer, then pin when it ran. */
  const scanAt = async (ranAt: Date, profile: SiteProfile, org = orgId, company = companyId) => {
    const out = await recordScan(db, { orgId: org, companyId: company, icpProfile: profiles.get(org)!, raw: {}, profile })
    await db.update(schema.scans).set({ ranAt }).where(eq(schema.scans.id, out.scanId))
    return out
  }

  const meeting = async (over: Partial<typeof schema.meetings.$inferInsert> = {}) => {
    const startsAt = over.startsAt ?? at(2 * DAY)
    const [row] = await db
      .insert(schema.meetings)
      .values({
        orgId,
        companyId,
        title: 'Intro call',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        timeZone: 'Europe/London',
        source: 'manual',
        ...over,
      })
      .returning()
    return row!
  }
  const meetingRow = async (id: string) =>
    (await db.select().from(schema.meetings).where(eq(schema.meetings.id, id)))[0]!

  it('registers all eight, classified as the gate expects, and none takes an org or a channel', () => {
    for (const name of TOOLS) {
      const spec = AGENCY_TOOLS.find((t) => t.name === name)
      expect(spec, name).toBeDefined()
      expect(AGENCY_TOOL_NAMES).toContain(name)
      const [risk, rule] = AGENCY_TOOL_RISK[name]
      if (name === 'get_proposal' || name === 'list_meetings') expect([risk, rule], name).toEqual(['low', 'read_only'])
      else expect([risk, rule], name).toEqual(['medium', 'writes_internal_state'])
      expect(spec!.description.length, name).toBeGreaterThan(80)
      for (const key of Object.keys(spec!.shape)) {
        expect(['orgId', 'org_id', 'channel'], `${name}.${key}`).not.toContain(key)
      }
    }
  })

  // -------------------------------------------------------------------------
  describe('generate_proposal', () => {
    it('writes the draft POST /api/proposals writes, from the latest scan, and says nothing was sent', async () => {
      await scanAt(at(-10 * DAY), reached({ gaps: ['hsts'] }))
      const latest = await scanAt(at(-2 * DAY), reached({ gaps: ['csp', 'security_txt'], unobserved: ['trust_page'] }))
      const out = await run(generateProposalTool, { domain: 'https://www.Rentman.io/pricing', dayRate: 1200 })
      const summary = summaryOf(out)

      const rows = await db.select().from(schema.proposals)
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      // The agent has no users row: no creator, and the db writer's row names the agent.
      expect(row).toMatchObject({ orgId, companyId, scanId: latest.scanId, status: 'draft', createdBy: null, currency: 'USD' })
      expect(row.totalLow).toBeGreaterThan(0)
      const log = await logOf('proposal.generated')
      expect(log.map((l) => [l.actor, l.subjectId])).toEqual([['agent', row.id]])
      // Writing a proposal is the deal reaching `proposal`, forward only.
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('proposal')

      expect(out.ok && out.data).toMatchObject({ proposalId: row.id, scopeItems: 2, notAssessed: ['trust_page'], dealStage: 'proposal' })
      // The id is in the summary: it is the only thing the model reads.
      expect(summary).toContain(`proposal ${row.id}`)
      expect(summary).toContain('from its scan of 2026-09-13')
      expect(summary).toContain('2 scope items in 2 workstreams')
      expect(summary).toContain('day rate USD 1,200')
      expect(summary).toContain(`total USD ${row.totalLow!.toLocaleString('en-US')} – USD ${row.totalHigh!.toLocaleString('en-US')}`)
      expect(summary).toContain('1 signal could not be observed from the outside and is listed as not assessed — excluded from scope, not assumed fine.')
      expect(summary).toContain('Its deal is at proposal.')
      expect(summary.endsWith(
        'It is a draft for the team: marking it sent and sharing a link are a person’s acts on its page. Nothing was sent.',
      )).toBe(true)

      expect(agentRows()).toEqual([{
        action: 'agent.generate_proposal',
        detail: { domain: 'rentman.io', proposalId: row.id, scanId: latest.scanId, workstreams: 2, scopeItems: 2 },
      }])
      idsOnly(agentRows()[0]!.detail)
    })

    it('without a day rate, says the pricing is effort only', async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp'] }))
      const summary = summaryOf(await run(generateProposalTool, { domain: 'rentman.io', currency: 'eur' }))
      expect(summary).toContain('no day rate was set, so there is no total — effort only')
      expect((await db.select().from(schema.proposals))[0]).toMatchObject({ currency: 'EUR', totalLow: null, totalHigh: null })
    })

    /** §2.2's refusal, worded as the company page's Generate button words it. */
    it('refuses a scan that has aged out, and writes nothing', async () => {
      await scanAt(at(-30 * DAY), reached({ gaps: ['csp'] }))
      const out = await run(generateProposalTool, { domain: 'rentman.io' })
      expect(out).toMatchObject({ ok: false, code: 'no_fresh_evidence' })
      expect(messageOf(out)).toContain('The findings are stale (older than 14 days). Re-scan before generating (§2.2)')
      expect(messageOf(out)).toContain('No proposal was written.')
      expect(await db.select().from(schema.proposals)).toEqual([])
      expect(await openDealFor(db, orgId, companyId)).toBeNull()
      expect(audited).toEqual([])
    })

    it('refuses a company that was never scanned, and writes nothing', async () => {
      const out = await run(generateProposalTool, { domain: 'rentman.io' })
      expect(out).toMatchObject({ ok: false, code: 'no_fresh_evidence' })
      expect(messageOf(out)).toContain('Scan the company first — a proposal is written from findings.')
      expect(await db.select().from(schema.proposals)).toEqual([])
      expect(audited).toEqual([])
    })

    it.each([
      ['a scan that never reached the site', 'unreachable', 'The last scan never reached the site; nothing was observed to propose from.'],
      ['a scan with no gaps', 'invalid_state', 'No gaps were observed. There is nothing to propose.'],
    ] as const)('refuses %s in the page’s words', async (label, code, words) => {
      await scanAt(at(-2 * DAY), label === 'a scan with no gaps' ? reached() : unreachable)
      const out = await run(generateProposalTool, { domain: 'rentman.io' })
      expect(out).toMatchObject({ ok: false, code })
      expect(messageOf(out)).toContain(words)
      expect(await db.select().from(schema.proposals)).toEqual([])
    })

    it('refuses a scan scored under a profile that is no longer the active one', async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp'] }))
      await db.update(schema.icpProfiles).set({ active: false }).where(eq(schema.icpProfiles.orgId, orgId))
      await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP v2', definition: icp as unknown as Record<string, unknown>, active: true })
      const out = await run(generateProposalTool, { domain: 'rentman.io' })
      expect(out).toMatchObject({ ok: false, code: 'no_fresh_evidence' })
      expect(messageOf(out)).toContain('The last scan was scored under a different profile — re-scan before generating')
      expect(await db.select().from(schema.proposals)).toEqual([])
    })

    it('answers another org’s company like no company, and writes nothing', async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp'] }), otherOrgId, otherCompanyId)
      const out = await run(generateProposalTool, { domain: 'theirs.io' })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      expect(await db.select().from(schema.proposals)).toEqual([])
      expect(await db.select().from(schema.deals)).toEqual([])
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp'] }))
      expect(await run(generateProposalTool, { domain: 'rentman.io' }, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await db.select().from(schema.proposals)).toEqual([])
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('get_proposal', () => {
    let proposalId: string

    beforeEach(async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp', 'security_txt'], unobserved: ['trust_page'] }))
      const r = await generateProposal(db, { orgId, companyId, createdBy: userId, actor: userId, dayRate: 1000, now: NOW })
      if (!r.ok) throw new Error(r.message)
      proposalId = r.proposal.id
    })

    it('reads the stored proposal as the team’s page shows it, with its evidence current', async () => {
      const out = await run(getProposal, { proposalId })
      const summary = summaryOf(out)
      expect(summary).toContain(`Proposal ${proposalId} for rentman.io — draft`)
      expect(summary).toContain('Evidence: current — the scan of 2026-09-13 is inside its 14-day re-verification window')
      expect(summary).toContain('  - csp (weight 15): csp absent')
      expect(summary).toContain('  - security_txt (weight 12): security_txt absent')
      // The team's copy carries the score it was ranked on; the summary says the buyer's does not.
      expect(summary).toMatch(/Score when it was generated: \d+\/100/)
      expect(summary).toContain('effort ')
      expect(summary).toContain('day rate USD 1,000')
      // §2.2: an unobserved signal is "not assessed", never a scope item and never fine.
      expect(summary).toContain(
        'Not assessed — could not be observed from the outside, so excluded from scope and not assumed fine: trust_page.',
      )
      expect(summary).not.toMatch(/- trust_page/)
      // A strength is named by its key; the ICP's `why` describes the gap and is never quoted as one.
      expect(summary).toContain('Observed and not a gap, so out of scope: ')
      expect(summary).toContain('hsts')
      expect(summary).not.toContain(icp.signals['hsts']!.why)
      expect(summary).toContain('It is a draft for the team: marking it sent and sharing a link are a person’s acts on its page.')
      expect(summary.endsWith('A read; nothing was changed or sent.')).toBe(true)

      expect(out.ok && out.data).toMatchObject({
        proposalId, domain: 'rentman.io', status: 'draft',
        evidence: { stale: false, superseded: false, standing: 'fresh', staleAfterDays: 14 },
        notAssessed: ['trust_page'],
      })
      expect(agentRows()).toEqual([{
        action: 'agent.get_proposal', detail: { proposalId, companyId, stale: false, superseded: false },
      }])
      idsOnly(agentRows()[0]!.detail)
    })

    it('reads a company’s most recent proposal by its domain', async () => {
      const second = await generateProposal(db, { orgId, companyId, actor: userId, now: NOW })
      if (!second.ok) throw new Error(second.message)
      const out = await run(getProposal, { domain: 'rentman.io' })
      expect(out.ok && out.data).toMatchObject({ proposalId: second.proposal.id })
      expect(summaryOf(out)).toContain('no day rate was set, so there is no total — effort only')
    })

    it('calls a proposal superseded once a newer successful scan exists', async () => {
      await scanAt(at(-1 * DAY), reached({ gaps: ['csp'] }))
      const out = await run(getProposal, { proposalId })
      const summary = summaryOf(out)
      expect(summary).toContain('Evidence: SUPERSEDED — a newer scan of rentman.io exists')
      expect(summary).toContain('this one should be regenerated before anybody marks it sent')
      expect(summary).not.toContain('Evidence: current')
      expect(out.ok && out.data).toMatchObject({ evidence: { stale: false, superseded: true, standing: 'superseded' } })
      expect(agentRows()[0]!.detail).toMatchObject({ superseded: true })
    })

    it('a newer scan that never reached the site supersedes nothing', async () => {
      await scanAt(at(-1 * DAY), unreachable)
      const out = await run(getProposal, { proposalId })
      expect(out.ok && out.data).toMatchObject({ evidence: { superseded: false, standing: 'fresh' } })
    })

    it('calls it stale once its scan is past the deadline, judged from ran_at at the moment of reading', async () => {
      const out = await run(getProposal, { proposalId }, later(20 * DAY))
      const summary = summaryOf(out)
      expect(summary).toContain('Evidence: STALE — the scan of 2026-09-13 is past its 14-day re-verification deadline')
      expect(summary).toContain('re-scan rentman.io (scan_company) and generate a fresh proposal rather than sending this one')
      expect(out.ok && out.data).toMatchObject({ evidence: { stale: true, superseded: false, standing: 'stale' } })
    })

    it('says both when the scan has aged out and a newer one has run since', async () => {
      await scanAt(at(5 * DAY), reached({ gaps: ['csp'] }))
      const summary = summaryOf(await run(getProposal, { proposalId }, later(20 * DAY)))
      expect(summary).toContain('Evidence: STALE')
      expect(summary).toContain('superseded as well')
    })

    it('asks for exactly one of the two ways to name a proposal', async () => {
      expect(await run(getProposal, {})).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(await run(getProposal, { proposalId, domain: 'rentman.io' })).toMatchObject({ ok: false, code: 'invalid_state' })
    })

    it('answers another org’s proposal, by id or by domain, like none at all', async () => {
      await scanAt(at(-2 * DAY), reached({ gaps: ['csp'] }), otherOrgId, otherCompanyId)
      const theirs = await generateProposal(db, { orgId: otherOrgId, companyId: otherCompanyId, actor: 'system', now: NOW })
      if (!theirs.ok) throw new Error(theirs.message)
      const byId = await run(getProposal, { proposalId: theirs.proposal.id })
      expect(byId).toMatchObject({ ok: false, code: 'not_found' })
      expect(messageOf(byId)).not.toContain('theirs.io')
      expect(await run(getProposal, { domain: 'theirs.io' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(audited).toEqual([])
    })

    it('says so when a company has no proposal yet', async () => {
      await db.insert(schema.companies).values({ orgId, domain: 'fresh.io' })
      const out = await run(getProposal, { domain: 'fresh.io' })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      expect(messageOf(out)).toContain('generate_proposal writes one')
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(getProposal, { proposalId }, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('list_meetings', () => {
    it('lists upcoming meetings in their own zone with UTC beside it, and nothing cancelled, far off or another org’s', async () => {
      const soon = await meeting({ startsAt: at(2 * DAY + 2 * HOUR) })
      const far = await meeting({ startsAt: at(20 * DAY) })
      const cancelled = await meeting({ startsAt: at(1 * DAY), cancelledAt: NOW })
      const [theirs] = await db
        .insert(schema.meetings)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, startsAt: at(1 * DAY), timeZone: 'UTC' })
        .returning()

      const out = await run(listMeetings, {})
      const summary = summaryOf(out)
      expect(summary).toContain(`meeting ${soon.id} · rentman.io “Intro call” · 2026-09-17 15:00 Europe/London (2026-09-17 14:00 UTC) · 30 min · manual · upcoming`)
      for (const id of [far.id, cancelled.id, theirs!.id]) expect(summary).not.toContain(id)
      expect(summary).toContain('Cancelled meetings are not listed.')
      expect(summary.endsWith('A read; nothing was changed or sent.')).toBe(true)
      expect(out.ok && out.data).toMatchObject({
        days: 14,
        past: null,
        upcoming: [{ meetingId: soon.id, domain: 'rentman.io', durationMinutes: 30, cancelled: false, outcome: null, rescheduledFrom: null }],
      })
      expect(agentRows()).toEqual([{ action: 'agent.list_meetings', detail: { days: 14, includePast: false, upcoming: 1, past: null } }])
      idsOnly(agentRows()[0]!.detail)
    })

    it('with includePast, lists the started meetings still waiting for an outcome — and no other', async () => {
      const waiting = await meeting({ startsAt: at(-2 * DAY) })
      const held = await meeting({ startsAt: at(-3 * DAY), outcome: 'held' })
      const calledOff = await meeting({ startsAt: at(-1 * DAY), cancelledAt: at(-2 * DAY) })
      const old = await meeting({ startsAt: at(-30 * DAY) })
      const out = await run(listMeetings, { includePast: true })
      const summary = summaryOf(out)
      expect(summary).toContain('No meetings in the next 14 days.')
      expect(summary).toContain(`meeting ${waiting.id} · rentman.io “Intro call” · 2026-09-13 13:00 Europe/London (2026-09-13 12:00 UTC)`)
      expect(summary).toContain('no outcome recorded')
      for (const id of [held.id, calledOff.id, old.id]) expect(summary).not.toContain(id)
      expect(out.ok && out.data).toMatchObject({ past: [{ meetingId: waiting.id }] })
      expect(agentRows()[0]!.detail).toEqual({ days: 14, includePast: true, upcoming: 0, past: 1 })
    })

    it('widens the window with days, and says when the limit cut the list', async () => {
      await meeting({ startsAt: at(1 * DAY) })
      await meeting({ startsAt: at(2 * DAY) })
      const far = await meeting({ startsAt: at(20 * DAY) })
      expect(summaryOf(await run(listMeetings, { days: 30 }))).toContain(far.id)
      // A meeting booked a quarter ahead can still be found to cancel or move (review round 16: 60 days was the cap).
      const quarter = await meeting({ startsAt: at(100 * DAY) })
      expect(summaryOf(await run(listMeetings, { days: 120 }))).toContain(quarter.id)
      expect(summaryOf(await run(listMeetings, { days: 30 }))).not.toContain(quarter.id)
      const cut = await run(listMeetings, { limit: 1 })
      expect(summaryOf(cut)).toContain('(the first 1; more are booked)')
      expect(cut.ok && cut.data).toMatchObject({ omitted: { upcoming: true, past: false } })
    })

    it('names the meeting a replacement was rescheduled from', async () => {
      const original = await meeting({ startsAt: at(-2 * DAY) })
      const r = await rescheduleMeeting(db, { orgId, id: original.id, startsAt: at(3 * DAY), timeZone: 'Europe/London', actor: userId, now: NOW })
      if (!r.ok) throw new Error(r.message)
      const out = await run(listMeetings, { includePast: true })
      const summary = summaryOf(out)
      expect(summary).toContain(`meeting ${r.replacement.id}`)
      expect(summary).toContain(`rescheduled from 2026-09-13 13:00 Europe/London (2026-09-13 12:00 UTC) (meeting ${original.id})`)
      // Rescheduled is an outcome: the original is no longer waiting for one.
      expect(out.ok && out.data).toMatchObject({ past: [] })
    })

    it('refuses a role can() does not know', async () => {
      expect(await run(listMeetings, {}, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('reschedule_meeting', () => {
    it('marks the meeting rescheduled and records the new one, as the meeting page does — and sends nothing', async () => {
      const original = await meeting({ startsAt: at(-1 * HOUR), endsAt: at(-1 * HOUR + 45 * 60_000), title: 'Scoping with Priya' })
      const out = await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-22T15:00:00+01:00' })
      const summary = summaryOf(out)

      expect((await meetingRow(original.id)).outcome).toBe('rescheduled')
      const all = await db.select().from(schema.meetings)
      expect(all).toHaveLength(2)
      const next = all.find((m) => m.id !== original.id)!
      expect(next).toMatchObject({
        startsAt: new Date('2026-09-22T14:00:00.000Z'),
        endsAt: new Date('2026-09-22T14:45:00.000Z'),
        timeZone: 'Europe/London',
        source: 'manual',
        title: 'Scoping with Priya',
        createdBy: userId,
        outcome: null,
      })
      // The db writer's rows name the agent, and are the link between the two.
      const outcomeRows = await logOf('meeting.outcome_recorded')
      expect(outcomeRows).toHaveLength(1)
      expect(outcomeRows[0]).toMatchObject({ actor: 'agent', subjectId: original.id })
      expect(outcomeRows[0]!.detail).toMatchObject({ outcome: 'rescheduled', rescheduledTo: next.id })
      expect((await logOf('meeting.booked'))[0]).toMatchObject({ actor: 'agent', subjectId: next.id, detail: expect.objectContaining({ rescheduledFrom: original.id }) })

      expect(summary).toContain(`it was 2026-09-15 12:00 Europe/London (2026-09-15 11:00 UTC) (meeting ${original.id}`)
      expect(summary).toContain(`the new meeting is 2026-09-22 15:00 Europe/London (2026-09-22 14:00 UTC), 45 min (meeting ${next.id})`)
      expect(summary).toContain('No invitation or message was sent — tell the people involved from your own calendar.')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)

      expect(agentRows()).toEqual([{
        action: 'agent.reschedule_meeting',
        detail: { meetingId: original.id, replacementId: next.id, startsAt: '2026-09-22T14:00:00.000Z', timeZone: 'Europe/London' },
      }])
      idsOnly(agentRows()[0]!.detail)
      expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain('Priya')
    })

    it('records the new time in the zone it was agreed in, when one is named', async () => {
      const original = await meeting({ startsAt: at(-1 * HOUR) })
      const summary = summaryOf(
        await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-22T15:00:00+05:30', timeZone: 'Asia/Kolkata' }),
      )
      expect(summary).toContain('the new meeting is 2026-09-22 15:00 Asia/Kolkata (2026-09-22 09:30 UTC)')
    })

    it('refuses a meeting that has not started, and points at cancel and book instead', async () => {
      const upcoming = await meeting({ startsAt: at(1 * DAY) })
      const out = await run(rescheduleMeetingTool, { meetingId: upcoming.id, startsAt: '2026-09-22T14:00:00Z' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain('This meeting has not started yet')
      expect(messageOf(out)).toContain('cancel_meeting, then book_meeting')
      expect(await db.select().from(schema.meetings)).toHaveLength(1)
      expect((await meetingRow(upcoming.id)).outcome).toBeNull()
      expect(audited).toEqual([])
    })

    it('refuses to reschedule the same meeting twice, so no replacement is orphaned', async () => {
      const original = await meeting({ startsAt: at(-1 * HOUR) })
      summaryOf(await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-22T14:00:00Z' }))
      const again = await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-23T14:00:00Z' })
      expect(again).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(again)).toContain('This meeting was already rescheduled — change the new meeting instead.')
      expect(await db.select().from(schema.meetings)).toHaveLength(2)
    })

    it('refuses a cancelled meeting', async () => {
      const calledOff = await meeting({ startsAt: at(-1 * HOUR), cancelledAt: at(-2 * HOUR) })
      const out = await run(rescheduleMeetingTool, { meetingId: calledOff.id, startsAt: '2026-09-22T14:00:00Z' })
      expect(messageOf(out)).toContain('This meeting was cancelled')
      expect(await db.select().from(schema.meetings)).toHaveLength(1)
    })

    it.each([
      ['words', 'Thursday at 2'],
      ['a wall-clock time with no offset', '2026-09-22T15:00'],
      ['a day that does not exist', '2026-02-30T10:00:00Z'],
    ])('refuses %s as the new time, and writes nothing', async (_label, startsAt) => {
      const original = await meeting({ startsAt: at(-1 * HOUR) })
      const out = await run(rescheduleMeetingTool, { meetingId: original.id, startsAt })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain('is not an ISO 8601 instant with its offset')
      expect(await db.select().from(schema.meetings)).toHaveLength(1)
      expect((await meetingRow(original.id)).outcome).toBeNull()
    })

    it('refuses a zone the runtime does not know, and writes nothing', async () => {
      const original = await meeting({ startsAt: at(-1 * HOUR) })
      const out = await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-22T14:00:00Z', timeZone: 'Mars/Olympus' })
      expect(messageOf(out)).toContain('is not a timezone this system recognises')
      expect((await meetingRow(original.id)).outcome).toBeNull()
      expect(await db.select().from(schema.meetings)).toHaveLength(1)
    })

    it('answers another org’s meeting like none, and leaves it alone', async () => {
      const [theirs] = await db
        .insert(schema.meetings)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, startsAt: at(-1 * HOUR), timeZone: 'UTC' })
        .returning()
      const out = await run(rescheduleMeetingTool, { meetingId: theirs!.id, startsAt: '2026-09-22T14:00:00Z' })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      expect((await meetingRow(theirs!.id)).outcome).toBeNull()
      expect(await db.select().from(schema.meetings)).toHaveLength(1)
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      const original = await meeting({ startsAt: at(-1 * HOUR) })
      expect(await run(rescheduleMeetingTool, { meetingId: original.id, startsAt: '2026-09-22T14:00:00Z' }, guest()))
        .toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await meetingRow(original.id)).outcome).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('cancel_meeting', () => {
    it('calls the meeting off in the CRM, tells nobody, and says nothing was sent', async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' })
      const m = await meeting({ startsAt: at(2 * DAY), notes: 'PRIVATE NOTES about the call' })
      const out = await run(cancelMeetingTool, { meetingId: m.id })
      const summary = summaryOf(out)
      expect((await meetingRow(m.id)).cancelledAt).not.toBeNull()
      expect((await logOf('meeting.cancelled')).map((l) => [l.actor, l.subjectId])).toEqual([['agent', m.id]])
      expect(summary).toContain(`Cancelled the meeting with rentman.io “Intro call” at 2026-09-17 13:00 Europe/London (2026-09-17 12:00 UTC) (meeting ${m.id})`)
      expect(summary).toContain('Nobody is told by this')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      // The deal is not moved by a cancellation.
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('meeting')
      expect(agentRows()).toEqual([{ action: 'agent.cancel_meeting', detail: { meetingId: m.id, companyId } }])
      expect(JSON.stringify(audited)).not.toContain('PRIVATE')
    })

    /** "It was held" and "it was called off" are opposite facts. */
    it('refuses a meeting whose outcome is recorded, in the route’s words', async () => {
      const m = await meeting({ startsAt: at(-1 * DAY), outcome: 'held' })
      const out = await run(cancelMeetingTool, { meetingId: m.id })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain(
        'What happened at this meeting is already recorded, so it cannot be called off. Correct the outcome instead',
      )
      expect((await meetingRow(m.id)).cancelledAt).toBeNull()
      expect(await logOf('meeting.cancelled')).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses one already cancelled', async () => {
      const m = await meeting({ cancelledAt: at(-1 * HOUR) })
      expect(messageOf(await run(cancelMeetingTool, { meetingId: m.id }))).toContain('This meeting is already cancelled.')
    })

    it('answers another org’s meeting like none, and leaves it alone', async () => {
      const [theirs] = await db
        .insert(schema.meetings)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, startsAt: at(1 * DAY), timeZone: 'UTC' })
        .returning()
      expect(await run(cancelMeetingTool, { meetingId: theirs!.id })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await meetingRow(theirs!.id)).cancelledAt).toBeNull()
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      const m = await meeting()
      expect(await run(cancelMeetingTool, { meetingId: m.id }, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await meetingRow(m.id)).cancelledAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('record_meeting_outcome', () => {
    beforeEach(async () => {
      await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' })
    })

    it('records a meeting that has started as held, through the db writer, and moves no deal', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR) })
      const out = await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' })
      const summary = summaryOf(out)
      expect((await meetingRow(m.id)).outcome).toBe('held')
      const log = await logOf('meeting.outcome_recorded')
      expect(log.map((l) => [l.actor, l.subjectId, (l.detail as { outcome: string }).outcome])).toEqual([['agent', m.id, 'held']])
      expect((await openDealFor(db, orgId, companyId))!.stage).toBe('meeting')
      expect(summary).toContain(`(meeting ${m.id}) as held.`)
      expect(summary).toContain('It does not move the deal')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      expect(agentRows()).toEqual([{
        action: 'agent.record_meeting_outcome', detail: { meetingId: m.id, companyId, outcome: 'held', previous: null },
      }])
      idsOnly(agentRows()[0]!.detail)
    })

    it('says a no-show does not move the deal, and leaves it open where it was', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR) })
      const summary = summaryOf(await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'no_show' }))
      expect(summary).toContain('as a no-show.')
      expect(summary).toContain('A no-show does not move the deal — it is not a lost deal.')
      const deal = await openDealFor(db, orgId, companyId)
      expect(deal).toMatchObject({ stage: 'meeting', closedAt: null })
    })

    it('corrects one outcome with the other, each leaving its own row', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR) })
      summaryOf(await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' }))
      const summary = summaryOf(await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'no_show' }))
      expect(summary).toContain('(it was recorded as held; corrected)')
      expect((await meetingRow(m.id)).outcome).toBe('no_show')
      expect(await logOf('meeting.outcome_recorded')).toHaveLength(2)
      expect(agentRows()[1]!.detail).toMatchObject({ outcome: 'no_show', previous: 'held' })
    })

    it('refuses a meeting that has not started yet, in the route’s words', async () => {
      const m = await meeting({ startsAt: at(1 * HOUR) })
      const out = await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain('This meeting has not started yet, so nothing has happened at it to record.')
      expect((await meetingRow(m.id)).outcome).toBeNull()
      expect(await logOf('meeting.outcome_recorded')).toEqual([])
      expect(audited).toEqual([])
    })

    it('refuses a meeting already rescheduled — the replacement is where it is recorded', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR) })
      const r = await rescheduleMeeting(db, { orgId, id: m.id, startsAt: at(1 * DAY), timeZone: 'Europe/London', actor: userId, now: NOW })
      if (!r.ok) throw new Error(r.message)
      const out = await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' })
      expect(messageOf(out)).toContain('This meeting was already rescheduled — change the new meeting instead.')
      expect((await meetingRow(m.id)).outcome).toBe('rescheduled')
    })

    it('refuses a cancelled meeting', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR), cancelledAt: at(-3 * HOUR) })
      expect(messageOf(await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' }))).toContain('This meeting was cancelled')
      expect((await meetingRow(m.id)).outcome).toBeNull()
    })

    it('takes held or no_show only: a meeting that moved is reschedule_meeting', () => {
      expect(z.object(recordMeetingOutcome.shape).safeParse({ meetingId: '44444444-4444-4444-8444-444444444444', outcome: 'rescheduled' }).success).toBe(false)
    })

    it('answers another org’s meeting like none, and leaves it alone', async () => {
      const [theirs] = await db
        .insert(schema.meetings)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, startsAt: at(-1 * DAY), timeZone: 'UTC' })
        .returning()
      expect(await run(recordMeetingOutcome, { meetingId: theirs!.id, outcome: 'held' })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await meetingRow(theirs!.id)).outcome).toBeNull()
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      const m = await meeting({ startsAt: at(-2 * HOUR) })
      expect(await run(recordMeetingOutcome, { meetingId: m.id, outcome: 'held' }, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await meetingRow(m.id)).outcome).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('set_deal_owner', () => {
    let dealId: string
    let otherDealId: string

    beforeEach(async () => {
      const [deal] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'meeting' }).returning({ id: schema.deals.id })
      dealId = deal!.id
      const [theirs] = await db
        .insert(schema.deals)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, stage: 'replied' })
        .returning({ id: schema.deals.id })
      otherDealId = theirs!.id
    })

    const ownerOf = async (id: string) =>
      (await db.select({ owner: schema.deals.ownerUserId }).from(schema.deals).where(eq(schema.deals.id, id)))[0]!.owner

    it('assigns the company’s open deal to a teammate, with the row the board’s route writes', async () => {
      const out = await run(setDealOwnerTool, { domain: 'rentman.io', ownerEmail: 'Sam@Agency.test' })
      const summary = summaryOf(out)
      expect(await ownerOf(dealId)).toBe(samId)
      const log = await logOf('deal.updated')
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor: 'agent', subjectType: 'deal', subjectId: dealId })
      expect(log[0]!.detail).toEqual({ companyId, from: 'meeting', to: 'meeting', ownerUserId: samId })
      expect(summary).toContain(`Assigned the deal for rentman.io (deal ${dealId}, at meeting) to Sam Okafor — it had no owner.`)
      expect(summary).toContain('nobody is notified')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      expect(agentRows()).toEqual([{
        action: 'agent.set_deal_owner', detail: { dealId, companyId, ownerUserId: samId, previousOwnerUserId: null },
      }])
      idsOnly(agentRows()[0]!.detail)
    })

    it('reaches a deal by its id, and clears its owner', async () => {
      await db.update(schema.deals).set({ ownerUserId: samId }).where(eq(schema.deals.id, dealId))
      const summary = summaryOf(await run(setDealOwnerTool, { dealId, clear: true }))
      expect(await ownerOf(dealId)).toBeNull()
      expect(summary).toContain(`Unassigned the deal for rentman.io (deal ${dealId}, at meeting) — it was Sam Okafor’s.`)
      expect((await logOf('deal.updated'))[0]!.detail).toMatchObject({ ownerUserId: null })
      expect(agentRows()[0]!.detail).toEqual({ dealId, companyId, ownerUserId: null, previousOwnerUserId: samId })
    })

    it.each([
      ['a teammate in another org', 'outsider@rival.test'],
      ['a revoked teammate', 'gone@agency.test'],
      ['nobody at all', 'nobody@agency.test'],
    ])('refuses %s in one sentence, and changes nothing', async (_label, ownerEmail) => {
      const out = await run(setDealOwnerTool, { domain: 'rentman.io', ownerEmail })
      expect(out).toMatchObject({ ok: false, code: 'not_found' })
      expect(messageOf(out)).toContain('they are not on this team, or their access is revoked')
      expect(messageOf(out)).not.toContain(outsiderId)
      expect(messageOf(out)).not.toContain(goneId)
      expect(await ownerOf(dealId)).toBeNull()
      expect(await logOf('deal.updated')).toEqual([])
      expect(audited).toEqual([])
    })

    it('answers another org’s deal, by id or by domain, like none, and leaves it alone', async () => {
      expect(await run(setDealOwnerTool, { dealId: otherDealId, ownerEmail: 'sam@agency.test' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await run(setDealOwnerTool, { domain: 'theirs.io', ownerEmail: 'sam@agency.test' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await ownerOf(otherDealId)).toBeNull()
      expect(await logOf('deal.updated')).toEqual([])
    })

    it('says a company with no open deal has none to assign', async () => {
      await db.update(schema.deals).set({ stage: 'won', closedAt: NOW }).where(eq(schema.deals.id, dealId))
      const out = await run(setDealOwnerTool, { domain: 'rentman.io', ownerEmail: 'sam@agency.test' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain('rentman.io has no open deal to assign; update_deal opens one.')
      expect(await ownerOf(dealId)).toBeNull()
    })

    it('asks for exactly one deal and exactly one owner', async () => {
      for (const input of [
        { ownerEmail: 'sam@agency.test' },
        { domain: 'rentman.io', dealId, ownerEmail: 'sam@agency.test' },
        { domain: 'rentman.io' },
        { domain: 'rentman.io', ownerEmail: 'sam@agency.test', clear: true },
      ]) {
        expect(await run(setDealOwnerTool, input), JSON.stringify(input)).toMatchObject({ ok: false, code: 'invalid_state' })
      }
      expect(await ownerOf(dealId)).toBeNull()
    })

    it('refuses a role can() does not know, and writes nothing', async () => {
      expect(await run(setDealOwnerTool, { domain: 'rentman.io', ownerEmail: 'sam@agency.test' }, guest()))
        .toMatchObject({ ok: false, code: 'not_permitted' })
      expect(await ownerOf(dealId)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('complete_task', () => {
    const task = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
      const [row] = await db
        .insert(schema.tasks)
        .values({ orgId, companyId, kind: 'todo', title: 'Send the scope to Priya', ...over })
        .returning()
      return row!
    }
    const taskRow = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!

    it('marks a task done in the name of the person you are helping, through the db writer', async () => {
      const t = await task()
      const out = await run(completeTask, { taskId: t.id })
      const summary = summaryOf(out)
      expect(await taskRow(t.id)).toMatchObject({ doneAt: NOW, doneBy: userId })
      expect((await logOf('task.completed')).map((l) => [l.actor, l.subjectId])).toEqual([['agent', t.id]])
      expect(summary).toContain(`Marked the task “Send the scope to Priya” about rentman.io (task ${t.id}) done`)
      expect(summary).toContain('the audit log records that the agent did it')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      expect(agentRows()).toEqual([{ action: 'agent.complete_task', detail: { taskId: t.id, companyId, alreadyDone: false } }])
      idsOnly(agentRows()[0]!.detail)
      expect(JSON.stringify(audited)).not.toContain('Priya')
    })

    it('leaves a task already done as it was', async () => {
      const t = await task({ doneAt: at(-1 * DAY), doneBy: samId })
      const out = await run(completeTask, { taskId: t.id })
      const summary = summaryOf(out)
      expect(await taskRow(t.id)).toMatchObject({ doneAt: at(-1 * DAY), doneBy: samId })
      expect(await logOf('task.completed')).toEqual([])
      expect(summary).toContain('was already done (2026-09-14 12:00 UTC), so it was left as it was.')
      expect(summary.endsWith(NOTHING_SENT)).toBe(true)
      expect(agentRows()[0]!.detail).toEqual({ taskId: t.id, companyId, alreadyDone: true })
    })

    /** Ticking it would say a message went that no send rule checked. */
    it('refuses a LinkedIn step with the route’s sentence, and leaves it open', async () => {
      const [touch] = await db
        .insert(schema.touches)
        .values({ orgId, companyId, channel: 'linkedin', direction: 'out', status: 'awaiting_approval', subject: 's', body: 'b' })
        .returning({ id: schema.touches.id })
      const t = await task({ kind: 'linkedin_send', title: 'Send on LinkedIn', touchId: touch!.id })
      const out = await run(completeTask, { taskId: t.id })
      expect(out).toMatchObject({ ok: false, code: 'invalid_state' })
      expect(messageOf(out)).toContain(
        'A LinkedIn step is completed by sending the message and pressing "I sent it", which checks every send rule first.',
      )
      expect((await taskRow(t.id)).doneAt).toBeNull()
      expect(await logOf('task.completed')).toEqual([])
      expect(audited).toEqual([])
    })

    it('answers another org’s task like none, and leaves it alone', async () => {
      const [theirs] = await db
        .insert(schema.tasks)
        .values({ orgId: otherOrgId, companyId: otherCompanyId, kind: 'todo', title: 'Theirs' })
        .returning()
      expect(await run(completeTask, { taskId: theirs!.id })).toMatchObject({ ok: false, code: 'not_found' })
      expect((await taskRow(theirs!.id)).doneAt).toBeNull()
    })

    it('refuses a role can() does not know, and a person whose access is revoked, and writes nothing', async () => {
      const t = await task()
      expect(await run(completeTask, { taskId: t.id }, guest())).toMatchObject({ ok: false, code: 'not_permitted' })
      await db.update(schema.users).set({ revokedAt: at(-1 * HOUR) }).where(eq(schema.users.id, userId))
      expect(await run(completeTask, { taskId: t.id })).toMatchObject({ ok: false, code: 'not_permitted' })
      expect((await taskRow(t.id)).doneAt).toBeNull()
      expect(audited).toEqual([])
    })
  })
})
