/**
 * The suppression routes' audit rows land (PROMPT.md §2.1, §2.4).
 *
 * They never did. Both routes wrote the normalised address into
 * `audit_log.subject_id`, a uuid column; Postgres refused every insert and
 * the route's `.catch(() => {})` — correct, an audit failure must not undo a
 * decision — swallowed it. So the record said nothing about who added or
 * removed an opt-out, and removing one is contacting somebody who asked not
 * to be.
 *
 * The routes now build their entry with `auditSuppressionAdded` /
 * `auditSuppressionRemoved`, and this file runs those same builders through
 * `appendAudit` against a real engine. The old shape is kept here too, to
 * prove it really was refused — a regression test that the bug was the bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  addSuppression, appendAudit, auditSuppressionAdded, auditSuppressionRemoved, listAudit, removeSuppression,
  schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, expectRejection, type TestDb } from './helpers.js'

const route = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../apps/web/src/app/api/suppressions/${rel}`, import.meta.url)), 'utf8')

describe('suppression audit rows', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** What POST /api/suppressions does, in order, minus the session. */
  const addLikeTheRoute = async (kind: 'email' | 'phone', value: string, reason: string) => {
    const result = await addSuppression(db, { orgId, kind, value, reason, source: 'manual' })
    if (!result.ok) throw new Error(result.message)
    await appendAudit(
      db,
      auditSuppressionAdded({ orgId, actor: userId, alreadyPresent: result.alreadyPresent, kind, value: result.value, reason }),
    )
    return result
  }

  it('records an addition: the row lands, with the normalised value in detail and no subject id', async () => {
    await addLikeTheRoute('email', '  Stop@Example.COM ', 'Replied asking us to stop, 12 Sep')

    const [row] = await listAudit(db, orgId, { actionPrefix: 'suppression' })
    expect(row).toMatchObject({
      actor: userId,
      action: 'suppression.added',
      subjectType: 'suppression',
      subjectId: null,
      detail: { kind: 'email', value: 'stop@example.com', reason: 'Replied asking us to stop, 12 Sep' },
    })
    // And the source is on the suppression row itself, as a fact (0018).
    const [stored] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
    expect(stored).toMatchObject({ value: 'stop@example.com', source: 'manual' })
  })

  it('records a duplicate addition as already_present rather than a second add', async () => {
    await addLikeTheRoute('phone', '+1 415 555 0100', 'Asked on a call')
    const again = await addLikeTheRoute('phone', '+14155550100', 'Pasted the list twice')
    expect(again.alreadyPresent).toBe(true)
    const actions = (await listAudit(db, orgId)).map((r) => r.action)
    expect(actions.sort()).toEqual(['suppression.added', 'suppression.already_present'])
  })

  it('records a removal with everything the removed row said, since the row is gone', async () => {
    await addLikeTheRoute('email', 'stop@example.com', 'Replied asking us to stop')
    const [stored] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))

    // What DELETE /api/suppressions/:id does.
    const removed = await removeSuppression(db, orgId, stored!.id)
    expect(removed).not.toBeNull()
    await appendAudit(db, auditSuppressionRemoved({ orgId, actor: userId, removed: removed! }))

    const [row] = await listAudit(db, orgId, { actionPrefix: 'suppression.removed' })
    expect(row).toMatchObject({
      actor: userId,
      subjectType: 'suppression',
      subjectId: null,
      detail: {
        kind: 'email',
        value: 'stop@example.com',
        hadReason: 'Replied asking us to stop',
        hadSource: 'manual',
        addedAt: stored!.createdAt.toISOString(),
      },
    })
  })

  it('bounds the reason it records, as the route always did', () => {
    const entry = auditSuppressionAdded({
      orgId, actor: userId, alreadyPresent: false, kind: 'email', value: 'a@b.test', reason: `  ${'x'.repeat(500)}  `,
    })
    expect((entry.detail as { reason: string }).reason).toHaveLength(200)
  })

  /**
   * The bug, kept as a test: the entry the routes used to write is refused
   * by the database, so "the audit row was silently missing" was the only
   * outcome it could ever have had.
   */
  it('refuses the old shape — an address in the uuid subject_id column', async () => {
    const oldShape = () =>
      appendAudit(db, {
        orgId,
        actor: userId,
        action: 'suppression.added',
        subjectType: 'suppression',
        subjectId: 'stop@example.com',
        detail: { kind: 'email', reason: 'Replied asking us to stop' },
      })
    await expectRejection(oldShape)
    // Drizzle wraps it; the driver's error underneath is Postgres's own:
    // 22P02, invalid input syntax for type uuid.
    const cause = await oldShape().then(
      () => null,
      (err: unknown) => (err as { cause?: { code?: string; message?: string } }).cause ?? null,
    )
    expect(cause?.code).toBe('22P02')
    expect(cause?.message).toMatch(/uuid/i)
    expect(await listAudit(db, orgId)).toEqual([])
  })

  /**
   * The tests above are only about the routes if the routes use these
   * builders. Read the source, like the other structural tests here do.
   */
  it('is what both routes actually write', () => {
    const add = route('route.ts')
    const remove = route('[id]/route.ts')
    expect(add).toContain('auditSuppressionAdded(')
    expect(add).toMatch(/addSuppression\(db, \{[^}]*source: 'manual'/)
    expect(remove).toContain('auditSuppressionRemoved(')
    for (const src of [add, remove]) expect(src).not.toMatch(/subjectId\s*:/)
  })
})
