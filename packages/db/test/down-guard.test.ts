/**
 * Reverting 0018 drops `users.revoked_at`, and code from before 0018 has no
 * notion of revocation — so every teammate an owner offboarded could request
 * a sign-in link and get back in. The down file cannot be edited (§10: never
 * edit a shipped migration), so the migrator refuses the revert while any
 * revoked user exists, names how many, and goes ahead only when the caller
 * says in so many words that it means to restore their access.
 *
 * Review round 3, finding [18].
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { RESTORES_REVOKED_ACCESS_FLAG, migrateDown, migrationStatus } from '../src/migrator.js'
import { schema, type AgencyDb } from '../src/index.js'
import { migratedDb, migrations, type TestDb } from './helpers.js'

describe('reverting 0018 while somebody has revoked access', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    await db.insert(schema.users).values([
      { orgId, email: 'owner@agency.test', role: 'owner' },
      { orgId, email: 'gone@agency.test', revokedAt: new Date('2026-09-01T00:00:00Z') },
      { orgId, email: 'also-gone@agency.test', revokedAt: new Date('2026-09-02T00:00:00Z') },
    ])
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** How many migrations stand above 0018, so `down N` reaches it whatever is added later. */
  const toReach0018 = (): number => migrations().filter((m) => m.version >= '0018').length

  const applied = async (): Promise<string[]> =>
    (await migrationStatus(test.driver, migrations())).filter((r) => r.applied).map((r) => r.version)

  it('refuses, naming how many people it would let back in and the flag that overrides it', async () => {
    const before = await applied()
    const err = await migrateDown(test.driver, migrations(), toReach0018()).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('0018')
    expect(err!.message).toContain('2 users have revoked access')
    expect(err!.message).toContain('sign in again')
    expect(err!.message).toContain(RESTORES_REVOKED_ACCESS_FLAG)
    // Refused BEFORE anything was reverted — not halfway down the list.
    expect(await applied()).toEqual(before)
    const [col] = await test.driver.select<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'revoked_at'`,
    )
    expect(col!.n).toBe(1)
  })

  it('refuses any partial revert that reaches 0018, however many steps it takes', async () => {
    await expect(migrateDown(test.driver, migrations(), toReach0018() + 3)).rejects.toThrow(/revoked access/)
  })

  it('does not refuse "down all": that drops the users table too, so nobody is let back in', async () => {
    const undone = await migrateDown(test.driver, migrations(), 'all')
    expect(undone).toContain('0001')
    const [t] = await test.driver.select<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'users'`,
    )
    expect(t!.n).toBe(0)
  })

  it('reverts when the caller says it means to restore their access', async () => {
    const undone = await migrateDown(test.driver, migrations(), toReach0018(), () => {}, { restoresRevokedAccess: true })
    expect(undone).toContain('0018')
    expect(await applied()).not.toContain('0018')
  })

  it('says one user in the singular', async () => {
    await test.driver.select(`UPDATE users SET revoked_at = NULL WHERE email = 'also-gone@agency.test'`)
    await expect(migrateDown(test.driver, migrations(), toReach0018())).rejects.toThrow(/1 user has revoked access/)
  })

  it('reverts without the flag when nobody is revoked', async () => {
    await test.driver.select(`UPDATE users SET revoked_at = NULL`)
    const undone = await migrateDown(test.driver, migrations(), toReach0018())
    expect(undone).toContain('0018')
  })

  it('does not ask when the revert stops short of 0018', async () => {
    const above = migrations().filter((m) => m.version > '0018').length
    if (above === 0) {
      // Nothing above 0018 yet: a revert of zero steps is not a revert. The
      // guard is keyed on 0018 being IN the list, which the first test pins.
      expect(toReach0018()).toBe(1)
      return
    }
    const undone = await migrateDown(test.driver, migrations(), above)
    expect(undone).not.toContain('0018')
  })
})

describe('the CLI', () => {
  const cli = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8')

  it('passes the flag through on down and on reset, and nowhere is it the default', () => {
    expect(cli).toContain('RESTORES_REVOKED_ACCESS_FLAG')
    expect(cli.match(/restoresRevokedAccess/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(cli).not.toMatch(/restoresRevokedAccess:\s*true/)
  })
})
