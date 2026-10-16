/**
 * The ops tools — the worker, in chat, in place of a terminal — against a
 * real Postgres engine, with a FAKE `ctx.ops`: a health object, a log ring
 * and a scanner written here. No test touches the network.
 *
 * The rules asserted are the ones these tools exist to keep while a person
 * debugs a deployment through a model:
 *
 *  - nothing a log line or a heartbeat carried beyond its kind reaches the
 *    model — no host, no id, no address (§2.3);
 *  - the queue is counts, never a recipient, a subject or a body;
 *  - a rescan reads public pages only, never picks an inbound lead or a host
 *    the scanner refuses, judges freshness by `ran_at` and never by
 *    `findings.stale`, stands aside while the nightly run holds the org, and
 *    reports an unreachable site as unreachable — never a score of 0 (§2.2);
 *  - each call writes exactly one audit row of counts, ids and words.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENCY_TOOL_RISK, parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile,
} from '@agency/core'
import { EXPECTED_MIGRATION, SEED_DIR, createChatSession, importCompanies, recordScan, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import {
  AGENCY_TOOLS, queueStatus, recentErrors, rescanStale, workerStatus,
  type AgencyToolSpec, type OpsContext, type OpsHealth, type OpsLogEntry, type OpsScan, type ToolContext,
} from '../src/index.js'
import { makeRescanStale } from '../src/ops.js'

const icp: IcpDefinition = parseIcpDefinition(
  JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')),
)

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

function reached(domain: string, gaps: readonly string[] = ['csp']): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = gaps.includes(key)
      ? { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
      : { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  return {
    domain, company: domain, title: domain, fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
  }
}

function unreachable(domain: string): SiteProfile {
  return {
    domain, company: '', title: '', fetchOk: false,
    // What `describe()` in the scanner writes: a code, then a message that names the host.
    fetchError: 'ENOTFOUND: getaddrinfo ENOTFOUND unreached.io 10.9.8.7',
    hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations: {},
  }
}

describe('the ops tools', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let otherUserId: string
  let icpProfile: { id: string; definition: IcpDefinition }
  let NOW: Date
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    // The wall clock, not a fixed date: a scan this test records is stamped
    // by the database's own now(), and must read as fresh against it.
    NOW = new Date()

    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
    const [otherUser] = await db
      .insert(schema.users).values({ orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' })
      .returning({ id: schema.users.id })
    otherUserId = otherUser!.id
    const [profile] = await db
      .insert(schema.icpProfiles)
      .values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown>, active: true })
      .returning({ id: schema.icpProfiles.id })
    icpProfile = { id: profile!.id, definition: icp }
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const health = (over: Partial<OpsHealth> = {}): OpsHealth => ({
    halted: false,
    lockHeld: true,
    outreach: 'send-and-receive',
    sms: 'on',
    chat: 'enabled',
    bootedAt: new Date(NOW.getTime() - 2 * HOUR),
    version: '0.1.0',
    heartbeatWrittenAt: new Date(NOW.getTime() - 10_000),
    ...over,
  })

  const opsWith = (over: { health?: Partial<OpsHealth>; log?: readonly OpsLogEntry[]; scan?: OpsScan } = {}): OpsContext => ({
    health: () => health(over.health),
    recentLog: () => over.log ?? [],
    ...(over.scan ? { scan: over.scan } : {}),
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

  /** Run a tool the way the adapter will: parse with zod, then hand over. */
  const run = async <S extends z.ZodRawShape>(spec: AgencyToolSpec<S>, input: unknown, over: Partial<ToolContext> = {}) =>
    spec.handler(z.object(spec.shape).parse(input) as never, ctx(over))

  const nobody = { id: 'x', orgId: '', role: 'guest' } as unknown as ToolContext['principal']

  it('registers four tools: three reads and a scan, all low risk', () => {
    for (const name of ['worker_status', 'recent_errors', 'queue_status', 'rescan_stale'] as const) {
      expect(AGENCY_TOOLS.map((t) => t.name)).toContain(name)
      expect(AGENCY_TOOL_RISK[name][0]).toBe('low')
    }
    for (const t of [workerStatus, recentErrors, queueStatus, rescanStale]) {
      expect(t.description.length, t.name).toBeGreaterThan(80)
      expect(Object.keys(t.shape), t.name).not.toContain('channel')
      expect(t.description, t.name).not.toMatch(/not available in this revision/i)
    }
    expect(AGENCY_TOOL_RISK.rescan_stale[1]).toBe('derived_write')
  })

  // -------------------------------------------------------------------------
  // worker_status
  // -------------------------------------------------------------------------

  describe('worker_status', () => {
    const SECRET_WORKER_ID = 'worker-7.internal.example:4242'

    const beat = async (lastTickAt: Date, detail: Record<string, unknown> = {}, over: { outreach?: string } = {}) => {
      await db.insert(schema.workerHeartbeats).values({
        workerId: SECRET_WORKER_ID,
        bootedAt: new Date(lastTickAt.getTime() - HOUR),
        lastTickAt,
        outreach: 'send-and-receive',
        chat: 'enabled',
        detail: { halted: false, lockHeld: true, sms: 'on', intervalMs: 15_000, version: '0.1.0', ...detail },
        ...over,
      })
    }

    it('with no heartbeat and no view of its own, says no worker has ever written one — and claims nothing more', async () => {
      const out = await run(workerStatus, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { heartbeat: { status: string }; schema: { state: string }; worker: unknown }
      expect(data.heartbeat.status).toBe('not_configured')
      expect(data.worker).toBeNull()
      // Whatever this checkout's newest migration is: the harness applies them all.
      expect(data.schema).toMatchObject({ state: 'ok', expected: EXPECTED_MIGRATION, applied: EXPECTED_MIGRATION })
      expect(out.summary).toContain('No worker has ever written a heartbeat to this database')
      expect(out.summary).toContain(
        `Schema: the database is at migration ${EXPECTED_MIGRATION}, which is what this code expects.`,
      )
      expect(out.summary).toContain('not available in this context')
      expect(audited).toEqual([{ action: 'agent.worker_status', detail: { status: 'not_configured', schema: 'ok', ownView: false } }])
    })

    it('with its own view and no heartbeat, says not even the worker answering has written one', async () => {
      const out = await run(workerStatus, {}, {
        ops: opsWith({ health: { heartbeatWrittenAt: null, version: null, lockHeld: null } }),
      })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.data as { heartbeat: { status: string } }).heartbeat.status).toBe('never')
      expect(out.summary).toContain('not even the one answering you now')
      expect(out.summary).toContain('None of its own heartbeats has reached the database since it booted')
      expect(out.summary).toContain('version not recorded (started without npm)')
      expect(out.summary).toContain('Single-worker lock: not taken yet.')
      expect(audited[0]).toEqual({ action: 'agent.worker_status', detail: { status: 'never', schema: 'ok', ownView: true } })
    })

    it('words a live heartbeat the way the dashboard does, and never prints the worker’s host', async () => {
      await beat(new Date(NOW.getTime() - 30_000))
      const out = await run(workerStatus, {}, { ops: opsWith() })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { heartbeat: { status: string; sms: string; chat: string; ageSeconds: number } }
      expect(data.heartbeat).toMatchObject({ status: 'live', sms: 'on', chat: 'enabled' })
      expect(out.summary).toContain(
        'Worker: live — last heard from less than a minute ago · sending and receiving email · texts through DoveSoft · chat on.',
      )
      // The worker's own view, read from the same object /readyz answers from.
      expect(out.summary).toContain('Runtime: not halted.')
      expect(out.summary).toContain('Single-worker lock: held.')
      expect(out.summary).toContain('Mailbox: sends email and reads replies. SMS: on — approved texts go through DoveSoft. Chat: on.')
      expect(out.summary).toContain('version 0.1.0')
      expect(out.summary).toContain('Its own heartbeat last reached the database less than a minute ago.')
      for (const secret of ['worker-7', 'internal.example', '4242']) {
        expect(out.summary).not.toContain(secret)
        expect(JSON.stringify(out.data)).not.toContain(secret)
      }
    })

    it('says SMS off only where the mail words could be read as covering texts', async () => {
      await beat(new Date(NOW.getTime() - 30_000), { sms: 'off' }, { outreach: 'send-only' })
      const out = await run(workerStatus, {})
      expect(out.ok && out.summary).toContain('Worker: live — last heard from less than a minute ago · sending, not reading replies · SMS off · chat on.')
    })

    it('calls a heartbeat older than its threshold silent, and says the answering worker’s own is not landing', async () => {
      await beat(new Date(NOW.getTime() - 2 * HOUR))
      const out = await run(workerStatus, {}, { ops: opsWith({ health: { heartbeatWrittenAt: null } }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.data as { heartbeat: { status: string } }).heartbeat.status).toBe('silent')
      expect(out.summary).toContain('Worker: silent since')
      expect(out.summary).toContain('2 hours without a heartbeat')
      expect(out.summary).toContain('its own heartbeat is not reaching the database')
    })

    it('calls a week-old heartbeat retired where no worker is answering', async () => {
      await beat(new Date(NOW.getTime() - 8 * DAY))
      const out = await run(workerStatus, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.data as { heartbeat: { status: string } }).heartbeat.status).toBe('retired')
      expect(out.summary).toContain('Worker: retired — last seen')
      expect(audited[0]!.detail).toMatchObject({ status: 'retired' })
    })

    it('reports a halted runtime and a lost lock, from the row and from the worker’s own view', async () => {
      await beat(new Date(NOW.getTime() - 30_000), { halted: true, lockHeld: false })
      const out = await run(workerStatus, {}, { ops: opsWith({ health: { halted: true, lockHeld: false } }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.summary).toContain('At that heartbeat it reported its runtime HALTED')
      expect(out.summary).toContain('refuses every chat turn')
      expect(out.summary).toContain('At that heartbeat it reported its single-worker lock LOST')
      expect(out.summary).toContain('Runtime: HALTED')
      expect(out.summary).toContain('Single-worker lock: LOST')
    })

    it('computes the schema as /api/health does: behind when the ledger is short of this code', async () => {
      // The ledger one short of this code, whichever migration is newest.
      const previous = String(Number(EXPECTED_MIGRATION) - 1).padStart(4, '0')
      await db.execute(sql`DELETE FROM schema_migrations WHERE version = ${EXPECTED_MIGRATION}`)
      const out = await run(workerStatus, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.data as { schema: unknown }).schema).toEqual({ state: 'behind', expected: EXPECTED_MIGRATION, applied: previous })
      expect(out.summary).toContain(`the database is at migration ${previous} and this code expects ${EXPECTED_MIGRATION}`)
      expect(out.summary).toContain('migrate first')
    })

    it('fails closed for a role can() does not know, and audits nothing', async () => {
      const out = await run(workerStatus, {}, { principal: nobody })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('not_permitted')
      expect(audited).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // recent_errors
  // -------------------------------------------------------------------------

  describe('recent_errors', () => {
    const at = (minutesAgo: number): Date => new Date(NOW.getTime() - minutesAgo * MINUTE)

    it('without the worker’s own view, says this context keeps no worker log', async () => {
      const out = await run(recentErrors, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.summary).toContain('This context keeps no worker log')
      expect(audited).toEqual([{ action: 'agent.recent_errors', detail: { returned: 0, kinds: 0, ownView: false } }])
    })

    it('says so when the worker has logged nothing since it booted', async () => {
      const out = await run(recentErrors, {}, { ops: opsWith() })
      expect(out.ok && out.summary).toContain('No warning or error has been logged by the worker answering you since it booted')
    })

    it('lists kinds the most recently seen first, with level, count, instants and the error class', async () => {
      const log: OpsLogEntry[] = [
        { level: 'warn', msg: 'heartbeat not written; the worker carries on', count: 4, firstAt: at(50), lastAt: at(20), error: 'ConnectionError' },
        { level: 'error', msg: 'agency tool threw', count: 1, firstAt: at(5), lastAt: at(5), error: 'TypeError' },
        { level: 'warn', msg: 'sms rows waiting: no provider', count: 2, firstAt: at(40), lastAt: at(30) },
      ]
      const out = await run(recentErrors, { limit: 2 }, { ops: opsWith({ log }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const data = out.data as { kinds: number; returned: number; entries: Array<{ message: string; count: number; error: string | null }> }
      expect(data.kinds).toBe(3)
      expect(data.returned).toBe(2)
      expect(data.entries.map((e) => e.message)).toEqual(['agency tool threw', 'heartbeat not written; the worker carries on'])
      expect(out.summary).toContain('3 kinds of warning and error')
      expect(out.summary).toContain('showing 2')
      expect(out.summary).toContain('error ×1  agency tool threw (TypeError)')
      expect(out.summary).toContain('warn  ×4  heartbeat not written; the worker carries on (ConnectionError)')
      expect(out.summary).toContain('never a value the line carried')
      expect(out.summary).not.toContain('sms rows waiting')
      expect(audited).toEqual([{ action: 'agent.recent_errors', detail: { returned: 2, kinds: 3, ownView: true } }])
    })

    it('never shows a field value, even from a log ring that kept one', async () => {
      // A ring built somewhere else, that did not drop what it should have.
      const leaky = {
        level: 'error',
        msg: 'imap reconnecting',
        count: 1,
        firstAt: at(3),
        lastAt: at(3),
        error: 'connect ECONNREFUSED 10.1.2.3:993',
        host: 'imap.secret-mail.example',
        touchIds: ['5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'],
        email: 'jane@prospect.example',
      } as unknown as OpsLogEntry
      const out = await run(recentErrors, {}, { ops: opsWith({ log: [leaky] }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      for (const value of ['10.1.2.3', 'ECONNREFUSED', 'secret-mail', '5d4c3b2a', 'jane@prospect.example']) {
        expect(out.summary).not.toContain(value)
        expect(JSON.stringify(out.data)).not.toContain(value)
      }
      expect(out.summary).toContain('error ×1  imap reconnecting —')
    })
  })

  // -------------------------------------------------------------------------
  // queue_status
  // -------------------------------------------------------------------------

  describe('queue_status', () => {
    const SECRETS = ['SECRET SUBJECT', 'SECRET BODY', 'jane@acme.io', '+919876543210']

    beforeEach(async () => {
      await importCompanies(db, orgId, [{ domain: 'acme.io', name: 'Acme' }])
      await importCompanies(db, otherOrgId, [{ domain: 'rival.io', name: 'Rival' }])
      const [acme] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'acme.io'))
      const [rival] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'rival.io'))
      const [template] = await db
        .insert(schema.messageTemplates)
        .values({ orgId, channel: 'sms', externalId: '1107000000000001', senderId: 'ACMEIN', category: 'transactional', body: 'Hi {#var#}' })
        .returning({ id: schema.messageTemplates.id })

      const words = { subject: 'SECRET SUBJECT', body: 'SECRET BODY' }
      const ago = (ms: number) => new Date(NOW.getTime() - ms)
      const out = { orgId, companyId: acme!.id, direction: 'out', ...words }
      const approved = { approvedBy: userId, approvedAt: ago(HOUR) }
      const rows = await db
        .insert(schema.touches)
        .values([
          { ...out, channel: 'email', status: 'awaiting_approval', recipient: 'jane@acme.io' },
          { ...out, channel: 'email', status: 'awaiting_approval' },
          { ...out, channel: 'sms', status: 'awaiting_approval', templateId: template!.id, recipient: '+919876543210' },
          { ...out, channel: 'email', status: 'approved', ...approved },
          { ...out, channel: 'email', status: 'approved', ...approved, scheduledFor: new Date(NOW.getTime() + 2 * HOUR) },
          { ...out, channel: 'sms', status: 'approved', ...approved, templateId: template!.id, recipient: '+919876543210' },
          { ...out, channel: 'linkedin', status: 'approved', ...approved },
          { ...out, channel: 'email', status: 'queued' },
          { ...out, channel: 'email', status: 'sending', createdAt: ago(30 * MINUTE), updatedAt: ago(5 * MINUTE) },
          { ...out, channel: 'email', status: 'refused', refusalCode: 'suppressed', createdAt: ago(2 * HOUR) },
          { ...out, channel: 'email', status: 'refused', refusalCode: 'suppressed', createdAt: ago(3 * HOUR) },
          { ...out, channel: 'email', status: 'refused', refusalCode: 'stale_evidence', createdAt: ago(2 * DAY), updatedAt: ago(HOUR) },
          { ...out, channel: 'email', status: 'refused', refusalCode: 'suppressed', createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY) },
          { ...out, channel: 'sms', status: 'failed', createdAt: ago(5 * HOUR), updatedAt: ago(HOUR) },
          { ...out, channel: 'email', status: 'failed', createdAt: ago(2 * DAY), updatedAt: ago(2 * DAY) },
          { ...out, channel: 'email', status: 'sent', sentAt: ago(HOUR) },
          { ...out, channel: 'email', direction: 'in', status: 'sent' },
          // Another org's queue, which must not be counted here.
          { orgId: otherOrgId, companyId: rival!.id, direction: 'out', channel: 'email', status: 'awaiting_approval' },
          { orgId: otherOrgId, companyId: rival!.id, direction: 'out', channel: 'email', status: 'approved', approvedBy: otherUserId, approvedAt: ago(HOUR) },
        ])
        .returning({ id: schema.touches.id, channel: schema.touches.channel, status: schema.touches.status })
      const linkedin = rows.find((r) => r.channel === 'linkedin')!

      // An agent's request names the turn and the call it gates (0007), or it cannot be stored.
      const session = await createChatSession(db, { orgId, userId })
      const otherSession = await createChatSession(db, { orgId: otherOrgId, userId: otherUserId })
      const traced = (chatSessionId: string) => ({
        requestedBy: 'agent', chatSessionId, turnId: randomUUID(), toolUseId: `toolu_${randomUUID()}`, payloadSha256: 'a'.repeat(64),
      })
      await db.insert(schema.approvals).values([
        { orgId, ...traced(session.id), toolName: 'mcp__agency__queue_touch', risk: 'high', expiresAt: new Date(NOW.getTime() + 10 * MINUTE) },
        { orgId, ...traced(session.id), toolName: 'mcp__agency__add_note', risk: 'medium', expiresAt: new Date(NOW.getTime() + 20 * MINUTE) },
        { orgId, ...traced(session.id), toolName: 'mcp__agency__add_note', risk: 'medium', expiresAt: ago(10 * MINUTE) },
        {
          orgId, ...traced(session.id), toolName: 'mcp__agency__add_note', risk: 'medium', status: 'approved',
          decidedBy: userId, decidedAt: ago(HOUR), expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
        },
        {
          orgId: otherOrgId, ...traced(otherSession.id), toolName: 'mcp__agency__add_note', risk: 'medium',
          expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
        },
      ])
      await db.insert(schema.tasks).values([
        { orgId, kind: 'linkedin_send', touchId: linkedin.id, title: 'Send a LinkedIn message' },
        { orgId, kind: 'todo', title: 'Call them back', doneAt: ago(HOUR), doneBy: userId },
      ])
    })

    interface Q {
      awaitingApproval: { total: number; byChannel: Record<string, number> }
      approved: { total: number; due: number; deferred: number; byChannel: Record<string, number>; nextAt: string | null }
      queued: { total: number; due: number }
      sending: { total: number; oldestClaimAt: string | null }
      refusedLast24h: { total: number; byCode: Record<string, number> }
      failedLast24h: { total: number; byChannel: Record<string, number> }
      agentApprovals: { pending: number; expired: number }
      linkedinSteps: { open: number }
      waitingWithoutProvider: { sms: number | null; email: number | null }
    }

    it('counts this org’s outbound messages by status and channel, and nothing of another org', async () => {
      const out = await run(queueStatus, {}, { ops: opsWith() })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const q = out.data as Q
      expect(q.awaitingApproval).toEqual({ total: 3, byChannel: { email: 2, sms: 1 } })
      expect(q.approved).toMatchObject({ total: 4, due: 3, deferred: 1, byChannel: { email: 2, sms: 1, linkedin: 1 } })
      expect(q.approved.nextAt).toBe(new Date(NOW.getTime() + 2 * HOUR).toISOString())
      expect(q.queued).toMatchObject({ total: 1, due: 1 })
      expect(q.sending).toEqual({ total: 1, byChannel: { email: 1 }, oldestClaimAt: new Date(NOW.getTime() - 5 * MINUTE).toISOString() })
      expect(q.refusedLast24h).toEqual({ total: 3, byCode: { suppressed: 2, stale_evidence: 1 } })
      expect(q.failedLast24h).toEqual({ total: 1, byChannel: { sms: 1 } })
      expect(q.agentApprovals).toEqual({ pending: 2, expired: 1 })
      expect(q.linkedinSteps).toEqual({ open: 1 })

      expect(out.summary).toContain('Awaiting a person on /approvals: 3 (email 2, sms 1).')
      expect(out.summary).toContain('Approved: 4 — due now 3 (email 1, linkedin 1, sms 1); deferred 1 (email 1), the earliest may go at')
      expect(out.summary).toContain('Being sent: 1 (email 1); the oldest claim was taken 5 minutes ago.')
      expect(out.summary).toContain('Refused in the last 24 hours: 3 — suppressed 2, stale_evidence 1.')
      expect(out.summary).toContain('Failed in the last 24 hours: 1 (sms 1).')
      expect(out.summary).toContain('Agent tool calls waiting on a person: 2 (and 1 past its expiry, not yet swept).')
      expect(out.summary).toContain('Open LinkedIn steps on /tasks: 1.')
      expect(out.summary).toContain('never by the worker')
    })

    it('never reads out a recipient, a subject or a body', async () => {
      const out = await run(queueStatus, {}, { ops: opsWith({ health: { sms: 'off' } }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      for (const secret of SECRETS) {
        expect(out.summary).not.toContain(secret)
        expect(JSON.stringify(out.data)).not.toContain(secret)
        expect(JSON.stringify(audited)).not.toContain(secret)
      }
    })

    it('names approved SMS waiting with no SMS provider when this worker has SMS off — the state its log line describes', async () => {
      const off = await run(queueStatus, {}, { ops: opsWith({ health: { sms: 'off' } }) })
      expect(off.ok).toBe(true)
      if (!off.ok) return
      expect((off.data as Q).waitingWithoutProvider).toEqual({ sms: 1, email: 0 })
      expect(off.summary).toContain('1 approved SMS (1 due now) waits with no SMS provider on this worker')
      expect(off.summary).toContain('DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID')
      expect(off.summary).toContain('"sms rows waiting: no provider"')

      const on = await run(queueStatus, {}, { ops: opsWith({ health: { sms: 'on' } }) })
      expect(on.ok && on.summary).not.toContain('no SMS provider')
      expect(on.ok && (on.data as Q).waitingWithoutProvider).toEqual({ sms: 0, email: 0 })
    })

    /**
     * The sender writes "sms rows waiting: no provider", and the worker starts
     * a sender only when it carries a mailbox or DoveSoft. One with neither
     * logs nothing of the kind (review round 16).
     */
    it('points at the sender’s log line only when this worker runs a sender', async () => {
      const none = await run(queueStatus, {}, { ops: opsWith({ health: { sms: 'off', outreach: 'receive-only' } }) })
      expect(none.ok).toBe(true)
      if (!none.ok) return
      expect(none.summary).toContain('1 approved SMS (1 due now) waits with no SMS provider on this worker')
      expect(none.summary).not.toContain('"sms rows waiting: no provider"')
      expect(none.summary).toContain('it runs no sender at all, and nothing in its log names this state')
    })

    /**
     * No column records when a message was refused, and any later UPDATE
     * re-stamps the row — deleting its contact is one. The lines say which
     * clock they read (review round 16).
     */
    it('says its 24 hours are by when each message last changed', async () => {
      const out = await run(queueStatus, {}, { ops: opsWith() })
      expect(out.ok && out.summary).toContain(
        'Refused and failed below count messages that last CHANGED in the last 24 hours: no column records the ' +
          'moment of a refusal itself, so a later change to an old one — deleting its contact, say — counts it again.',
      )
    })

    it('names approved email waiting with no mailbox when this worker sends no email', async () => {
      const out = await run(queueStatus, {}, { ops: opsWith({ health: { outreach: 'receive-only' } }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      // Two approved (one due) and one queued.
      expect((out.data as Q).waitingWithoutProvider.email).toBe(3)
      expect(out.summary).toContain('3 approved emails (2 due now) wait with no mailbox to send from on this worker')
    })

    it('without the worker’s own view, says whether it carries a channel is not visible here', async () => {
      const out = await run(queueStatus, {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect((out.data as Q).waitingWithoutProvider).toEqual({ sms: null, email: null })
      expect(out.summary).not.toContain('no SMS provider')
      expect(out.summary).toContain('not visible in this context')
    })

    it('audits counts and nothing else', async () => {
      await run(queueStatus, {}, { ops: opsWith({ health: { sms: 'off' } }) })
      expect(audited).toEqual([{
        action: 'agent.queue_status',
        detail: {
          awaiting: 3, approved: 4, queued: 1, sending: 1, refused: 3, failed: 1, agentApprovals: 2, linkedinSteps: 1,
          smsWithoutProvider: 1, emailWithoutProvider: 0, ownView: true,
        },
      }])
    })

    it('fails closed for a role can() does not know', async () => {
      const out = await run(queueStatus, {}, { principal: nobody })
      expect(out.ok ? 'ok' : out.code).toBe('not_permitted')
    })
  })

  // -------------------------------------------------------------------------
  // rescan_stale
  // -------------------------------------------------------------------------

  describe('rescan_stale', () => {
    const ids = new Map<string, string>()
    const scanned: string[] = []

    /** A fake scanner: every site answers, except the ones named. */
    const scanner = (over: { unreachable?: readonly string[]; slow?: Map<string, Promise<SiteProfile>> } = {}): OpsScan =>
      async (domain) => {
        scanned.push(domain)
        const slow = over.slow?.get(domain)
        if (slow) return { raw: { fake: true }, profile: await slow }
        return { raw: { fake: true }, profile: over.unreachable?.includes(domain) ? unreachable(domain) : reached(domain) }
      }

    /** Record a scan through the real writer, then pin when it ran. */
    const scanAt = async (domain: string, ranAt: Date, profile: SiteProfile) => {
      const out = await recordScan(db, { orgId, companyId: ids.get(domain)!, icpProfile, raw: {}, profile: { ...profile, domain } })
      await db.update(schema.scans).set({ ranAt }).where(eq(schema.scans.id, out.scanId))
      return out
    }

    const scansOf = async (domain: string) =>
      db.select().from(schema.scans).where(eq(schema.scans.companyId, ids.get(domain)!))

    beforeEach(async () => {
      scanned.length = 0
      ids.clear()
      await importCompanies(db, orgId, [
        { domain: 'fresh.io', name: 'Fresh' },
        { domain: 'intranet.corp', name: 'Refused Host' },
        { domain: 'jane-doe-gmail-com.inbound', name: 'Jane Doe' },
        { domain: 'never.io', name: 'Never Scanned' },
        { domain: 'recent-fail.io', name: 'Tried This Morning' },
        { domain: 'stale-new.io', name: 'Stale New' },
        { domain: 'stale-old.io', name: 'Stale Old' },
        { domain: 'unreached.io', name: 'Never Reached' },
      ])
      // Another org's never-scanned company: a queue that leaked across orgs would take it.
      await importCompanies(db, otherOrgId, [{ domain: 'rival.io', name: 'Rival' }])
      for (const c of await db.select().from(schema.companies)) ids.set(c.domain, c.id)

      const ago = (ms: number) => new Date(NOW.getTime() - ms)
      await scanAt('fresh.io', ago(2 * DAY), reached('fresh.io'))
      await scanAt('stale-old.io', ago(40 * DAY), reached('stale-old.io'))
      await scanAt('stale-new.io', ago(20 * DAY), reached('stale-new.io'))
      await scanAt('unreached.io', ago(3 * DAY), unreachable('unreached.io'))
      await scanAt('recent-fail.io', ago(30 * DAY), reached('recent-fail.io'))
      await scanAt('recent-fail.io', ago(2 * HOUR), unreachable('recent-fail.io'))
    })

    interface R {
      due: number
      scanned: number
      reached: number
      unreachable: number
      abandoned: number
      failed: number
      stillRunning: number
      skipped: number
      waiting: number
      remaining: number
      cronRunning: boolean
      companies: Array<{ domain: string; outcome: string; score: number | null; scanId: string | null }>
    }

    it('takes the never-scanned, then the never-reached, then the oldest stale — skipping an inbound lead and a refused host without a slot', async () => {
      const out = await run(rescanStale, { limit: 3 }, { ops: opsWith({ scan: scanner({ unreachable: ['unreached.io'] }) }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const r = out.data as R
      // intranet.corp sorts first and is refused before it costs a slot; the
      // inbound lead is never in the queue at all.
      expect(scanned).toEqual(['never.io', 'unreached.io', 'stale-old.io'])
      expect(r.companies.map((c) => [c.domain, c.outcome])).toEqual([
        ['never.io', 'reached'], ['unreached.io', 'unreachable'], ['stale-old.io', 'reached'],
      ])
      expect(r).toMatchObject({
        due: 6, scanned: 3, reached: 2, unreachable: 1, stillRunning: 0, skipped: 1, waiting: 1, remaining: 4,
        cronRunning: false,
      })
      // The model reads the summary and nothing else: every company's outcome
      // and every count is in it.
      expect(out.summary).toContain(
        'Re-scanned 3 of the 6 companies whose evidence was stale or missing (no scan that reached the site in the last 14 days)',
      )
      expect(out.summary).toContain('posture review from the outside, not a security test')
      expect(out.summary).toMatch(/never\.io \(Never Scanned\) — reached the site: \d+\/100, /)
      expect(out.summary).toMatch(/stale-old\.io \(Stale Old\) — reached the site: \d+\/100, .* \(last observed \d{4}-\d{2}-\d{2}\)/)
      expect(out.summary).toContain('unreached.io (Never Reached) — did not reach the site')
      expect(out.summary).toContain('4 companies still have stale or missing evidence')
      expect(out.summary).toContain('1 more can be scanned by asking again')
      expect(out.summary).toContain('1 was tried in the last 20 hours')
      expect(out.summary).toContain('1 has a domain the scanner refuses to request')
      expect(out.summary).not.toContain('jane-doe')
      expect(out.summary).not.toContain('fresh.io')
    })

    it('records an unreachable site as unreachable — never a score of 0 — and quotes no address from the error', async () => {
      const out = await run(rescanStale, { limit: 3 }, { ops: opsWith({ scan: scanner({ unreachable: ['unreached.io'] }) }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const row = (out.data as R).companies.find((c) => c.domain === 'unreached.io')!
      expect(row.score).toBeNull()
      expect(row.scanId).not.toBeNull()
      expect(out.summary).toContain('unreached.io (Never Reached) — did not reach the site (ENOTFOUND); recorded as unreachable')
      expect(out.summary).toContain('not a 0')
      expect(out.summary).not.toContain('10.9.8.7')
      const stored = await scansOf('unreached.io')
      expect(stored.filter((s) => !s.ok)).toHaveLength(2)
    })

    it('writes each scan through the real writer: the scan, its findings and the score computed from it', async () => {
      await run(rescanStale, { limit: 1 }, { ops: opsWith({ scan: scanner() }) })
      const stored = await scansOf('never.io')
      expect(stored).toHaveLength(1)
      expect(stored[0]!.ok).toBe(true)
      expect(stored[0]!.raw).toEqual({ fake: true })
      const findings = await db.select().from(schema.findings).where(eq(schema.findings.scanId, stored[0]!.id))
      expect(findings.length).toBeGreaterThan(0)
      const [score] = await db.select().from(schema.scores).where(eq(schema.scores.scanId, stored[0]!.id))
      expect(score?.icpProfileId).toBe(icpProfile.id)
    })

    it('asking again takes the next ones, not a company just tried', async () => {
      const ops = opsWith({ scan: scanner({ unreachable: ['unreached.io'] }) })
      await run(rescanStale, { limit: 3 }, { ops })
      scanned.length = 0
      audited.length = 0
      const again = await run(rescanStale, { limit: 3 }, { ops })
      expect(again.ok).toBe(true)
      if (!again.ok) return
      // never.io and stale-old.io are fresh now; unreached.io was tried a
      // moment ago and waits out the floor.
      expect(scanned).toEqual(['stale-new.io'])
      expect(again.data as R).toMatchObject({ due: 4, scanned: 1, reached: 1, waiting: 2, skipped: 1, remaining: 3 })
    })

    it('judges freshness by ran_at, never by the findings.stale cache', async () => {
      // The cache says the opposite of the truth for both.
      await db.update(schema.findings).set({ stale: true }).where(eq(schema.findings.companyId, ids.get('fresh.io')!))
      await db.update(schema.findings).set({ stale: false }).where(eq(schema.findings.companyId, ids.get('stale-old.io')!))
      await run(rescanStale, { limit: 3 }, { ops: opsWith({ scan: scanner() }) })
      expect(scanned).toContain('stale-old.io')
      expect(scanned).not.toContain('fresh.io')
    })

    it('scans nothing while the nightly rescan holds the org, and says so', async () => {
      await db.insert(schema.auditLog).values({
        orgId, actor: 'system', action: 'scan.cron_started',
        detail: { until: new Date(NOW.getTime() + 5 * MINUTE).toISOString(), schedule: '17 3 * * *' },
        createdAt: new Date(NOW.getTime() - MINUTE),
      })
      const out = await run(rescanStale, {}, { ops: opsWith({ scan: scanner() }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(scanned).toEqual([])
      expect(out.data).toMatchObject({ cronRunning: true, scanned: 0, due: 6 })
      expect(out.summary).toContain('The nightly rescan is running for this organisation now')
      expect(audited).toEqual([{
        action: 'agent.rescan_stale',
        detail: {
          scanned: 0, reached: 0, unreachable: 0, abandoned: 0, failed: 0, stillRunning: 0, skipped: 0, remaining: 6,
          companyIds: [], cronRunning: true,
        },
      }])
      // It read the claim; it took none.
      const claims = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'scan.cron_started'))
      expect(claims).toHaveLength(1)
    })

    it('is not held by a claim that has run out, or by another org’s', async () => {
      await db.insert(schema.auditLog).values([
        { orgId, actor: 'system', action: 'scan.cron_started', detail: { until: new Date(NOW.getTime() - MINUTE).toISOString() }, createdAt: new Date(NOW.getTime() - 10 * MINUTE) },
        { orgId: otherOrgId, actor: 'system', action: 'scan.cron_started', detail: { until: new Date(NOW.getTime() + 5 * MINUTE).toISOString() }, createdAt: new Date(NOW.getTime() - MINUTE) },
      ])
      const out = await run(rescanStale, { limit: 1 }, { ops: opsWith({ scan: scanner() }) })
      expect(out.ok && (out.data as R).cronRunning).toBe(false)
      expect(scanned).toEqual(['never.io'])
    })

    it('answers at its deadline with a slow scan still running, which records itself when it finishes and is not started twice', async () => {
      let finish!: (p: SiteProfile) => void
      const slow = new Map([['never.io', new Promise<SiteProfile>((resolve) => { finish = resolve })]])
      const tool = makeRescanStale({ deadlineMs: 150 })
      const ops = opsWith({ scan: scanner({ slow }) })

      const started = Date.now()
      const out = await run(tool, { limit: 1 }, { ops })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.data as R).toMatchObject({ scanned: 1, reached: 0, stillRunning: 1, unreachable: 0 })
      expect((out.data as R).companies[0]).toMatchObject({ domain: 'never.io', outcome: 'still_running', score: null })
      expect(out.summary).toContain('never.io (Never Scanned) — still running — ask again shortly')
      // It promises a self-recording finish only within the worst case.
      expect(out.summary).toMatch(/records itself if it finishes within \d+ seconds of starting, and is abandoned unrecorded after that/)
      expect(audited[0]!.detail).toMatchObject({ scanned: 1, stillRunning: 1, companyIds: [ids.get('never.io')] })
      expect(await scansOf('never.io')).toHaveLength(0)

      // Asked again while it runs: the slow one is not started a second time.
      scanned.length = 0
      const again = await run(tool, { limit: 1 }, { ops })
      expect(again.ok).toBe(true)
      expect(scanned).toEqual(['unreached.io'])
      expect(again.ok && again.summary).toContain('1 is still being scanned from an earlier request')

      finish(reached('never.io'))
      const deadline = Date.now() + 5_000
      while ((await scansOf('never.io')).length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      const stored = await scansOf('never.io')
      expect(stored).toHaveLength(1)
      expect(stored[0]!.ok).toBe(true)
    })

    it('abandons a scan that outlives its worst case, recording nothing for it — and counts it as abandoned, not unreachable', async () => {
      const never = new Map([['never.io', new Promise<SiteProfile>(() => {})]])
      const tool = makeRescanStale({ deadlineMs: 2_000, scanWorstCaseMs: 50 })
      const out = await run(tool, { limit: 1 }, { ops: opsWith({ scan: scanner({ slow: never }) }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.data as R).toMatchObject({ scanned: 1, reached: 0, unreachable: 0, abandoned: 1, failed: 0, stillRunning: 0 })
      expect(audited[0]!.detail).toMatchObject({ unreachable: 0, abandoned: 1, failed: 0 })
      expect(out.summary).toContain('abandoned: the scan outlived the longest its timeouts allow, and nothing was recorded')
      expect(await scansOf('never.io')).toHaveLength(0)
    })

    /**
     * Abandoning a scan closes nothing: its request is still open to the
     * site. Released when the race was lost, the next call started a second
     * request beside it, and each later call another (review round 16).
     */
    it('holds an abandoned scan’s site until its request ends, so asking again does not start a second beside it', async () => {
      let end!: (p: SiteProfile) => void
      const open = new Map([['never.io', new Promise<SiteProfile>((resolve) => { end = resolve })]])
      const tool = makeRescanStale({ deadlineMs: 2_000, scanWorstCaseMs: 50 })
      const ops = opsWith({ scan: scanner({ slow: open }) })
      const first = await run(tool, { limit: 1 }, { ops })
      expect(first.ok && (first.data as R).companies[0]!.outcome).toBe('abandoned')

      scanned.length = 0
      const again = await run(tool, { limit: 1 }, { ops: opsWith({ scan: scanner() }) })
      expect(again.ok).toBe(true)
      expect(scanned).not.toContain('never.io')
      expect(again.ok && again.summary).toContain('1 is still being scanned from an earlier request')

      // The request ends: the site is free again, and the abandoned scan still recorded nothing.
      end(reached('never.io'))
      await new Promise((r) => setTimeout(r, 20))
      expect(await scansOf('never.io')).toHaveLength(0)
      scanned.length = 0
      await run(tool, { limit: 1 }, { ops: opsWith({ scan: scanner() }) })
      expect(scanned).toEqual(['never.io'])
    })

    it('says the failure of a scan by its class only, recording nothing', async () => {
      const throwing: OpsScan = async (domain) => {
        scanned.push(domain)
        throw new TypeError('cannot read properties of postgres://user:secret@db.internal/agency')
      }
      const out = await run(rescanStale, { limit: 1 }, { ops: opsWith({ scan: throwing }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.summary).toContain('the scan failed before anything was recorded (TypeError)')
      expect(out.data as R).toMatchObject({ unreachable: 0, failed: 1, abandoned: 0 })
      expect(out.summary).not.toContain('secret')
      expect(out.summary).not.toContain('postgres://')
      expect(await scansOf('never.io')).toHaveLength(0)
    })

    it('audits counts and company ids — no domain, no error text', async () => {
      await run(rescanStale, { limit: 3 }, { ops: opsWith({ scan: scanner({ unreachable: ['unreached.io'] }) }) })
      expect(audited).toEqual([{
        action: 'agent.rescan_stale',
        detail: {
          scanned: 3, reached: 2, unreachable: 1, abandoned: 0, failed: 0, stillRunning: 0, skipped: 1, remaining: 4,
          companyIds: [ids.get('never.io'), ids.get('unreached.io'), ids.get('stale-old.io')],
          cronRunning: false,
        },
      }])
      expect(JSON.stringify(audited)).not.toMatch(/\.io|ENOTFOUND/)
    })

    it('says so when nothing is stale or missing, and scans nothing', async () => {
      for (const domain of ['never.io', 'unreached.io', 'stale-old.io', 'stale-new.io', 'recent-fail.io']) {
        await scanAt(domain, new Date(NOW.getTime() - DAY), reached(domain))
      }
      await db.delete(schema.companies).where(eq(schema.companies.domain, 'intranet.corp'))
      const out = await run(rescanStale, {}, { ops: opsWith({ scan: scanner() }) })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(scanned).toEqual([])
      expect(out.summary).toContain('No company has stale or missing evidence')
      expect(audited[0]!.detail).toMatchObject({ scanned: 0, remaining: 0 })
    })

    it('refuses a role that cannot write companies, and an org with no ICP', async () => {
      const refused = await run(rescanStale, {}, { principal: nobody, ops: opsWith({ scan: scanner() }) })
      expect(refused.ok ? 'ok' : refused.code).toBe('not_permitted')
      const noIcp = await run(rescanStale, {}, {
        orgId: otherOrgId, principal: { id: otherUserId, orgId: otherOrgId, role: 'owner' }, ops: opsWith({ scan: scanner() }),
      })
      expect(noIcp.ok ? 'ok' : noIcp.code).toBe('invalid_state')
      expect(scanned).toEqual([])
      expect(audited).toEqual([])
    })
  })
})
