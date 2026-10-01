/**
 * The audit log's readers, against a real engine (PROMPT.md §2.4).
 *
 * The log had one writer and no reader. These prove the reader shows every
 * row exactly once, in a stable order, to the org that wrote it and nobody
 * else — and that the joins that make a row readable tolerate a subject
 * that is gone rather than dropping the line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  appendAudit, auditForSubject, auditResolveActors, auditSubjectsToCompanies, listAudit, schema,
  type AgencyDb, type AuditRow,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

const AT = new Date('2026-09-15T12:00:00.000Z')

describe('the audit log reader', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let userId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org, other] = await db
      .insert(schema.orgs)
      .values([{ name: 'Agency' }, { name: 'Another agency' }])
      .returning({ id: schema.orgs.id })
    orgId = org!.id
    otherOrgId = other!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', name: 'Olu', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', name: 'Rentman' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const write = (action: string, over: Partial<typeof schema.auditLog.$inferInsert> = {}) =>
    db
      .insert(schema.auditLog)
      .values({ orgId, actor: 'system', action, ...over })
      .returning()
      .then((r) => r[0]!)

  /** Page through everything with a given page size, the way /audit does. */
  const pageAll = async (limit: number, opts: Parameters<typeof listAudit>[2] = {}): Promise<AuditRow[]> => {
    const seen: AuditRow[] = []
    let before: { createdAt: Date; id: string } | undefined
    for (let i = 0; i < 50; i++) {
      const page = await listAudit(db, orgId, { ...opts, limit, before })
      seen.push(...page)
      const last = page.at(-1)
      if (!last || page.length < limit) break
      before = { createdAt: last.createdAt, id: last.id }
    }
    return seen
  }

  it('shows an org its own rows and never another org’s, on both readers', async () => {
    const mine = await write('deal.moved', { actor: userId, subjectType: 'deal', subjectId: companyId })
    const theirs = await write('deal.moved', { orgId: otherOrgId, subjectType: 'deal', subjectId: companyId })

    expect((await listAudit(db, orgId)).map((r) => r.id)).toEqual([mine.id])
    expect((await listAudit(db, otherOrgId)).map((r) => r.id)).toEqual([theirs.id])
    // The same subject id in both orgs: the subject lookup still carries the org.
    expect((await auditForSubject(db, orgId, 'deal', companyId)).map((r) => r.id)).toEqual([mine.id])
    expect((await auditForSubject(db, otherOrgId, 'deal', companyId)).map((r) => r.id)).toEqual([theirs.id])
  })

  it('pages rows that share one created_at exactly once each, in a stable order', async () => {
    const rows = await Promise.all(['a.one', 'a.two', 'a.three'].map((action) => write(action, { createdAt: AT })))
    const expected = rows.map((r) => r.id).sort().reverse()

    for (const limit of [1, 2]) {
      const seen = await pageAll(limit)
      expect(seen.map((r) => r.id), `limit ${limit}`).toEqual(expected)
    }
    // And a second read agrees with the first: the order is total, not luck.
    expect((await listAudit(db, orgId)).map((r) => r.id)).toEqual(expected)
  })

  /**
   * The bug the cursor lookup exists for. `created_at` holds microseconds; a
   * Date holds milliseconds, so a cursor taken from the last row's Date is
   * up to 999µs EARLIER than that row. Compared naively, every row written
   * inside that gap is skipped — here, the two in the middle.
   */
  it('does not skip rows written within the same millisecond as the cursor row', async () => {
    for (const us of ['12:00:00.123900', '12:00:00.123600', '12:00:00.123300', '12:00:00.123000']) {
      await test.pg.query(
        `INSERT INTO audit_log (org_id, actor, action, created_at) VALUES ($1, 'system', 'tick.at', $2::timestamptz)`,
        [orgId, `2026-09-15 ${us}+00`],
      )
    }
    const seen = await pageAll(1)
    expect(seen).toHaveLength(4)
    expect(new Set(seen.map((r) => r.id)).size).toBe(4)
  })

  it('pages newest first across different times', async () => {
    const old = await write('x.old', { createdAt: new Date('2026-09-01T00:00:00Z') })
    const mid = await write('x.mid', { createdAt: new Date('2026-09-10T00:00:00Z') })
    const recent = await write('x.new', { createdAt: new Date('2026-09-20T00:00:00Z') })
    expect((await pageAll(1)).map((r) => r.id)).toEqual([recent.id, mid.id, old.id])
  })

  it('filters by a whole action segment, never a substring or a LIKE wildcard', async () => {
    const sent = await write('send.sent')
    const held = await write('send.quiet_hours')
    await write('sender.test')
    await write('contact.optXout.later')
    const optOut = await write('contact.opt_out_not_recorded')

    expect((await listAudit(db, orgId, { actionPrefix: 'send' })).map((r) => r.id).sort()).toEqual([sent.id, held.id].sort())
    expect((await listAudit(db, orgId, { actionPrefix: 'send.' })).map((r) => r.id).sort()).toEqual([sent.id, held.id].sort())
    expect((await listAudit(db, orgId, { actionPrefix: 'send.sent' })).map((r) => r.id)).toEqual([sent.id])
    // `_` unescaped would match the X; escaped, it matches only itself.
    expect((await listAudit(db, orgId, { actionPrefix: 'contact.opt_out_not_recorded' })).map((r) => r.id)).toEqual([optOut.id])
    expect(await listAudit(db, orgId, { actionPrefix: 'contact.opt_out' })).toEqual([])
    expect(await listAudit(db, orgId, { actionPrefix: 'contact.opt%' })).toEqual([])
  })

  it('filters by actor and by subject type, and answers nothing for an id that cannot exist', async () => {
    const mine = await write('deal.moved', { actor: userId, subjectType: 'deal', subjectId: companyId })
    const agent = await write('agent.get_icp', { actor: 'agent', subjectType: 'chat_session' })
    expect((await listAudit(db, orgId, { actor: userId })).map((r) => r.id)).toEqual([mine.id])
    expect((await listAudit(db, orgId, { actor: 'agent' })).map((r) => r.id)).toEqual([agent.id])
    expect((await listAudit(db, orgId, { subjectType: 'chat_session' })).map((r) => r.id)).toEqual([agent.id])
    // From a URL: a Postgres cast error would be a 500 on a typo.
    expect(await listAudit(db, orgId, { subjectId: 'rentman.io' })).toEqual([])
    expect(await listAudit(db, orgId, { before: { createdAt: AT, id: 'not-a-uuid' } })).toEqual([])
  })

  it('bounds a page however large the limit asked for', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => write(`bulk.n${i}`)))
    expect(await listAudit(db, orgId, { limit: 0 })).toHaveLength(1)
    expect(await listAudit(db, orgId, { limit: 3 })).toHaveLength(3)
    expect(await listAudit(db, orgId, { limit: 1_000_000 })).toHaveLength(5)
  })

  describe('auditSubjectsToCompanies', () => {
    it('maps a deal subject and a touch subject to their company', async () => {
      const [deal] = await db.insert(schema.deals).values({ orgId, companyId, stage: 'replied' }).returning()
      const [contact] = await db
        .insert(schema.contacts)
        .values({ orgId, companyId, email: 'priya@rentman.io' })
        .returning()
      // A touch whose own company was cleared: it still reaches the company through its contact.
      const [touch] = await db
        .insert(schema.touches)
        .values({ orgId, contactId: contact!.id, companyId: null, channel: 'email', direction: 'in', status: 'replied' })
        .returning()

      const dealRow = await write('deal.moved', { actor: userId, subjectType: 'deal', subjectId: deal!.id })
      const touchRow = await write('send.sent', { subjectType: 'touch', subjectId: touch!.id })
      const contactRow = await write('contact.paused', { actor: userId, subjectType: 'contact', subjectId: contact!.id })
      const agentRow = await write('agent.get_icp', { actor: 'agent', subjectType: 'chat_session' })

      const map = await auditSubjectsToCompanies(db, orgId, [dealRow, touchRow, contactRow, agentRow])
      expect(map.get(dealRow.id)).toMatchObject({ id: companyId, domain: 'rentman.io', name: 'Rentman' })
      expect(map.get(touchRow.id)).toMatchObject({ domain: 'rentman.io' })
      expect(map.get(contactRow.id)).toMatchObject({ domain: 'rentman.io' })
      expect(map.has(agentRow.id)).toBe(false)
    })

    it('falls back to detail.companyId when the subject is gone, and resolves nothing across orgs', async () => {
      const goneDeal = '00000000-0000-4000-8000-00000000dead'
      const gone = await write('deal.moved', { actor: userId, subjectType: 'deal', subjectId: goneDeal, detail: { companyId } })
      const [foreign] = await db
        .insert(schema.companies)
        .values({ orgId: otherOrgId, domain: 'elsewhere.test' })
        .returning({ id: schema.companies.id })
      const [foreignDeal] = await db.insert(schema.deals).values({ orgId: otherOrgId, companyId: foreign!.id }).returning()
      // A row that names another org's deal and company — a bug elsewhere, never a leak here.
      const stray = await write('deal.moved', { subjectType: 'deal', subjectId: foreignDeal!.id, detail: { companyId: foreign!.id } })

      const map = await auditSubjectsToCompanies(db, orgId, [gone, stray])
      expect(map.get(gone.id)).toMatchObject({ domain: 'rentman.io' })
      expect(map.has(stray.id)).toBe(false)
    })
  })

  describe('auditResolveActors', () => {
    it('marks a user whose access was revoked, and looks up no literal', async () => {
      const [gone] = await db
        .insert(schema.users)
        .values({ orgId, email: 'left@agency.test', name: 'Left', revokedAt: new Date('2026-09-01T00:00:00Z') })
        .returning({ id: schema.users.id })
      const [foreign] = await db
        .insert(schema.users)
        .values({ orgId: otherOrgId, email: 'someone@other.test' })
        .returning({ id: schema.users.id })

      const map = await auditResolveActors(db, orgId, [userId, gone!.id, foreign!.id, 'agent', 'system', userId])
      expect(map.get(userId)).toEqual({ email: 'owner@agency.test', name: 'Olu', revoked: false })
      expect(map.get(gone!.id)).toEqual({ email: 'left@agency.test', name: 'Left', revoked: true })
      // Another org's user is not this org's teammate, former or otherwise.
      expect(map.has(foreign!.id)).toBe(false)
      expect(map.has('agent')).toBe(false)
      expect(map.size).toBe(2)
    })
  })

  it('reads back what appendAudit wrote, detail and all', async () => {
    await appendAudit(db, {
      orgId, actor: userId, action: 'proposal.sent', subjectType: 'proposal',
      subjectId: '00000000-0000-4000-8000-000000000001', detail: { companyId },
    })
    const [row] = await listAudit(db, orgId)
    expect(row).toMatchObject({ actor: userId, action: 'proposal.sent', subjectType: 'proposal', detail: { companyId } })
  })
})
