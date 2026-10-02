/**
 * Two enrolments cannot both write an opener for one person (review round 3,
 * finding 10).
 *
 * `insertDraft` was one autocommit `INSERT … WHERE NOT EXISTS` with no lock
 * and no unique index. Under READ COMMITTED neither of two overlapping
 * statements sees the other's uncommitted row, so two owners pressing Enrol
 * on one auto-send campaign — or on two auto-send campaigns on one channel,
 * the case `enrolPriorScope` exists for — could each queue an opener for the
 * same person, and the tick would send both unread: queued rows never reach
 * /approvals, so "visible and deniable" was false for exactly that case.
 *
 * Now each insert runs in a short transaction that first takes
 * `pg_advisory_xact_lock` on (org, contact, channel), so the second waits for
 * the first to commit and its NOT EXISTS reads a snapshot taken after it.
 * PGlite is ONE session and cannot interleave two transactions, so the race
 * itself cannot be driven here (users.test.ts and rescan.test.ts say the
 * same of theirs). What is pinned is the fix's shape — every draft INSERT is
 * preceded by that lock inside its own transaction, read off a traced engine
 * and off the source — and the sequential path, which must still write one
 * draft per person and must not over-block a supervised campaign.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { enrolCampaign, schema, type AgencyDb, type EnrolOutcome } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const ICP = JSON.parse(readFileSync(fileURLToPath(new URL('../seed/icp-security-gap-saas.json', import.meta.url)), 'utf8')) as {
  signals: Record<string, { weight: number; why: string }>
}

/** Midday in London on a Tuesday: outside every default quiet window. */
const NOW = new Date('2026-09-15T12:00:00.000Z')
const FRESH_AT = new Date('2026-09-12T08:00:00.000Z')

describe('an enrolment draft is inserted under a per-person lock', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (
      await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id
    const icpProfileId = (
      await db.insert(schema.icpProfiles).values({ orgId, name: 'ICP', definition: ICP, active: true }).returning({ id: schema.icpProfiles.id })
    )[0]!.id
    companyId = (
      await db.insert(schema.companies).values({ orgId, domain: 'rentman.io', name: 'Rentman', timeZone: 'Europe/London' }).returning({ id: schema.companies.id })
    )[0]!.id

    // One fresh, qualifying scan with two gaps, the shape `recordScan` writes.
    const scanId = (
      await db.insert(schema.scans).values({ orgId, companyId, ranAt: FRESH_AT, ok: true }).returning({ id: schema.scans.id })
    )[0]!.id
    const gaps = ['csp', 'security_txt']
    await db.insert(schema.findings).values(
      Object.entries(ICP.signals).map(([key, sig]) => {
        const gap = gaps.includes(key)
        return {
          orgId, scanId, companyId, signalKey: key, observed: true, gap,
          weight: gap ? sig.weight : 0,
          detail: gap ? `${key} missing on https://www.rentman.io/` : null,
          evidence: gap ? { url: 'https://www.rentman.io/', seen: 'absent' } : {},
          stale: false,
        }
      }),
    )
    await db.insert(schema.scores).values({ orgId, companyId, scanId, icpProfileId, score: 71, tier: 'A — call first', qualified: true })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const campaign = async (name: string, autoSend: boolean, channel = 'email') =>
    (await db
      .insert(schema.campaigns)
      .values({ orgId, name, channel, autoSend, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id }))[0]!.id
  const contact = async (email: string) =>
    (await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email, timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id }))[0]!.id
  const ok = (r: EnrolOutcome) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`)
    return r
  }
  const outbound = () => db.select().from(schema.touches).where(eq(schema.touches.direction, 'out'))

  interface Traced {
    readonly sql: string
    readonly params: unknown[]
    /** Which transaction it ran in — 0 outside any. */
    readonly tx: number
  }

  /** A db whose every statement is recorded with the transaction it ran in. */
  const traced = (): { db: AgencyDb; log: Traced[] } => {
    const log: Traced[] = []
    let current = 0
    let opened = 0
    const pg = test.pg
    const original = pg.transaction.bind(pg)
    pg.transaction = (async (fn: Parameters<typeof original>[0]) =>
      original(async (tx) => {
        const outer = current
        current = ++opened
        try {
          return await fn(tx)
        } finally {
          current = outer
        }
      })) as typeof pg.transaction
    const tracedDb = drizzle(pg, {
      schema,
      logger: { logQuery: (q: string, params: unknown[]) => log.push({ sql: q, params, tx: current }) },
    }) as unknown as AgencyDb
    return { db: tracedDb, log }
  }

  it('every draft INSERT runs in its own transaction, after the lock on (org, contact, channel)', async () => {
    const auto = await campaign('Auto', true)
    const a = await contact('priya@rentman.io')
    const b = await contact('sam@rentman.io')
    const t = traced()
    const r = ok(await enrolCampaign(t.db, { orgId, campaignId: auto, actor: userId, now: NOW }))
    expect(r.queued.map((q) => q.contactId).sort()).toEqual([a, b].sort())

    const inserts = t.log.filter((s) => /^\s*INSERT INTO touches/i.test(s.sql))
    expect(inserts).toHaveLength(2)
    for (const insert of inserts) {
      expect(insert.tx, 'the INSERT is inside a transaction').toBeGreaterThan(0)
      const sameTx = t.log.filter((s) => s.tx === insert.tx)
      const lock = sameTx.findIndex((s) => s.sql.includes('pg_advisory_xact_lock'))
      expect(lock, 'the lock was taken in the same transaction').toBeGreaterThanOrEqual(0)
      expect(lock, 'before the INSERT').toBeLessThan(sameTx.indexOf(insert))
      // Keyed by the person and the channel, in this org.
      const who = String(insert.params.find((p) => p === a || p === b))
      expect(sameTx[lock]!.params).toContain(`${orgId}:${who}:email`)
    }
    // One transaction per draft: short, and never the whole enrolment.
    expect(new Set(inserts.map((s) => s.tx)).size).toBe(2)
  })

  it('the source takes the lock inside the transaction, before the INSERT, in insertDraft', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/enrolment.ts', import.meta.url)), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const body = code.slice(code.indexOf('async function insertDraft('))
    const tx = body.indexOf('db.transaction(')
    const lock = body.indexOf("pg_advisory_xact_lock(hashtext('enrol.draft'), hashtext(${`${rule.orgId}:${d.contactId}:${rule.channel}`}))")
    const insert = body.indexOf('INSERT INTO touches')
    expect(tx).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(tx)
    expect(insert).toBeGreaterThan(lock)
    // The INSERT runs on the transaction's handle, never the outer pool.
    expect(body.slice(lock, insert)).toMatch(/return t\.execute\(sql`/)
  })

  describe('the sequential path', () => {
    it('a second enrolment into the same auto-send campaign writes nothing more', async () => {
      const auto = await campaign('Auto', true)
      const a = await contact('priya@rentman.io')
      expect(ok(await enrolCampaign(db, { orgId, campaignId: auto, actor: userId, now: NOW })).queued.map((q) => q.contactId)).toEqual([a])
      const again = ok(await enrolCampaign(db, { orgId, campaignId: auto, actor: userId, now: NOW }))
      expect(again.queued).toEqual([])
      expect(again.skipped).toEqual([{ companyId, contactId: a, why: 'already_enrolled' }])
      expect(await outbound()).toHaveLength(1)
    })

    it('a second auto-send campaign on the same channel does not queue the same opener again', async () => {
      const first = await campaign('Auto A', true)
      const second = await campaign('Auto B', true)
      const a = await contact('priya@rentman.io')
      ok(await enrolCampaign(db, { orgId, campaignId: first, actor: userId, now: NOW }))
      const r = ok(await enrolCampaign(db, { orgId, campaignId: second, actor: userId, now: NOW }))
      expect(r.queued).toEqual([])
      expect(r.skipped).toEqual([{ companyId, contactId: a, why: 'already_enrolled' }])
      expect((await outbound()).map((t) => t.campaignId)).toEqual([first])
    })

    it('the lock does not widen the rule: two supervised campaigns each write their own draft', async () => {
      const one = await campaign('Supervised A', false)
      const two = await campaign('Supervised B', false)
      await contact('priya@rentman.io')
      expect(ok(await enrolCampaign(db, { orgId, campaignId: one, actor: userId, now: NOW })).queued).toHaveLength(1)
      expect(ok(await enrolCampaign(db, { orgId, campaignId: two, actor: userId, now: NOW })).queued).toHaveLength(1)
      expect((await outbound()).map((t) => t.campaignId).sort()).toEqual([one, two].sort())
    })
  })
})
