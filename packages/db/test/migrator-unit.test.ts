import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb, type TestDb } from './helpers.js'
import {
  readMigrations, migrateUp, migrateDown, managesItsOwnTransaction, sha256,
} from '../src/migrator.js'
import { pgDriver } from '../src/driver.js'
import { safeTarget } from '../src/safe-target.js'

/** Write a throwaway migrations directory and return its path. */
function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'agency-mig-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body)
  return d
}

describe('readMigrations guard clauses', () => {
  it('rejects an up file with no matching down — every migration must be reversible (§10)', () => {
    const d = dir({ '0001_solo.up.sql': 'CREATE TABLE a (id int);' })
    expect(() => readMigrations(d)).toThrow(/has no \.down\.sql/)
    rmSync(d, { recursive: true })
  })

  it('rejects a down file with no matching up', () => {
    const d = dir({ '0001_solo.down.sql': 'DROP TABLE a;' })
    expect(() => readMigrations(d)).toThrow(/has no \.up\.sql/)
    rmSync(d, { recursive: true })
  })

  it('rejects a .sql file that does not follow the naming convention', () => {
    const d = dir({ 'oops.sql': 'CREATE TABLE a (id int);' })
    expect(() => readMigrations(d)).toThrow(/does not match NNNN_name/)
    rmSync(d, { recursive: true })
  })

  it('rejects two different migrations sharing one version number', () => {
    const d = dir({
      '0001_alpha.up.sql': 'CREATE TABLE a (id int);',
      '0001_alpha.down.sql': 'DROP TABLE a;',
      '0001_beta.up.sql': 'CREATE TABLE b (id int);',
      '0001_beta.down.sql': 'DROP TABLE b;',
    })
    expect(() => readMigrations(d)).toThrow(/two different migrations/)
    rmSync(d, { recursive: true })
  })

  it('rejects a migration that manages its own transaction', () => {
    const d = dir({
      '0001_x.up.sql': 'BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;',
      '0001_x.down.sql': 'DROP TABLE a;',
    })
    expect(() => readMigrations(d)).toThrow(/manages its own transaction/)
    rmSync(d, { recursive: true })
  })

  it('throws on a missing directory rather than silently finding nothing', () => {
    expect(() => readMigrations('/nonexistent/migrations')).toThrow(/not found/)
  })

  it('orders by version and returns both halves', () => {
    const d = dir({
      '0002_b.up.sql': 'CREATE TABLE b (id int);', '0002_b.down.sql': 'DROP TABLE b;',
      '0001_a.up.sql': 'CREATE TABLE a (id int);', '0001_a.down.sql': 'DROP TABLE a;',
    })
    const m = readMigrations(d)
    expect(m.map((x) => x.version)).toEqual(['0001', '0002'])
    expect(m[0]!.name).toBe('a')
    expect(m[0]!.downSql).toContain('DROP TABLE a')
    rmSync(d, { recursive: true })
  })
})

describe('managesItsOwnTransaction', () => {
  // Migration 0001 defines set_updated_at(), whose plpgsql body opens with
  // BEGIN. That is a block, not a transaction, and must not trip the guard.
  it('ignores the BEGIN that opens a plpgsql function body', () => {
    expect(managesItsOwnTransaction(
      'CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;',
    )).toBe(false)
    expect(managesItsOwnTransaction(
      'CREATE FUNCTION f() RETURNS trigger AS $body$\nBEGIN\n RETURN NEW;\nEND;\n$body$ LANGUAGE plpgsql;',
    )).toBe(false)
  })

  it('ignores the word inside a comment', () => {
    expect(managesItsOwnTransaction('-- BEGIN is only mentioned\nCREATE TABLE t (id int);')).toBe(false)
  })

  it('catches real transaction control', () => {
    expect(managesItsOwnTransaction('BEGIN;\nCREATE TABLE t (id int);')).toBe(true)
    expect(managesItsOwnTransaction('CREATE TABLE t (id int);\nCOMMIT;')).toBe(true)
    expect(managesItsOwnTransaction('START TRANSACTION;\nCREATE TABLE t (id int);')).toBe(true)
    expect(managesItsOwnTransaction('CREATE TABLE t (id int);\nROLLBACK;')).toBe(true)
  })

  it('passes ordinary DDL', () => {
    expect(managesItsOwnTransaction('CREATE TABLE t (id int);\nCREATE INDEX i ON t (id);')).toBe(false)
  })

  // Anchoring to the start of a LINE missed these.
  it('catches transaction control that shares a line with other SQL', () => {
    expect(managesItsOwnTransaction('CREATE TABLE t (x int); COMMIT;')).toBe(true)
    expect(managesItsOwnTransaction('BEGIN; CREATE TABLE t (x int);')).toBe(true)
  })

  // Stripping only line comments made these throw.
  it('ignores the words inside a block comment or a string literal', () => {
    expect(managesItsOwnTransaction('/*\nCOMMIT this carefully\n*/\nCREATE TABLE t (x int);')).toBe(false)
    expect(managesItsOwnTransaction("INSERT INTO t (note) VALUES ('COMMIT');")).toBe(false)
    expect(managesItsOwnTransaction("INSERT INTO t (note) VALUES ('it''s a COMMIT');")).toBe(false)
  })

  it('ignores plpgsql EXCEPTION blocks and DO blocks', () => {
    expect(managesItsOwnTransaction(
      'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n NULL;\nEXCEPTION WHEN others THEN\n NULL;\nEND;\n$$ LANGUAGE plpgsql;',
    )).toBe(false)
    expect(managesItsOwnTransaction('DO $$\nBEGIN\n RAISE NOTICE 1;\nEND\n$$;')).toBe(false)
  })
})

describe('drift detection covers BOTH halves of a migration', () => {
  const files = {
    '0001_a.up.sql': 'CREATE TABLE a (id int);',
    '0001_a.down.sql': 'DROP TABLE a;',
  }

  it('the checksum changes when the DOWN file changes', () => {
    const d1 = dir(files)
    const d2 = dir({ ...files, '0001_a.down.sql': 'DROP TABLE IF EXISTS a CASCADE;' })
    const [a] = readMigrations(d1)
    const [b] = readMigrations(d2)
    expect(a!.upSql).toBe(b!.upSql)
    // A down file edited after shipping is as dangerous as an edited up file:
    // migrateDown removes the ledger row on the strength of whatever it does.
    expect(a!.checksum).not.toBe(b!.checksum)
    rmSync(d1, { recursive: true }); rmSync(d2, { recursive: true })
  })

  it('an edited down file is refused against an already-migrated database', async () => {
    const db = await freshDb()
    try {
      const d = dir(files)
      await migrateUp(db.driver, readMigrations(d))

      writeFileSync(join(d, '0001_a.down.sql'), 'DROP TABLE IF EXISTS a CASCADE;')
      const edited = readMigrations(d)

      await expect(migrateUp(db.driver, edited)).rejects.toThrow(/edited since it was applied/)
      await expect(migrateDown(db.driver, edited, 1)).rejects.toThrow(/edited since it was applied/)
      rmSync(d, { recursive: true })
    } finally {
      await db.close()
    }
  })
})

describe('the migration transaction actually wraps the ledger write', () => {
  /**
   * The pre-existing rollback test puts the failure inside the up SQL, which
   * Postgres already makes atomic on its own — it passes even with every
   * BEGIN/COMMIT deleted from the migrator. This is the case only the
   * migrator's own transaction protects: the up SQL SUCCEEDS and the
   * `INSERT INTO schema_migrations` then fails. Without the wrapper the
   * table would survive with no ledger row, and the next `up` would try to
   * create it again.
   */
  it('rolls back a successful migration whose ledger write fails', async () => {
    const db = await freshDb()
    try {
      const sabotage = [
        {
          version: '0001',
          name: 'drops_the_ledger',
          // Valid DDL, then removes the table the ledger insert needs.
          upSql: 'CREATE TABLE survivor (id int);\nDROP TABLE schema_migrations;',
          downSql: 'DROP TABLE IF EXISTS survivor;',
          checksum: sha256('sabotage'),
        },
      ]
      await expect(migrateUp(db.driver, sabotage)).rejects.toThrow(/failed and was rolled back/)

      const tables = await db.driver.select<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`,
      )
      const names = tables.map((t) => t.tablename)
      // Both halves must have been undone: the table it created is gone...
      expect(names).not.toContain('survivor')
      // ...and the ledger it dropped is back.
      expect(names).toContain('schema_migrations')
    } finally {
      await db.close()
    }
  })
})

describe('migrateDown argument validation', () => {
  it('refuses a negative step count instead of reverting all but the newest', async () => {
    const db = await freshDb()
    try {
      const d = dir({ '0001_a.up.sql': 'CREATE TABLE a (id int);', '0001_a.down.sql': 'DROP TABLE a;' })
      const m = readMigrations(d)
      await migrateUp(db.driver, m)
      // Array.slice(0, -1) would mean "all but the last", the exact inverse.
      await expect(migrateDown(db.driver, m, -1)).rejects.toThrow(/positive integer/)
      await expect(migrateDown(db.driver, m, 0)).rejects.toThrow(/positive integer/)
      await expect(migrateDown(db.driver, m, 1.5)).rejects.toThrow(/positive integer/)
      rmSync(d, { recursive: true })
    } finally {
      await db.close()
    }
  })
})

describe('pgDriver refuses a connection Pool', () => {
  it('throws rather than silently running BEGIN and COMMIT on different backends', () => {
    // A pg.Pool satisfies the same structural type as a Client; `totalCount`
    // is what distinguishes them at runtime.
    const poolish = { query: async () => ({ rows: [] }), totalCount: 0 }
    expect(() => pgDriver(poolish as never)).toThrow(/requires a pg\.Client, not a pg\.Pool/)
  })

  it('accepts a Client-shaped object', () => {
    const clientish = { query: async () => ({ rows: [] }) }
    expect(() => pgDriver(clientish as never)).not.toThrow()
  })
})

describe('safeTarget strips credentials (§2.3)', () => {
  it('keeps host, port and database but never the password', () => {
    const out = safeTarget('postgres://agency:sup3rs3cret@db.internal:5433/agency')
    expect(out).toBe('db.internal:5433/agency')
    expect(out).not.toContain('sup3rs3cret')
    expect(out).not.toContain('agency:')
  })

  it('defaults the port when the URL omits it', () => {
    expect(safeTarget('postgres://u:p@localhost/agency')).toBe('localhost:5432/agency')
  })

  it('does not echo an unparseable value back into the log', () => {
    const out = safeTarget('this is not a url but might contain hunter2')
    expect(out).toBe('(unparseable DATABASE_URL)')
    expect(out).not.toContain('hunter2')
  })

  it('handles a password containing URL-significant characters', () => {
    const out = safeTarget('postgres://u:p%40ss%3Aword@host:5432/db')
    expect(out).toBe('host:5432/db')
    expect(out).not.toContain('ss')
  })
})
