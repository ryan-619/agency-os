/**
 * The daily digest, against a real engine (§2.3, §2.4).
 *
 * Every count is seeded with rows that SHOULD count and rows that should
 * not — in this org and in another one — because a count that only ever
 * sees the rows it expects cannot tell a working filter from a missing one.
 * The cases the digest exists for:
 *
 *   * an opt-out that was not recorded is counted from ALL THREE audit
 *     actions that mean it, inside the window and not outside it;
 *   * staleness is derived from the latest scan's `ran_at`, not the cached
 *     column, and a free-mail placeholder is never "never scanned";
 *   * rotting is core's rule over the column the board reads, most rotten
 *     first, five at most;
 *   * the facts carry no address and no message body — the seeded rows are
 *     full of both;
 *   * a `cron.digest` row inside twenty hours stops the next run, one
 *     outside it does not, and a second delivery posts nothing — shown in
 *     sequence, because PGlite runs one transaction at a time; the lock
 *     that serialises two at once on real Postgres is pinned by its source;
 *   * a campaign that paused itself is read once: since the previous
 *     digest, inside the 24-hour lookback, capped, per org.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  DIGEST_MAX_PAUSE_NOTICES, DIGEST_OPT_OUT_FAILURES, DIGEST_TOP_ROTTING, DIGEST_WINDOW_HOURS,
  digestAlreadySent, digestCampaignPauses, digestCounts, digestFacts, digestOnce, digestRecord,
  schema, type AgencyDb, type DigestFacts,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR)
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY)
const STALE_DAYS = 14

/** What a real row carries in the places the digest must not read. */
const BODY = 'DECOY-BODY please stop emailing jane.doe@acme.example'

describe('the daily digest', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let otherUserId: string

  const company = async (org: string, domain: string) =>
    (await db.insert(schema.companies).values({ orgId: org, domain }).returning({ id: schema.companies.id }))[0]!.id

  const contact = async (org: string, companyId: string, email: string) =>
    (
      await db
        .insert(schema.contacts)
        .values({ orgId: org, companyId, email, firstName: 'Jane', lastName: 'Doe' })
        .returning({ id: schema.contacts.id })
    )[0]!.id

  const scan = async (org: string, companyId: string, ranAt: Date, ok = true) =>
    db.insert(schema.scans).values({ orgId: org, companyId, ranAt, ok, error: ok ? null : 'timeout' })

  const deal = async (org: string, companyId: string, stage: string, lastChanged: Date, closed = false) =>
    db.insert(schema.deals).values({
      orgId: org, companyId, stage, createdAt: daysAgo(90), updatedAt: lastChanged,
      closedAt: closed ? lastChanged : null,
    })

  const audit = async (org: string, action: string, at: Date) =>
    db.insert(schema.auditLog).values({
      orgId: org, actor: 'system', action, createdAt: at,
      // What the real writers put there, plus a decoy the digest must not read.
      detail: { touchId: null, why: 'unparseable_address', note: BODY },
    })

  const facts = (org = orgId): Promise<DigestFacts> => digestFacts(db, org, { now: NOW, staleDays: STALE_DAYS })

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org, other] = await db.insert(schema.orgs).values([{ name: 'Agency' }, { name: 'Rival' }]).returning()
    orgId = org!.id
    otherOrgId = other!.id
    userId = (await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning())[0]!.id
    otherUserId = (
      await db.insert(schema.users).values({ orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' }).returning()
    )[0]!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('answers zeros for an org with nothing in it, and a spend of 0.00 rather than null', async () => {
    expect(await facts()).toEqual({
      pendingApprovals: 0,
      unhandledReplies: 0,
      rottingDeals: 0,
      staleCompanies: 0,
      neverScanned: 0,
      dueTasks: 0,
      overdueTasks: 0,
      refusals24h: [],
      optOutsNotRecorded24h: 0,
      spend24hUsd: '0.00',
      topRotting: [],
    })
  })

  it('counts pending tool approvals that can still be decided and drafts awaiting approval — the /approvals page’s two lists', async () => {
    const c = await company(orgId, 'acme.example')
    const theirs = await company(otherOrgId, 'theirs.example')
    const approval = (org: string, status: string, expiresAt: Date, decidedBy: string | null = null) => ({
      orgId: org, requestedBy: decidedBy ?? userId, toolName: 'queue_touch', risk: 'high', status, expiresAt,
      decidedBy, decidedAt: decidedBy ? hoursAgo(1) : null, payload: { body: BODY },
    })
    await db.insert(schema.approvals).values([
      approval(orgId, 'pending', new Date(NOW.getTime() + 20 * 60_000)), // counts
      approval(orgId, 'pending', new Date(NOW.getTime() + 5 * 60_000)), // counts
      approval(orgId, 'pending', hoursAgo(1)), // lapsed, not swept yet: nobody can decide it
      approval(orgId, 'approved', new Date(NOW.getTime() + 20 * 60_000), userId),
      { ...approval(otherOrgId, 'pending', new Date(NOW.getTime() + 20 * 60_000)), requestedBy: otherUserId },
    ])
    await db.insert(schema.touches).values([
      { orgId, companyId: c, channel: 'email', direction: 'out', status: 'awaiting_approval', body: BODY }, // counts
      { orgId, companyId: c, channel: 'email', direction: 'out', status: 'queued', body: BODY },
      { orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'out', status: 'awaiting_approval' },
    ])
    expect((await facts()).pendingApprovals).toBe(3)
    expect((await facts(otherOrgId)).pendingApprovals).toBe(2)
  })

  it('counts inbound replies nobody has handled, and not outbound rows or handled ones', async () => {
    const c = await company(orgId, 'acme.example')
    const theirs = await company(otherOrgId, 'theirs.example')
    const person = await contact(orgId, c, 'jane.doe@acme.example')
    await db.insert(schema.touches).values([
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'in', status: 'replied', body: BODY, replyKind: 'interested' },
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'in', status: 'replied', body: BODY },
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'in', status: 'replied', body: BODY, handledAt: hoursAgo(2), handledBy: userId },
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'out', status: 'sent', body: BODY },
      { orgId: otherOrgId, companyId: theirs, channel: 'email', direction: 'in', status: 'replied', body: BODY },
    ])
    expect((await facts()).unhandledReplies).toBe(2)
  })

  it('marks rotting by core’s per-stage rule over updated_at, most rotten first, five at most', async () => {
    // contacted rots at 10 days, replied at 5, meeting and proposal at 14, new at 7.
    await deal(orgId, await company(orgId, 'a-contacted.example'), 'contacted', daysAgo(12)) // 2 past
    await deal(orgId, await company(orgId, 'b-replied.example'), 'replied', daysAgo(30)) // 25 past
    await deal(orgId, await company(orgId, 'c-proposal.example'), 'proposal', daysAgo(20)) // 6 past
    await deal(orgId, await company(orgId, 'd-new.example'), 'new', daysAgo(9)) // 2 past, 9 days
    await deal(orgId, await company(orgId, 'e-contacted.example'), 'contacted', daysAgo(11)) // 1 past
    await deal(orgId, await company(orgId, 'jane-doe-gmail-com.inbound'), 'new', daysAgo(40)) // 33 past — a person's row
    // Not rotten: inside the threshold, exactly under it, or closed.
    await deal(orgId, await company(orgId, 'fresh-meeting.example'), 'meeting', daysAgo(3))
    await deal(orgId, await company(orgId, 'just-under.example'), 'replied', new Date(daysAgo(5).getTime() + 60_000))
    await deal(orgId, await company(orgId, 'won.example'), 'won', daysAgo(100), true)
    await deal(orgId, await company(orgId, 'lost.example'), 'lost', daysAgo(100), true)
    await deal(otherOrgId, await company(otherOrgId, 'theirs.example'), 'replied', daysAgo(60))

    const f = await facts()
    expect(f.rottingDeals).toBe(6)
    expect(f.topRotting).toHaveLength(DIGEST_TOP_ROTTING)
    // Furthest past the threshold first; on a tie, the longer untouched.
    expect(f.topRotting).toEqual([
      'jane-doe-gmail-com.inbound',
      'b-replied.example',
      'c-proposal.example',
      'a-contacted.example',
      'd-new.example',
    ])
    expect((await facts(otherOrgId)).topRotting).toEqual(['theirs.example'])
  })

  it('derives stale from the latest scan’s ran_at, not the cached column, and never counts a person as a company', async () => {
    const fresh = await company(orgId, 'fresh.example')
    const old = await company(orgId, 'old.example')
    const rescanned = await company(orgId, 'rescanned.example')
    const downOld = await company(orgId, 'down-old.example')
    const downNew = await company(orgId, 'down-new.example')
    await company(orgId, 'never.example')
    await company(orgId, 'also-never.example')
    await company(orgId, 'jane-doe-gmail-com.inbound') // never scanned, never will be
    await company(otherOrgId, 'theirs.example') // never scanned, another org

    await scan(orgId, fresh, daysAgo(1))
    await scan(orgId, old, daysAgo(20))
    // A cached `stale = false` on the old scan's finding must not make it fresh.
    const [oldScan] = await db.select().from(schema.scans).where(eq(schema.scans.companyId, old))
    await db.insert(schema.findings).values({
      orgId, scanId: oldScan!.id, companyId: old, signalKey: 'csp', observed: true, gap: true,
      weight: 10, evidence: { header: null }, stale: false,
    })
    await scan(orgId, rescanned, daysAgo(30))
    await scan(orgId, rescanned, daysAgo(2)) // the latest is what counts
    await scan(orgId, downOld, daysAgo(20), false) // unreachable and old: the rescan retries it
    await scan(orgId, downNew, daysAgo(1), false) // unreachable but recent: not due

    const f = await facts()
    expect(f.staleCompanies).toBe(2)
    expect(f.neverScanned).toBe(2)
    expect((await facts(otherOrgId)).neverScanned).toBe(1)
    // The ICP's threshold, not a constant: at 30 days the 20-day scans are fresh.
    expect((await digestFacts(db, orgId, { now: NOW, staleDays: 30 })).staleCompanies).toBe(0)
  })

  it('counts open tasks due in the next day and overdue ones, never finished work', async () => {
    const task = (org: string, dueAt: Date | null, done = false, by = userId) => ({
      orgId: org, title: 'Follow up', detail: BODY, dueAt, doneAt: done ? hoursAgo(1) : null, doneBy: done ? by : null,
    })
    await db.insert(schema.tasks).values([
      task(orgId, new Date(NOW.getTime() + 5 * HOUR)), // due
      task(orgId, new Date(NOW.getTime() + 23 * HOUR)), // due
      task(orgId, new Date(NOW.getTime() + 3 * DAY)),
      task(orgId, hoursAgo(2)), // overdue
      task(orgId, hoursAgo(2), true), // done
      task(orgId, null),
      task(otherOrgId, hoursAgo(2), false, otherUserId),
    ])
    const f = await facts()
    expect(f.dueTasks).toBe(2)
    expect(f.overdueTasks).toBe(1)
  })

  it('counts refusals by code in the last 24 hours, by when they were refused', async () => {
    const c = await company(orgId, 'acme.example')
    const theirs = await company(otherOrgId, 'theirs.example')
    const refused = (org: string, companyId: string, code: string, updatedAt: Date | null, createdAt = daysAgo(30)) => ({
      orgId: org, companyId, channel: 'email', direction: 'out', status: 'refused', refusalCode: code,
      body: BODY, createdAt, updatedAt,
    })
    await db.insert(schema.touches).values([
      refused(orgId, c, 'suppressed', hoursAgo(1)),
      refused(orgId, c, 'no_consent', hoursAgo(3)),
      refused(orgId, c, 'no_consent', hoursAgo(23)),
      refused(orgId, c, 'no_consent', null, hoursAgo(4)), // refused at insert
      refused(orgId, c, 'suppressed', hoursAgo(30)), // drafted long ago, refused yesterday-but-one
      refused(otherOrgId, theirs, 'suppressed', hoursAgo(1)),
    ])
    expect((await facts()).refusals24h).toEqual([
      { code: 'no_consent', n: 3 },
      { code: 'suppressed', n: 1 },
    ])
  })

  it('counts an opt-out that was not recorded from all three actions that mean it, inside the window only', async () => {
    expect([...DIGEST_OPT_OUT_FAILURES].sort()).toEqual([
      'contact.erasure_failed', 'contact.opt_out_not_recorded', 'unsubscribe.not_recorded',
    ])
    await audit(orgId, 'contact.opt_out_not_recorded', hoursAgo(1))
    await audit(orgId, 'unsubscribe.not_recorded', hoursAgo(3))
    await audit(orgId, 'contact.erasure_failed', hoursAgo(5))
    await audit(orgId, 'unsubscribe.not_recorded', hoursAgo(30)) // outside the window
    await audit(orgId, 'unsubscribe.recorded', hoursAgo(1)) // the link working
    await audit(orgId, 'contact.opt_out', hoursAgo(1))
    await audit(otherOrgId, 'contact.opt_out_not_recorded', hoursAgo(1))

    expect((await facts()).optOutsNotRecorded24h).toBe(3)
    expect((await facts(otherOrgId)).optOutsNotRecorded24h).toBe(1)
  })

  it('sums the last day’s model spend in SQL, rounded to cents, never concatenated', async () => {
    const [session] = await db.insert(schema.chatSessions).values({ orgId, userId }).returning()
    const [theirs] = await db.insert(schema.chatSessions).values({ orgId: otherOrgId, userId: otherUserId }).returning()
    const message = (org: string, sessionId: string, costUsd: string | null, at: Date) => ({
      orgId: org, sessionId, role: 'assistant', content: { text: BODY }, costUsd, createdAt: at,
    })
    await db.insert(schema.chatMessages).values([
      message(orgId, session!.id, '0.012345', hoursAgo(2)),
      message(orgId, session!.id, '0.500000', hoursAgo(20)),
      message(orgId, session!.id, null, hoursAgo(1)),
      message(orgId, session!.id, '10.000000', hoursAgo(30)),
      message(otherOrgId, theirs!.id, '99.000000', hoursAgo(1)),
    ])
    // "0.012345" + "0.500000" as strings would be "0.0123450.500000".
    expect((await facts()).spend24hUsd).toBe('0.51')
    expect((await facts(otherOrgId)).spend24hUsd).toBe('99.00')
  })

  it('carries no address and no message body, though every row it read was full of both', async () => {
    const c = await company(orgId, 'acme.example')
    const inbound = await company(orgId, 'jane-doe-gmail-com.inbound')
    const person = await contact(orgId, c, 'jane.doe@acme.example')
    await deal(orgId, c, 'replied', daysAgo(20))
    await deal(orgId, inbound, 'new', daysAgo(20))
    await db.insert(schema.touches).values([
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'in', status: 'replied', body: BODY, recipient: 'jane.doe@acme.example' },
      { orgId, contactId: person, companyId: c, channel: 'email', direction: 'out', status: 'refused', refusalCode: 'suppressed', body: BODY, recipient: 'jane.doe@acme.example', updatedAt: hoursAgo(1) },
    ])
    await audit(orgId, 'unsubscribe.not_recorded', hoursAgo(1))
    await db.insert(schema.tasks).values({ orgId, title: 'Call Jane', detail: BODY, dueAt: hoursAgo(1) })

    const f = await facts()
    const wire = JSON.stringify(f)
    expect(wire).not.toContain('@')
    expect(wire).not.toContain('DECOY')
    expect(wire).not.toContain('Jane')
    expect(wire).not.toContain('Call')
    // It read them all — the assertions above are not passing on an empty object.
    expect(f).toMatchObject({ unhandledReplies: 1, rottingDeals: 2, optOutsNotRecorded24h: 1, overdueTasks: 1 })
    expect(f.refusals24h).toEqual([{ code: 'suppressed', n: 1 }])

    // And the audit row's counts carry no domain at all.
    const counts = digestCounts(f)
    expect(JSON.stringify(counts)).not.toContain('example')
    expect(JSON.stringify(counts)).not.toContain('.inbound')
    expect(counts).toMatchObject({ refusals24h: 1, refusalsByCode: { suppressed: 1 } })
  })

  it('refuses a stale threshold that is not a positive number rather than calling everything stale', async () => {
    await expect(digestFacts(db, orgId, { now: NOW, staleDays: 0 })).rejects.toThrow(/staleDays/)
    await expect(digestFacts(db, orgId, { now: NOW, staleDays: Number.NaN })).rejects.toThrow(/staleDays/)
  })

  // -------------------------------------------------------------------------
  describe('idempotency', () => {
    const windowStart = () => new Date(Date.now() - DIGEST_WINDOW_HOURS * HOUR)
    const counts = () =>
      digestCounts({
        pendingApprovals: 1, unhandledReplies: 2, rottingDeals: 0, staleCompanies: 0, neverScanned: 0,
        dueTasks: 0, overdueTasks: 0, refusals24h: [], optOutsNotRecorded24h: 0, spend24hUsd: '0.00',
        topRotting: ['acme.example'],
      })

    it('is already sent within twenty hours of a cron.digest row, posted or not, and not after', async () => {
      expect(await digestAlreadySent(db, orgId, windowStart())).toBe(false)
      await digestRecord(db, { orgId, posted: false, why: 'no_slack', counts: counts() })
      expect(await digestAlreadySent(db, orgId, windowStart())).toBe(true)

      // A row from twenty-one hours ago is yesterday's run.
      await db.insert(schema.auditLog).values({
        orgId: otherOrgId, actor: 'system', action: 'cron.digest', detail: { posted: true },
        createdAt: new Date(Date.now() - 21 * HOUR),
      })
      expect(await digestAlreadySent(db, otherOrgId, windowStart())).toBe(false)
      // Nineteen hours ago is today's.
      await db.insert(schema.auditLog).values({
        orgId: otherOrgId, actor: 'system', action: 'cron.digest', detail: { posted: true },
        createdAt: new Date(Date.now() - 19 * HOUR),
      })
      expect(await digestAlreadySent(db, otherOrgId, windowStart())).toBe(true)
    })

    it('is per org, and only a cron.digest row counts', async () => {
      await db.insert(schema.auditLog).values([
        { orgId, actor: 'system', action: 'notification.sent', detail: { event: 'digest' } },
        { orgId, actor: 'system', action: 'scan.cron_run', detail: {} },
      ])
      expect(await digestAlreadySent(db, orgId, windowStart())).toBe(false)
      await digestRecord(db, { orgId: otherOrgId, posted: true, counts: counts() })
      expect(await digestAlreadySent(db, orgId, windowStart())).toBe(false)
      expect(await digestAlreadySent(db, otherOrgId, windowStart())).toBe(true)
    })

    it('records counts, the outcome and the worker — never a domain', async () => {
      await digestRecord(db, {
        orgId, posted: false, why: 'slack_failed', counts: counts(), worker: 'silent', workerAlert: 'failed',
      })
      await digestRecord(db, { orgId: otherOrgId, posted: true, counts: counts(), worker: 'live', workerAlert: 'not_needed' })
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'cron.digest'))
      const mine = rows.find((r) => r.orgId === orgId)!
      expect(mine).toMatchObject({ actor: 'system', subjectType: null, subjectId: null })
      expect(mine.detail).toEqual({
        posted: false, why: 'slack_failed', worker: 'silent', workerAlert: 'failed',
        counts: {
          pendingApprovals: 1, unhandledReplies: 2, rottingDeals: 0, staleCompanies: 0, neverScanned: 0,
          dueTasks: 0, overdueTasks: 0, refusals24h: 0, refusalsByCode: {}, optOutsNotRecorded24h: 0, spend24hUsd: '0.00',
        },
      })
      // A posted run says nothing about why it did not post.
      expect(rows.find((r) => r.orgId === otherOrgId)!.detail).not.toHaveProperty('why')
      expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain('acme.example')
    })

    /**
     * What this can show is SEQUENTIAL idempotency: PGlite runs one
     * transaction at a time, so the second `digestOnce` below only starts
     * once the first has committed, and it would pass with no lock at all.
     * Two deliveries that truly overlap are serialised by the lock, which
     * only real Postgres can show — so it is pinned by its source, next.
     */
    it('runs once for a second delivery: it finds the first one’s committed row', async () => {
      let runs = 0
      const run = (tx: AgencyDb) => async () => {
        runs += 1
        await digestRecord(tx, { orgId, posted: true, counts: counts() })
        return 'posted'
      }
      const [a, b] = await Promise.all([
        digestOnce(db, orgId, windowStart(), (tx) => run(tx)()),
        digestOnce(db, orgId, windowStart(), (tx) => run(tx)()),
      ])
      expect(runs).toBe(1)
      expect([a.ran, b.ran].sort()).toEqual([false, true])
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'cron.digest'))
      expect(rows).toHaveLength(1)
      // Another org is not held up by this one's row.
      expect((await digestOnce(db, otherOrgId, windowStart(), async () => 'ran')).ran).toBe(true)
    })

    it('takes the transaction-scoped two-key lock before it looks for the row', () => {
      const here = dirname(fileURLToPath(import.meta.url))
      const source = readFileSync(join(here, '..', 'src', 'digest.ts'), 'utf8')
      const body = source.slice(source.indexOf('export async function digestOnce'))
      const end = body.indexOf('\n}\n')
      const fn = body.slice(0, end)
      const lock = fn.indexOf("pg_advisory_xact_lock(hashtext('cron.digest'), hashtext(")
      expect(lock, 'digestOnce no longer takes its advisory lock').toBeGreaterThan(-1)
      expect(fn.indexOf('db.transaction(')).toBeLessThan(lock)
      expect(lock).toBeLessThan(fn.indexOf('digestAlreadySent('))
    })

    it('writes nothing when the run throws, so the next delivery runs afresh', async () => {
      await expect(
        digestOnce(db, orgId, windowStart(), async (tx) => {
          await digestRecord(tx, { orgId, posted: true, counts: counts() })
          throw new Error('the database went away mid-run')
        }),
      ).rejects.toThrow('went away')
      expect(await digestAlreadySent(db, orgId, windowStart())).toBe(false)
      expect((await digestOnce(db, orgId, windowStart(), async () => 'ran')).ran).toBe(true)
    })
  })

  describe('campaigns that paused themselves', () => {
    const paused = async (org: string, at: Date, detail: Record<string, unknown> = { bouncePct: 12, threshold: 5, sentTo: 25, bounced: 3 }) => {
      const campaignId = randomUUID()
      await db.insert(schema.auditLog).values({
        orgId: org, actor: 'system', action: 'campaign.auto_paused', subjectType: 'campaign', subjectId: campaignId,
        createdAt: at, detail,
      })
      return campaignId
    }
    const digestAt = (org: string, at: Date) =>
      db.insert(schema.auditLog).values({ orgId: org, actor: 'system', action: 'cron.digest', createdAt: at, detail: { posted: true } })

    it('reads every pause in the last 24 hours, oldest first, as an id and two numbers — and not another org’s', async () => {
      const first = await paused(orgId, hoursAgo(20))
      const second = await paused(orgId, hoursAgo(2), { bouncePct: 7.5, threshold: 5, sentTo: 40, bounced: 3 })
      await paused(orgId, hoursAgo(30)) // yesterday's window
      await paused(otherOrgId, hoursAgo(1))
      const got = await digestCampaignPauses(db, orgId, { now: NOW })
      expect(got).toEqual({
        found: 2,
        pauses: [
          { campaignId: first, bouncePct: 12, threshold: 5 },
          { campaignId: second, bouncePct: 7.5, threshold: 5 },
        ],
      })
    })

    /**
     * The once-per-day guard is twenty hours, the lookback twenty-four. A
     * manual run twenty-one hours after the scheduled one would re-read the
     * three hours they share — so the window starts at the previous digest.
     */
    it('reads only what the previous digest did not, so no pause is announced twice', async () => {
      await paused(orgId, hoursAgo(23))
      await digestAt(orgId, hoursAgo(21))
      const after = await paused(orgId, hoursAgo(1))
      expect(await digestCampaignPauses(db, orgId, { now: NOW })).toEqual({
        found: 1,
        pauses: [{ campaignId: after, bouncePct: 12, threshold: 5 }],
      })
      // Another org's digest moves nothing here.
      await digestAt(otherOrgId, hoursAgo(0.5))
      expect((await digestCampaignPauses(db, orgId, { now: NOW })).found).toBe(1)
    })

    it('caps the notices and still counts every pause', async () => {
      const ids: string[] = []
      for (let i = DIGEST_MAX_PAUSE_NOTICES + 2; i > 0; i -= 1) ids.push(await paused(orgId, hoursAgo(i)))
      const got = await digestCampaignPauses(db, orgId, { now: NOW })
      expect(got.found).toBe(DIGEST_MAX_PAUSE_NOTICES + 2)
      expect(got.pauses.map((p) => p.campaignId)).toEqual(ids.slice(0, DIGEST_MAX_PAUSE_NOTICES))
    })

    it('skips a row that does not say which campaign, or on what numbers', async () => {
      await db.insert(schema.auditLog).values({
        orgId, actor: 'system', action: 'campaign.auto_paused', createdAt: hoursAgo(1), detail: { bouncePct: 9, threshold: 5 },
      })
      await paused(orgId, hoursAgo(1), { bouncePct: 'lots', threshold: 5 })
      await paused(orgId, hoursAgo(1), { threshold: 5 })
      expect(await digestCampaignPauses(db, orgId, { now: NOW })).toEqual({ found: 0, pauses: [] })
    })

    /** The route reads the pauses and posts inside digestOnce; a second delivery reads nothing new. */
    it('is announced once across two deliveries, through the once-per-day guard', async () => {
      await paused(orgId, hoursAgo(1))
      const announced: string[] = []
      const deliver = () =>
        digestOnce(db, orgId, new Date(NOW.getTime() - DIGEST_WINDOW_HOURS * HOUR), async (tx) => {
          const { pauses, found } = await digestCampaignPauses(tx, orgId, { now: NOW })
          announced.push(...pauses.map((p) => p.campaignId))
          await digestRecord(tx, { orgId, posted: true, counts: digestCounts(await digestFacts(tx, orgId, { now: NOW })), campaignPauses: { found, posted: pauses.length } })
        })
      expect((await deliver()).ran).toBe(true)
      expect((await deliver()).ran).toBe(false)
      expect(announced).toHaveLength(1)
      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'cron.digest'))
      expect((row!.detail as Record<string, unknown>)['campaignPauses']).toEqual({ found: 1, posted: 1 })
    })
  })
})
