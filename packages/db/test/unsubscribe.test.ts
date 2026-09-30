/**
 * One-click unsubscribe (RFC 8058, §2.1), against a real engine.
 *
 * A click IS the opt-out. So the tests that matter are the ones where it
 * would be easy to answer "done" without the row: an address that cannot be
 * normalised, a database that throws, a contact edited or deleted since the
 * message went. Each of those must either write the suppression row for the
 * address the message was DELIVERED to, or come back `not_recorded` with the
 * audit row and the log line already written.
 *
 * The token half is checked from both barrels on purpose: the worker mints
 * through the package root, the web verifies through `queries`, and the two
 * must agree byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { schema, unsubscribeHeaders, unsubscribeToken, type AgencyDb, type InboundLog } from '../src/index.js'
import { recordUnsubscribe, unsubscribeOrgName, verifyUnsubscribeToken } from '../src/queries.js'
import { migratedDb, type TestDb } from './helpers.js'

const SECRET = 's'.repeat(32) + '-unsubscribe-test'
const OTHER_SECRET = 'o'.repeat(32) + '-unsubscribe-test'
const NOON = new Date('2026-09-15T12:00:00.000Z')

/** Collects what the loud path said, so a test can assert it was loud. */
function capturingLog(): InboundLog & { lines: { message: string; fields: Record<string, unknown> }[] } {
  const lines: { message: string; fields: Record<string, unknown> }[] = []
  return { lines, error: (message, fields) => void lines.push({ message, fields: { ...fields } }) }
}

describe('the unsubscribe token', () => {
  const touchId = '0b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b'

  it('round-trips: what the worker mints, the web verifies', () => {
    const token = unsubscribeToken(SECRET, touchId)
    expect(verifyUnsubscribeToken(SECRET, token)).toEqual({ ok: true, touchId })
  })

  it('carries the touch id and a MAC — never an address', () => {
    const token = unsubscribeToken(SECRET, touchId)
    expect(token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/)
    expect(token).not.toContain('@')
  })

  it('refuses a token signed with another secret', () => {
    expect(verifyUnsubscribeToken(OTHER_SECRET, unsubscribeToken(SECRET, touchId))).toEqual({ ok: false })
  })

  it('refuses a tampered token: one MAC digit, or another touch id under the same MAC', () => {
    const token = unsubscribeToken(SECRET, touchId)
    const last = token.at(-1) === '0' ? '1' : '0'
    expect(verifyUnsubscribeToken(SECRET, token.slice(0, -1) + last)).toEqual({ ok: false })
    const mac = token.split('.')[1]!
    expect(verifyUnsubscribeToken(SECRET, `1b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b.${mac}`)).toEqual({ ok: false })
  })

  it('refuses a truncated or malformed token without throwing', () => {
    const token = unsubscribeToken(SECRET, touchId)
    for (const bad of [
      token.slice(0, -1),
      token.slice(0, 36),
      touchId,
      `${touchId}.`,
      `.${token.split('.')[1]}`,
      token.toUpperCase(),
      `${token}.extra`,
      `${token}00`,
      'not-a-token',
      '',
      `${'a'.repeat(200)}.${'b'.repeat(64)}`,
    ]) {
      expect(verifyUnsubscribeToken(SECRET, bad), bad).toEqual({ ok: false })
    }
  })

  it('verifies nothing with a blank secret — fail closed', () => {
    expect(verifyUnsubscribeToken('', unsubscribeToken('', touchId))).toEqual({ ok: false })
  })

  it('builds the two RFC 8058 headers from the public origin, trailing slash or not', () => {
    const h = unsubscribeHeaders(SECRET, 'https://agency.example/', touchId)
    expect(h).toEqual({
      'List-Unsubscribe': `<https://agency.example/api/unsubscribe/${unsubscribeToken(SECRET, touchId)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    expect(unsubscribeHeaders(SECRET, 'https://agency.example', touchId)).toEqual(h)
  })
})

describe('recording a one-click unsubscribe', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb

    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: 'owner@agency.test', role: 'owner' })
      .returning({ id: schema.users.id })
    userId = user!.id
    const [company] = await db
      .insert(schema.companies)
      .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.companies.id })
    companyId = company!.id
    const [contact] = await db
      .insert(schema.contacts)
      .values({ orgId, companyId, email: 'priya@rentman.io', timeZone: 'Europe/London' })
      .returning({ id: schema.contacts.id })
    contactId = contact!.id
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'Q4', channel: 'email', autoSend: true, dailyCap: 25, status: 'active' })
      .returning({ id: schema.campaigns.id })
    campaignId = campaign!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** An outbound email as `dispatchTouch` leaves it once sent: the recipient captured. */
  const sentTouch = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(schema.touches)
      .values({
        orgId, campaignId, contactId, companyId, channel: 'email', direction: 'out',
        status: 'sent', sentAt: NOON, recipient: 'priya@rentman.io', providerId: '<m1@agency.test>',
        subject: 'A gap on your security page', body: 'Hello.',
        ...over,
      })
      .returning({ id: schema.touches.id })
    return row!.id
  }
  const suppressions = () => db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, orgId))
  const audit = (action: string) =>
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))
  const contactRow = async () =>
    (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]!

  it('writes the suppression row with source "unsubscribe", pauses the contact, and audits it', async () => {
    const touchId = await sentTouch()
    const log = capturingLog()
    const r = await recordUnsubscribe(db, { touchId, now: NOON, log })
    expect(r).toMatchObject({ ok: true, orgId, contactId, alreadyPresent: false, addresses: 1, paused: true })

    const rows = await suppressions()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'email', value: 'priya@rentman.io', source: 'unsubscribe' })
    expect(rows[0]!.reason).toBe('unsubscribed by one-click link, 2026-09-15')

    const c = await contactRow()
    expect(c.pausedAt).not.toBeNull()
    expect(c.pausedReason).toMatch(/^unsubscribed /)

    const a = await audit('contact.unsubscribed')
    expect(a).toHaveLength(1)
    expect(a[0]!.detail).toMatchObject({ contactId, touchId })
    // §2.3: ids and counts, never the address.
    expect(JSON.stringify(a[0]!.detail)).not.toContain('@')
    expect(log.lines).toEqual([])
  })

  it('refuses everything still queued for them as consent_revoked, and leaves what was sent alone', async () => {
    const touchId = await sentTouch()
    const queued = await sentTouch({ status: 'queued', sentAt: null, recipient: null, providerId: null })
    const approved = await sentTouch({ status: 'approved', approvedBy: userId, approvedAt: NOON, sentAt: null, recipient: null, providerId: null })
    const draft = await sentTouch({ status: 'awaiting_approval', sentAt: null, recipient: null, providerId: null })

    const r = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(r).toMatchObject({ ok: true, cancelled: 3 })
    for (const id of [queued, approved, draft]) {
      const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id))
      expect(row).toMatchObject({ status: 'refused', refusalCode: 'consent_revoked' })
    }
    const [sent] = await db.select().from(schema.touches).where(eq(schema.touches.id, touchId))
    expect(sent!.status).toBe('sent')
  })

  it('is idempotent: a second click finds the row present and writes no second audit row', async () => {
    const touchId = await sentTouch()
    await recordUnsubscribe(db, { touchId, now: NOON })
    const again = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(again).toMatchObject({ ok: true, alreadyPresent: true, paused: false, cancelled: 0 })
    expect(await suppressions()).toHaveLength(1)
    expect(await audit('contact.unsubscribed')).toHaveLength(1)
  })

  /**
   * The skeptic's case. The contact's address was edited after the message
   * went: the mailbox that clicked is the OLD one, and suppressing only the
   * current address would leave it receiving mail.
   */
  it('suppresses the address the message was delivered to, and the edited current one too', async () => {
    const touchId = await sentTouch({ recipient: 'priya@rentman.io' })
    await db.update(schema.contacts).set({ email: 'priya.k@rentman.io' }).where(eq(schema.contacts.id, contactId))

    const r = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(r).toMatchObject({ ok: true, addresses: 2 })
    const values = (await suppressions()).map((s) => s.value).sort()
    expect(values).toEqual(['priya.k@rentman.io', 'priya@rentman.io'])
  })

  it('writes one row, not two, when the current address differs only in case', async () => {
    const touchId = await sentTouch({ recipient: 'priya@rentman.io' })
    await db.update(schema.contacts).set({ email: 'Priya@Rentman.io' }).where(eq(schema.contacts.id, contactId))
    const r = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(r).toMatchObject({ ok: true, addresses: 1 })
    expect(await suppressions()).toHaveLength(1)
  })

  /**
   * `touches.contact_id` is SET NULL so the log outlives the contact. The
   * recipient is still on the row, so there is still something to record —
   * and a re-imported contact must find the suppression waiting.
   */
  it('still records for a touch whose contact was deleted', async () => {
    const touchId = await sentTouch()
    await db.delete(schema.contacts).where(eq(schema.contacts.id, contactId))
    const [t] = await db.select().from(schema.touches).where(eq(schema.touches.id, touchId))
    expect(t!.contactId).toBeNull()

    const r = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(r).toMatchObject({ ok: true, contactId: null, addresses: 1, paused: false })
    expect((await suppressions()).map((s) => s.value)).toEqual(['priya@rentman.io'])
    const a = await audit('contact.unsubscribed')
    expect(a[0]).toMatchObject({ subjectType: 'touch', subjectId: touchId })
  })

  it('is not_found for an unknown touch, an inbound one, or one that was not an email', async () => {
    expect(await recordUnsubscribe(db, { touchId: '0b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b', now: NOON })).toMatchObject({
      ok: false, reason: 'not_found',
    })
    const inbound = await sentTouch({ direction: 'in', status: 'replied', campaignId: null })
    expect(await recordUnsubscribe(db, { touchId: inbound, now: NOON })).toMatchObject({ ok: false, reason: 'not_found' })
    const [li] = await db
      .insert(schema.campaigns)
      .values({ orgId, name: 'LinkedIn', channel: 'linkedin', autoSend: false, dailyCap: 10, status: 'active' })
      .returning({ id: schema.campaigns.id })
    const linkedin = await sentTouch({ channel: 'linkedin', campaignId: li!.id, recipient: 'linkedin.com/in/priya' })
    expect(await recordUnsubscribe(db, { touchId: linkedin, now: NOON })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await suppressions()).toEqual([])
  })

  it('is not_recorded — audited and logged — when the delivered address cannot be normalised', async () => {
    const touchId = await sentTouch({ recipient: 'Priya <not an address>' })
    await db.update(schema.contacts).set({ email: 'Priya <not an address>' }).where(eq(schema.contacts.id, contactId))
    const log = capturingLog()

    const r = await recordUnsubscribe(db, { touchId, now: NOON, log })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'unparseable_address', orgId, contactId, touchId })
    expect(await suppressions()).toEqual([])

    const a = await audit('unsubscribe.not_recorded')
    expect(a).toHaveLength(1)
    expect(a[0]!.detail).toMatchObject({ touchId, contactId, why: 'unparseable_address' })
    expect(JSON.stringify(a[0]!.detail)).not.toContain('not an address')
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED/)
    expect(JSON.stringify(log.lines[0]!.fields)).not.toContain('not an address')

    // The safe direction still happens: nothing else goes to them.
    expect((await contactRow()).pausedAt).not.toBeNull()
    expect(await audit('contact.unsubscribed')).toEqual([])
  })

  it('is not_recorded when the edited current address fails, even though the delivered one was written', async () => {
    const touchId = await sentTouch({ recipient: 'priya@rentman.io' })
    await db.update(schema.contacts).set({ email: 'not an address' }).where(eq(schema.contacts.id, contactId))
    const r = await recordUnsubscribe(db, { touchId, now: NOON, log: capturingLog() })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'unparseable_address' })
    expect((await suppressions()).map((s) => s.value)).toEqual(['priya@rentman.io'])
    expect(await audit('unsubscribe.not_recorded')).toHaveLength(1)
  })

  /**
   * An erased touch, or a worker that died between the provider and the
   * write, has no recipient. That is not a refusal — somebody clicked — it
   * is the loud path.
   */
  it('is not_recorded, loudly, for a touch with no recipient', async () => {
    const touchId = await sentTouch({ recipient: null, contactId: null })
    const log = capturingLog()
    const r = await recordUnsubscribe(db, { touchId, now: NOON, log })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'no_recipient', contactId: null, orgId })
    expect(await audit('unsubscribe.not_recorded')).toHaveLength(1)
    expect(log.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED/)
  })

  it('still suppresses the contact’s current address when the touch has no recipient — and still says not_recorded', async () => {
    const touchId = await sentTouch({ recipient: null })
    const r = await recordUnsubscribe(db, { touchId, now: NOON, log: capturingLog() })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'no_recipient' })
    expect((await suppressions()).map((s) => s.value)).toEqual(['priya@rentman.io'])
  })

  /**
   * A THROW is what a database fault actually does. The same failure to the
   * person who clicked as an unreadable address, and it must not escape as
   * an exception that the route turns into a generic 500 with no audit row.
   */
  it('is not_recorded when writing the suppression THROWS, and never lets the exception escape', async () => {
    const touchId = await sentTouch()
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.suppressions) {
              throw Object.assign(new Error('connection terminated unexpectedly'), { name: 'DatabaseError' })
            }
            return target.insert(table as typeof schema.auditLog)
          }
        }
        const v = Reflect.get(target, prop, target) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as AgencyDb
    const log = capturingLog()

    const r = await recordUnsubscribe(failing, { touchId, now: NOON, log })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'DatabaseError', orgId, contactId })
    expect(await suppressions()).toEqual([])
    const a = await audit('unsubscribe.not_recorded')
    expect(a).toHaveLength(1)
    expect(a[0]!.detail).toMatchObject({ why: 'DatabaseError' })
    expect(log.lines[0]!.message).toMatch(/^OPT-OUT NOT RECORDED/)
  })

  it('is not_recorded, and logged, when the database cannot even read the touch', async () => {
    const dead = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          return () => {
            throw Object.assign(new Error('ECONNREFUSED'), { name: 'ConnectionError' })
          }
        }
        const v = Reflect.get(target, prop, target) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as AgencyDb
    const log = capturingLog()
    const touchId = await sentTouch()
    const r = await recordUnsubscribe(dead, { touchId, now: NOON, log })
    expect(r).toMatchObject({ ok: false, reason: 'not_recorded', why: 'ConnectionError', orgId: null })
    expect(log.lines).toHaveLength(1)
  })

  it('finds the touch by id across orgs, and files everything under the TOUCH’s org', async () => {
    const [other] = await db.insert(schema.orgs).values({ name: 'Other Agency' }).returning({ id: schema.orgs.id })
    const touchId = await sentTouch()
    const r = await recordUnsubscribe(db, { touchId, now: NOON })
    expect(r).toMatchObject({ ok: true, orgId })
    const rows = await db.select().from(schema.suppressions).where(eq(schema.suppressions.orgId, other!.id))
    expect(rows).toEqual([])
  })

  it('names the sending org for the page, and nothing for a row that is not an outbound email', async () => {
    const touchId = await sentTouch()
    expect(await unsubscribeOrgName(db, touchId)).toBe('Northwind Security')
    const inbound = await sentTouch({ direction: 'in', status: 'replied', campaignId: null })
    expect(await unsubscribeOrgName(db, inbound)).toBeNull()
    expect(await unsubscribeOrgName(db, '0b8f5a8e-2f1c-4b7e-9a4b-3c2d1e0f9a8b')).toBeNull()
  })

  it('verifies a token minted for a real touch, and the recorded touch is the one it named', async () => {
    const touchId = await sentTouch()
    const check = verifyUnsubscribeToken(SECRET, unsubscribeToken(SECRET, touchId))
    expect(check).toEqual({ ok: true, touchId })
    if (!check.ok) throw new Error('unreachable')
    expect(await recordUnsubscribe(db, { touchId: check.touchId, now: NOON })).toMatchObject({ ok: true })
  })
})
