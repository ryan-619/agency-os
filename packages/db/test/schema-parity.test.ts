import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PgTable } from 'drizzle-orm/pg-core'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'
import * as schema from '../src/schema.js'

/**
 * The migrations own the database; src/schema.ts owns the types. Two sources
 * of truth drift silently, and the symptom is a production query selecting a
 * column that does not exist. This test migrates a real Postgres engine from
 * zero and compares it against every table declared in the schema.
 */

/** Every exported drizzle table, by its real SQL name. */
function declaredTables(): Map<string, PgTable> {
  const out = new Map<string, PgTable>()
  for (const value of Object.values(schema)) {
    // Drizzle tables are objects carrying internal symbols; getTableConfig
    // throws on anything else, which is how we filter relations and types out.
    if (!value || typeof value !== 'object') continue
    try {
      const cfg = getTableConfig(value as PgTable)
      out.set(cfg.name, value as PgTable)
    } catch {
      /* not a table (a relations object or a type) */
    }
  }
  return out
}

describe('drizzle schema matches the migrated database', () => {
  let db: TestDb
  let dbTables: string[]

  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
    const rows = await db.driver.select<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'
       ORDER BY tablename`,
    )
    dbTables = rows.map((r) => r.tablename)
  })
  afterAll(async () => { await db.close() })

  it('declares a drizzle table for every table the migrations create', () => {
    const declared = [...declaredTables().keys()].sort()
    const missing = dbTables.filter((t) => !declared.includes(t))
    expect(missing, `tables in the database with no drizzle declaration: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('declares no table the migrations do not create', () => {
    const declared = [...declaredTables().keys()].sort()
    const extra = declared.filter((t) => !dbTables.includes(t))
    expect(extra, `drizzle tables with no migration: ${extra.join(', ')}`).toEqual([])
  })

  it('every declared column exists in the database with a matching name', async () => {
    for (const [tableName, table] of declaredTables()) {
      const cfg = getTableConfig(table)
      const actual = (
        await db.driver.select<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1`,
          [tableName],
        )
      ).map((r) => r.column_name).sort()

      const declared = cfg.columns.map((c) => c.name).sort()
      const missing = declared.filter((c) => !actual.includes(c))
      const extra = actual.filter((c) => !declared.includes(c))

      expect(missing, `${tableName}: declared in drizzle but absent from the database: ${missing.join(', ')}`)
        .toEqual([])
      expect(extra, `${tableName}: present in the database but undeclared in drizzle: ${extra.join(', ')}`)
        .toEqual([])
    }
  })

  it('agrees with the database about which columns are NOT NULL', async () => {
    for (const [tableName, table] of declaredTables()) {
      const cfg = getTableConfig(table)
      const rows = await db.driver.select<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1`,
        [tableName],
      )
      const dbNotNull = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']))
      for (const col of cfg.columns) {
        expect(
          col.notNull,
          `${tableName}.${col.name}: drizzle says notNull=${col.notNull}, database says notNull=${dbNotNull.get(col.name)}`,
        ).toBe(dbNotNull.get(col.name))
      }
    }
  })

  it('declares the auth tables with the property names @auth/drizzle-adapter requires', () => {
    // Verified against node_modules/@auth/drizzle-adapter/lib/pg.d.ts:
    // usersTable, accountsTable, sessionsTable, verificationTokensTable.
    expect(Object.keys(schema.users)).toEqual(
      expect.arrayContaining(['id', 'name', 'email', 'emailVerified', 'image']),
    )
    expect(Object.keys(schema.accounts)).toEqual(
      expect.arrayContaining([
        'userId', 'type', 'provider', 'providerAccountId', 'refresh_token',
        'access_token', 'expires_at', 'token_type', 'scope', 'id_token', 'session_state',
      ]),
    )
    expect(Object.keys(schema.sessions)).toEqual(
      expect.arrayContaining(['sessionToken', 'userId', 'expires']),
    )
    expect(Object.keys(schema.verificationTokens)).toEqual(
      expect.arrayContaining(['identifier', 'token', 'expires']),
    )
  })
})
