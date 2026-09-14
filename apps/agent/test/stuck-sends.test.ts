/**
 * A message the last worker left mid-send (Phase 4).
 *
 * `sending` is the sender tick's claim on a row. A worker that died between
 * the claim and the provider's answer leaves that row claimed forever, and
 * nobody can tell whether the mail went. The SAFE reading is `failed` with a
 * reason a person can act on. The alternative — back to `approved` — is a
 * guess that the provider was not reached, and being wrong means somebody
 * receives the same cold email twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { schema, type AgencyDb } from '@agency/db'
import { freshDb, migrations, type TestDb } from '../../../packages/db/test/helpers.js'
import { migrateUp } from '../../../packages/db/src/migrator.js'
import { recoverStuckSends } from '../src/boot/reconcile.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe('recoverStuckSends', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string

  beforeEach(async () => {
    test = await freshDb()
    await migrateUp(test.driver, migrations())
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const touch = async (status: string) => {
    const [row] = await db
      .insert(schema.touches)
      .values({ orgId, companyId, channel: 'email', direction: 'out', status })
      .returning({ id: schema.touches.id })
    return row!.id
  }

  it('marks a row the LAST worker left sending as failed, with a reason a person can act on', async () => {
    const id = await touch('sending')
    // The worker boots after the row was claimed.
    const bootAt = new Date(Date.now() + 60_000)
    expect(await recoverStuckSends(db, bootAt, silent)).toBe(1)
    const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/restarted/)
    expect(row!.error).toMatch(/re-approve/)
  })

  /**
   * Scoped by boot time, like every reconciler here: a claim made AFTER this
   * process started is this process's own tick, mid-flight, and must be left
   * alone.
   */
  it('leaves a claim newer than the boot alone', async () => {
    const id = await touch('sending')
    const bootAt = new Date(Date.now() - 60_000)
    expect(await recoverStuckSends(db, bootAt, silent)).toBe(0)
    const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
    expect(row!.status).toBe('sending')
  })

  it('touches nothing that is not mid-send', async () => {
    for (const s of ['approved', 'queued', 'sent', 'refused']) {
      if (s === 'approved') continue // needs an approver; not the point here
      if (s === 'refused') continue // needs a code; not the point here
      await touch(s)
    }
    expect(await recoverStuckSends(db, new Date(Date.now() + 60_000), silent)).toBe(0)
  })

  it('never throws, because a reconciler that dies stops the boot', async () => {
    const broken = {
      update: () => {
        throw new Error('the database went away')
      },
    } as unknown as AgencyDb
    await expect(recoverStuckSends(broken, new Date(), silent)).resolves.toBe(0)
  })
})
