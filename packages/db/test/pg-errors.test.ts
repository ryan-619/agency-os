/**
 * The Postgres error readers, against real errors from a real engine.
 *
 * A caller that catches a unique violation to say "already on the list"
 * must not also swallow a CHECK violation and say the same thing; and a
 * driver that wraps the error in a `cause` must not hide it. Both are the
 * kind of bug that reads as the product behaving strangely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from '../src/index.js'
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
