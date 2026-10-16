/**
 * Suggesting an answer (0026) through the real gate, a fake model and a
 * migrated database: a draft the guard passes is stored once and never as a
 * message; a remote model is not shown a reply without the operator's
 * allowance; the model's NONE and the guard's refusals are recorded as
 * skipped, by code, with none of the words; and the sweep drafts for a
 * reply the worker never read itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { recordInboundReply, replySuggestionRows, schema, type AgencyDb } from '@agency/db'
import { fakeProvider } from '@agency/llm'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { startSuggestions, suggestAnswer } from '../src/outreach/suggest.js'

const NOW = new Date('2026-10-09T10:00:00.000Z')
type Line = { level: string; msg: string; fields: Record<string, unknown> }
const recorder = () => {
  const lines: Line[] = []
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, fields })
  return { lines, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

describe('suggesting an answer', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let contactId: string
  let companyId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy', bookingSlug: 'accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'kumardental.in', name: 'Kumar Dental' }).returning({ id: schema.companies.id }))[0]!.id
    contactId = (await db.insert(schema.contacts).values({ orgId, companyId, email: 'ravi@kumardental.in', firstName: 'Ravi' }).returning({ id: schema.contacts.id }))[0]!.id
    await db.insert(schema.services).values({ orgId, name: 'Website build', needs: [], priceFrom: 25000, priceTo: 60000, currency: 'INR', priceUnit: 'one_off' })
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const reply = async (body: string) =>
    (await recordInboundReply(db, {
      orgId, contactId, channel: 'email', from: 'ravi@kumardental.in', subject: 'Re: a note', body, providerId: `<r-${Math.random()}@k.in>`, now: NOW,
    })).touchId
  const deps = (llm: ReturnType<typeof fakeProvider> | null, allow = false) => {
    const { log, lines } = recorder()
    return { lines, deps: { db, log, llm, allowRemoteForLeadData: allow, webOrigin: 'https://myagencyos.in', now: () => NOW } }
  }

  it('stores a draft the guard passes, once, beside the reply and never as a message', async () => {
    const touchId = await reply('What would a website cost?')
    const llm = fakeProvider('Thanks Ravi — a website build is ₹25,000–₹60,000 one-off. Pick a time: https://myagencyos.in/book/accemy')
    const { deps: d, lines } = deps(llm)
    expect(await suggestAnswer(d, { orgId, touchId })).toBe('drafted')
    expect(await suggestAnswer(d, { orgId, touchId })).toBe('already')
    expect(llm.seen).toHaveLength(1)
    expect(llm.seen[0]!.task).toBe('draft_reply')
    expect(llm.seen[0]!.prompt).toContain('What would a website cost?')
    const [row] = await replySuggestionRows(db, [touchId])
    expect(row).toMatchObject({ status: 'drafted', model: 'fake/fake-1' })
    expect(row!.body).toContain('₹25,000–₹60,000')
    const out = await db.select().from(schema.touches).where(eq(schema.touches.direction, 'out'))
    expect(out).toHaveLength(0)
    // The log carries ids and counts, never the words.
    expect(JSON.stringify(lines)).not.toContain('Thanks Ravi')
    expect(lines.some((l) => l.msg === 'answer suggested')).toBe(true)
  })

  it('does not show a remote model the reply unless the operator allowed it, and writes nothing then', async () => {
    const touchId = await reply('What would a website cost?')
    const remote = fakeProvider('Thanks Ravi.', { name: 'anthropic', local: false })
    const { deps: d, lines } = deps(remote, false)
    expect(await suggestAnswer(d, { orgId, touchId })).toBe('refused')
    expect(remote.seen).toHaveLength(0)
    expect(await replySuggestionRows(db, [touchId])).toEqual([])
    expect(lines.find((l) => l.msg.includes('not asked'))?.fields.code).toBe('lead_data_offsite')
    expect(await suggestAnswer(deps(remote, true).deps, { orgId, touchId })).toBe('drafted')
  })

  it('records the model’s NONE, and the guard’s refusals, as skipped by code with none of the words', async () => {
    const declined = await reply('Hello?')
    expect(await suggestAnswer(deps(fakeProvider('NONE')).deps, { orgId, touchId: declined })).toBe('skipped')
    expect((await replySuggestionRows(db, [declined]))[0]).toMatchObject({ status: 'skipped', skippedWhy: 'model_declined', body: null })

    const priced = await reply('What would it cost?')
    const { deps: d, lines } = deps(fakeProvider('It would be ₹40,000 all in, Ravi.'))
    expect(await suggestAnswer(d, { orgId, touchId: priced })).toBe('skipped')
    expect((await replySuggestionRows(db, [priced]))[0]).toMatchObject({ status: 'skipped', skippedWhy: 'invented_price' })
    const warned = lines.find((l) => l.level === 'warn')!
    expect(warned.fields.problems).toEqual(['invented_price'])
    expect(JSON.stringify(lines)).not.toContain('40,000')

    const tested = await reply('Did you find anything?')
    expect(await suggestAnswer(deps(fakeProvider('Our penetration test found three issues.')).deps, { orgId, touchId: tested })).toBe('skipped')
    expect((await replySuggestionRows(db, [tested]))[0]).toMatchObject({ skippedWhy: 'claims_testing' })
  })

  it('skips a reply the gate refuses without asking the model, and answers no_model with none', async () => {
    const stop = await reply('Please remove me from your list')
    const llm = fakeProvider('Sure, Ravi.')
    expect(await suggestAnswer(deps(llm).deps, { orgId, touchId: stop })).toBe('skipped')
    expect(llm.seen).toHaveLength(0)
    expect((await replySuggestionRows(db, [stop]))[0]).toMatchObject({ skippedWhy: 'opted_out' })
    expect(await suggestAnswer(deps(null).deps, { orgId, touchId: await reply('Hi') })).toBe('no_model')
  })

  it('writes nothing when the model fails, so the sweep tries again', async () => {
    const touchId = await reply('What would a website cost?')
    const broken = { ...fakeProvider(''), complete: async () => { throw new Error('boom') } }
    expect(await suggestAnswer(deps(broken as never).deps, { orgId, touchId })).toBe('failed')
    expect(await replySuggestionRows(db, [touchId])).toEqual([])
  })

  it('the sweep drafts for recent replies with no row, oldest first, and stops at a failing model', async () => {
    const a = await reply('First question')
    const b = await reply('Second question')
    const llm = fakeProvider((req) => (req.prompt.includes('First') ? 'Thanks — yes.' : 'NONE'))
    const { deps: d, lines } = deps(llm)
    const stop = startSuggestions({ ...d, intervalMs: 60_000 })
    await new Promise((r) => setTimeout(r, 300))
    stop()
    expect((await replySuggestionRows(db, [a]))[0]).toMatchObject({ status: 'drafted' })
    expect((await replySuggestionRows(db, [b]))[0]).toMatchObject({ status: 'skipped', skippedWhy: 'model_declined' })
    expect(lines.find((l) => l.msg === 'suggested answers swept')?.fields).toMatchObject({ drafted: 1, skipped: 1 })
  })
})
