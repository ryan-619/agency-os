/**
 * create_share_link (2026-10-08): a link to a business's audit page or
 * website preview, made from chat. It sends nothing, stores only the link's
 * hash, and the first view's task goes to the person whose chat it is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { shareLinkHash, shareLinkResolve, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { migratedDb, type TestDb } from '../../db/test/helpers.js'
import { createShareLink, type ToolContext, type ToolOutcome } from '../src/index.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')

describe('create_share_link', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  const audited: Array<{ action: string; detail: Record<string, unknown> }> = []

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    audited.length = 0
    const [org] = await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    await db.insert(schema.companies).values([
      {
        orgId, domain: 'kumar-dental-ab12.nosite.invalid', name: 'Kumar Dental', source: 'google_maps', googlePlaceId: 'ChIJk',
        googleCategory: 'dentist', listingCheckedAt: new Date('2026-10-07T00:00:00Z'),
      },
      { orgId, domain: 'sharmaoptics.in', name: 'Sharma Optics', googlePlaceId: 'ChIJs', listingCheckedAt: new Date('2026-10-07T00:00:00Z') },
      { orgId, domain: 'rentman.io', name: 'Rentman' },
    ])
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db,
    orgId,
    principal: { id: ownerId, orgId, role: 'owner' },
    turnId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    audit: async (action, detail) => {
      audited.push({ action, detail })
    },
    webOrigin: 'https://myagencyos.in',
    ...over,
  })
  const run = (input: unknown, over: Partial<ToolContext> = {}) =>
    createShareLink.handler(z.object(createShareLink.shape).parse(input) as never, ctx(over))
  const summaryOf = (out: ToolOutcome<unknown>): string => {
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`)
    return out.summary
  }

  it('makes an audit page link, prints it in full, says nothing was sent, and stores only its hash', async () => {
    const summary = summaryOf(await run({ domain: 'kumar-dental-ab12.nosite.invalid', kind: 'report' }))
    expect(summary).toMatch(/^Made the audit page link for Kumar Dental, open until 2026-11-07:/)
    const url = summary.match(/https:\/\/myagencyos\.in\/r\/([A-Za-z0-9_-]{43})/)
    expect(url).not.toBeNull()
    expect(summary).toContain('Nothing was sent.')
    const token = url![1]!
    const link = await shareLinkResolve(db, token, 'report', NOW)
    expect(link).toMatchObject({ orgId, kind: 'report', createdBy: ownerId, viewCount: 0 })
    const rows = await db.select().from(schema.shareLinks)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).toBe(shareLinkHash(token))
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(audited).toEqual([{ action: 'agent.create_share_link', detail: { kind: 'report', companyId: link!.companyId, linkId: link!.id } }])
    const [created] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'share_link.created'))
    expect(created).toMatchObject({ actor: 'agent' })
    expect(JSON.stringify(created!.detail)).not.toContain(token)
  })

  it('makes a preview only from a listing, and calls one for a business with a site a fresh design', async () => {
    const refused = await run({ domain: 'rentman.io', kind: 'preview' })
    expect(refused).toMatchObject({ ok: false, code: 'invalid_state' })
    expect(await db.select().from(schema.shareLinks)).toEqual([])

    const summary = summaryOf(await run({ domain: 'https://www.SharmaOptics.in/', kind: 'preview' }))
    expect(summary).toMatch(/https:\/\/myagencyos\.in\/w\/[A-Za-z0-9_-]{43}/)
    expect(summary).toContain('has a website of its own (sharmaoptics.in), so present this as a fresh design')
    expect(summaryOf(await run({ domain: 'kumar-dental-ab12.nosite.invalid', kind: 'preview' }))).not.toContain('fresh design')
  })

  it('prints the path, and says why, when the worker was not told the app’s address', async () => {
    const summary = summaryOf(await run({ domain: 'kumar-dental-ab12.nosite.invalid', kind: 'report' }, { webOrigin: undefined }))
    expect(summary).toMatch(/<the app's own address>\/r\/[A-Za-z0-9_-]{43}/)
    expect(summary).toContain('WEB_PUBLIC_URL')
  })

  it('refuses a company that is not in the CRM, and a role that cannot write companies', async () => {
    expect(await run({ domain: 'nobody.example', kind: 'report' })).toMatchObject({ ok: false, code: 'not_found' })
    const viewer = await run({ domain: 'rentman.io', kind: 'report' }, { principal: { id: ownerId, orgId, role: 'nobody' as never } })
    expect(viewer).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await db.select().from(schema.shareLinks)).toEqual([])
  })
})
