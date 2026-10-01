/**
 * The Postgres error readers, against real errors from a real engine.
 *
 * A caller that catches a unique violation to say "already on the list"
 * must not also swallow a CHECK violation and say the same thing; and a
 * driver that wraps the error in a `cause` must not hide it. Both are the
 * kind of bug that reads as the product behaving strangely.
 *
 * And a DELETE refused because another row still points at the one being
 * deleted is NOT a 23503 on the server this runs on. Postgres 18 — PGlite
 * 18.3 here, Neon 18.6 in production — raises 23001 `restrict_violation` for
 * an `ON DELETE RESTRICT` key; 16 and 17 raised 23503. A delete path that
 * recognised only 23503 answered with a 500 on the deployed server and with
 * its sentence on CI's Postgres 16, which is the worst way for the two to
 * disagree: the test server passes it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  isCheckViolation, isForeignKeyViolation, isReferencedRowRefusal, isRestrictViolation, isUniqueViolation,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the statement to throw')
}

describe('pg-errors', () => {
  let db: TestDb
  let orgId: string

  beforeAll(async () => {
    db = await migratedDb()
    ;[{ id: orgId }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Agency') RETURNING id`)
  })
  afterAll(async () => { await db.close() })

  it('recognises a real 23505 — two suppressions with one key', async () => {
    const insert = () =>
      db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'email', 'stop@example.com', 'r')`,
        [orgId],
      )
    await insert()
    const err = await caught(insert)
    expect(isUniqueViolation(err)).toBe(true)
    expect(isForeignKeyViolation(err)).toBe(false)
    expect(isCheckViolation(err)).toBe(false)
  })

  it('recognises a real 23503 — a company in an org that does not exist', async () => {
    const err = await caught(() =>
      db.driver.select(`INSERT INTO companies (org_id, domain) VALUES ('00000000-0000-0000-0000-000000000000', 'x.example')`),
    )
    expect(isForeignKeyViolation(err)).toBe(true)
    expect(isUniqueViolation(err)).toBe(false)
  })

  it('recognises a real 23514, and by name only when a name is given', async () => {
    const err = await caught(() =>
      db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'email', 'Upper@Example.com', 'r')`,
        [orgId],
      ),
    )
    expect(isCheckViolation(err)).toBe(true)
    expect(isCheckViolation(err, 'suppressions_value_is_normalised')).toBe(true)
    // The wrong name is a different rule, and must not be reported as this one.
    expect(isCheckViolation(err, 'suppressions_source_is_known')).toBe(false)
    expect(isUniqueViolation(err)).toBe(false)
  })

  it('walks a nested cause', async () => {
    const inner = await caught(() =>
      db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'email', 'stop@example.com', 'r')`,
        [orgId],
      ),
    )
    const wrapped = new Error('query failed', { cause: new Error('driver', { cause: inner }) })
    expect(isUniqueViolation(wrapped)).toBe(true)
    expect(isCheckViolation(wrapped)).toBe(false)
  })

  describe('a DELETE of a row something still references', () => {
    /** A credential a connector holds — `connectors_secret_ref_points_at_a_secret`, ON DELETE RESTRICT (0009). */
    async function heldSecret(name: string): Promise<string> {
      const [{ id }] = await db.driver.select<{ id: string }>(
        `INSERT INTO secrets (org_id, label, ciphertext) VALUES ($1, 'k', repeat('A', 44)) RETURNING id`,
        [orgId],
      )
      await db.driver.select(
        `INSERT INTO connectors (org_id, name, kind, secret_ref, config) VALUES ($1, $2, 'http', $3, '{"url":"https://mcp.example.com/mcp"}')`,
        [orgId, name, id],
      )
      return id
    }

    it('is 23001 on this engine, which isForeignKeyViolation does not see and isRestrictViolation does', async () => {
      const secretId = await heldSecret('held-one')
      const err = await caught(() => db.driver.select(`DELETE FROM secrets WHERE id = $1`, [secretId]))
      expect((err as { code?: unknown }).code).toBe('23001')
      // The reason the reader exists: the old one reads this refusal as "not mine".
      expect(isForeignKeyViolation(err)).toBe(false)
      expect(isRestrictViolation(err)).toBe(true)
      expect(isRestrictViolation(err, 'connectors_secret_ref_points_at_a_secret')).toBe(true)
      expect(isRestrictViolation(err, 'proposals_scan_id_fkey')).toBe(false)
      expect(isUniqueViolation(err)).toBe(false)
    })

    it('is recognised by isReferencedRowRefusal whichever code the server raises, scoped by name', async () => {
      const secretId = await heldSecret('held-two')
      const pg18 = await caught(() => db.driver.select(`DELETE FROM secrets WHERE id = $1`, [secretId]))
      expect(isReferencedRowRefusal(pg18)).toBe(true)
      expect(isReferencedRowRefusal(pg18, 'connectors_secret_ref_points_at_a_secret')).toBe(true)
      expect(isReferencedRowRefusal(pg18, 'some_other_key')).toBe(false)
      // Postgres 16 and 17 report the same refusal as 23503, which CI's real
      // server raises; the shape is the drivers'.
      const pg16 = { code: '23503', constraint: 'connectors_secret_ref_points_at_a_secret' }
      expect(isReferencedRowRefusal(pg16)).toBe(true)
      expect(isReferencedRowRefusal(pg16, 'connectors_secret_ref_points_at_a_secret')).toBe(true)
      expect(isReferencedRowRefusal(pg16, 'some_other_key')).toBe(false)
      expect(isRestrictViolation(pg16)).toBe(false)
      // Wrapped the way drizzle wraps it.
      expect(isReferencedRowRefusal(new Error('query failed', { cause: pg18 }))).toBe(true)
    })

    it('does not mistake any other refusal for one', async () => {
      const unique = await caught(async () => {
        const insert = () =>
          db.driver.select(
            `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'email', 'twice@example.com', 'r')`,
            [orgId],
          )
        await insert()
        await insert()
      })
      expect(isReferencedRowRefusal(unique)).toBe(false)
      expect(isRestrictViolation(unique)).toBe(false)
      expect(isReferencedRowRefusal(new Error('violates foreign key constraint'))).toBe(false)
      expect(isRestrictViolation('23001')).toBe(false)
    })
  })

  it('is not fooled by a plain Error, a string, null or a cycle', () => {
    expect(isUniqueViolation(new Error('duplicate key'))).toBe(false)
    expect(isForeignKeyViolation('23503')).toBe(false)
    expect(isCheckViolation(null)).toBe(false)
    expect(isCheckViolation(undefined)).toBe(false)
    const loop: { cause?: unknown; code?: string } = {}
    loop.cause = loop
    expect(isUniqueViolation(loop)).toBe(false)
  })

  it('reads a shape-only error the way the drivers throw it', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isCheckViolation({ code: '23514', constraint: 'tasks_kind_known' }, 'tasks_kind_known')).toBe(true)
    expect(isCheckViolation({ code: '23514', constraint: 'tasks_kind_known' }, 'notes_body_is_bounded')).toBe(false)
  })
})

/**
 * Every module that maps a refused statement to a sentence reads the code
 * through this module. A private walker comparing '23503' is how a DELETE
 * path came to know only Postgres 16's answer; `credentials.ts` carried one
 * that also knew 23001, and nothing else would have.
 */
describe('nobody else compares a foreign-key SQLSTATE', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url))
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'pg-errors.ts')

  it('reads the source directory', () => {
    expect(sources).toContain('credentials.ts')
    expect(sources.length).toBeGreaterThan(20)
  })

  it.each(sources)('%s', (file) => {
    const code = readFileSync(`${dir}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/['"]23(001|503)['"]/)
  })

  it('credentials.ts recognises the refusal it reports through the shared reader', () => {
    const src = readFileSync(`${dir}credentials.ts`, 'utf8')
    expect(src).toMatch(/isReferencedRowRefusal\(err, HELD_BY_A_CONNECTOR\)/)
  })
})
