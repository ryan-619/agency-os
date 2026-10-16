/**
 * The registered templates (0019): created, switched off, and imported from
 * a DLT portal's CSV export — every line accounted for, idempotent on a
 * re-run, and never overwriting a registration with different words.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import {
  schema, templatesCreate, templatesImportDltCsv, templatesList, templatesSetActive,
  type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

/** A DLT export as the portals write one: header names with spaces, quoted text with commas. */
const EXPORT = [
  'Template ID,Header,Template Type,Template Content,Template Name,Status',
  '1107160000000012345,ACMEIN,Service Explicit,"Hi {#var#}, your call with Acme is at {#var#}.",meeting_reminder,Approved',
  '1107160000000012346,"ACMEIN, ACMEOT",Service Implicit,Your proposal from Acme is ready: {#url#},proposal_ready,Approved',
  '1107160000000012347,ACMEIN,Promotional,Offer for {#var#},offer,Rejected',
  '1107160000000012348,ACMEIN,Service Implicit,Hi {#name#},bad_var,Approved',
  '1.10716E+18,ACMEIN,Service Implicit,Hello,rounded,Approved',
  '1107160000000012349,ACME,Service Implicit,Hello,bad_header,Approved',
  '1107160000000012350,ACMEIN,Marketing,Hello,wrong_category,Approved',
  '1107160000000012345,ACMEIN,Service Explicit,"Hi {#var#}, your call with Acme is at {#var#}.",meeting_reminder,Approved',
  '1107160000000012351,ACMEIN,Service Implicit,Too,many,values,Approved',
].join('\r\n')

describe('message templates (0019)', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [user] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    userId = user!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const audits = async (action: string) => (await db.select().from(schema.auditLog)).filter((a) => a.action === action)

  describe('creating one', () => {
    it('stores it folded the way 0019 keeps it, and audits the ids', async () => {
      const r = await templatesCreate(db, orgId, {
        channel: 'sms', externalId: ' 1107160000000012345 ', senderId: 'acmein', category: 'Service Explicit',
        body: 'Hi {#var#}.', name: 'Greeting', createdBy: userId,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.template).toMatchObject({
        externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit', active: true, language: 'en',
        provider: 'dovesoft', createdBy: userId,
      })
      const [a] = await audits('template.created')
      expect(a?.detail).toEqual({ channel: 'sms', category: 'service_explicit', externalId: '1107160000000012345' })
      expect(a?.actor).toBe(userId)
    })

    it.each([
      [{ senderId: 'ACME' }, 'bad_sender'],
      [{ category: 'marketing' }, 'bad_category'],
      [{ body: 'Hi {#name#}' }, 'bad_body'],
      [{ body: '   ' }, 'bad_body'],
      [{ externalId: '1107 16' }, 'bad_external_id'],
      [{ externalId: '1.10716E+18' }, 'bad_external_id'],
    ])('refuses %j with a sentence', async (over, reason) => {
      const r = await templatesCreate(db, orgId, {
        channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'promotional', body: 'Hi {#var#}.', ...over,
      })
      expect(r).toMatchObject({ ok: false, reason })
      expect(await templatesList(db, orgId)).toHaveLength(0)
    })

    it('refuses a second template with the same id on the same channel', async () => {
      const input = { channel: 'sms' as const, externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'promotional', body: 'Hi {#var#}.' }
      expect((await templatesCreate(db, orgId, input)).ok).toBe(true)
      expect(await templatesCreate(db, orgId, { ...input, body: 'Other' })).toMatchObject({ ok: false, reason: 'duplicate' })
    })

    it('takes a WhatsApp template under Meta’s categories', async () => {
      const r = await templatesCreate(db, orgId, {
        channel: 'whatsapp', externalId: 'meeting_reminder', senderId: '+919800000000', category: 'Utility', body: 'Hi {#var#}',
      })
      expect(r.ok && r.template.category).toBe('utility')
    })
  })

  describe('switching one on and off', () => {
    it('deactivates, is idempotent, and audits only a change', async () => {
      const r = await templatesCreate(db, orgId, {
        channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'promotional', body: 'Hi {#var#}.',
      })
      if (!r.ok) throw new Error(r.message)
      const off = await templatesSetActive(db, { orgId, templateId: r.template.id, active: false, actor: userId })
      expect(off).toMatchObject({ ok: true, changed: true, template: { active: false } })
      expect(await templatesSetActive(db, { orgId, templateId: r.template.id, active: false, actor: userId })).toMatchObject({ ok: true, changed: false })
      expect(await audits('template.deactivated')).toHaveLength(1)
      expect(await templatesSetActive(db, { orgId, templateId: r.template.id, active: true, actor: userId })).toMatchObject({ changed: true })
      expect(await audits('template.activated')).toHaveLength(1)
      expect(await templatesList(db, orgId, { activeOnly: true })).toHaveLength(1)
    })

    it('answers not_found for another org’s template', async () => {
      const r = await templatesCreate(db, orgId, {
        channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'promotional', body: 'Hi {#var#}.',
      })
      if (!r.ok) throw new Error(r.message)
      const [other] = await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id })
      expect(await templatesSetActive(db, { orgId: other!.id, templateId: r.template.id, active: false, actor: 'system' })).toEqual({ ok: false, reason: 'not_found' })
    })
  })

  describe('importing a DLT export', () => {
    it('accounts for every line: imported, skipped or refused, and why', async () => {
      const r = await templatesImportDltCsv(db, orgId, EXPORT, { createdBy: userId })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const byLine = Object.fromEntries(r.lines.map((l) => [l.line, l]))
      expect(byLine[2]).toMatchObject({ outcome: 'imported', externalId: '1107160000000012345' })
      expect(byLine[3]).toMatchObject({ outcome: 'imported', why: expect.stringContaining('stored with the first, ACMEIN') })
      expect(byLine[4]).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('Rejected') })
      expect(byLine[5]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('{#name#}') })
      expect(byLine[6]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('as text') })
      expect(byLine[7]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('six letters or digits') })
      expect(byLine[8]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('not a DLT category') })
      expect(byLine[9]).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('earlier line') })
      expect(byLine[10]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('double quotes') })
      expect(r).toMatchObject({ imported: 2, alreadyPresent: 0, skipped: 2, refused: 5 })

      const stored = await templatesList(db, orgId, { channel: 'sms' })
      expect(stored.map((t) => t.externalId).sort()).toEqual(['1107160000000012345', '1107160000000012346'])
      const greeting = stored.find((t) => t.externalId === '1107160000000012345')!
      expect(greeting).toMatchObject({
        senderId: 'ACMEIN', category: 'service_explicit', name: 'meeting_reminder', createdBy: userId,
        body: 'Hi {#var#}, your call with Acme is at {#var#}.',
      })
      const [a] = await audits('template.imported')
      expect(a?.detail).toEqual({ channel: 'sms', imported: 2, alreadyPresent: 0, skipped: 2, refused: 5 })
    })

    it('is idempotent on a re-import', async () => {
      await templatesImportDltCsv(db, orgId, EXPORT)
      const again = await templatesImportDltCsv(db, orgId, EXPORT)
      expect(again).toMatchObject({ ok: true, imported: 0, alreadyPresent: 2 })
      expect(await templatesList(db, orgId)).toHaveLength(2)
    })

    it('refuses an id already stored with different words, and leaves the stored one alone', async () => {
      await templatesImportDltCsv(db, orgId, EXPORT)
      const changed = [
        'Template ID,Header,Template Type,Template Content',
        '1107160000000012345,ACMEIN,Service Explicit,Hi {#var#} — changed.',
      ].join('\n')
      const r = await templatesImportDltCsv(db, orgId, changed)
      expect(r.ok && r.lines[0]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('new id') })
      const [t] = (await templatesList(db, orgId)).filter((x) => x.externalId === '1107160000000012345')
      expect(t?.body).toBe('Hi {#var#}, your call with Acme is at {#var#}.')
    })

    it('reads the other spellings of the columns, in any case and any order', async () => {
      const csv = [
        'MESSAGE,Category,TEMPLATE_ID,Sender ID',
        '"Your OTP is {#numeric#}",transactional,1107160000000077777,ACMEOT',
      ].join('\n')
      const r = await templatesImportDltCsv(db, orgId, csv)
      expect(r).toMatchObject({ ok: true, imported: 1 })
      expect((await templatesList(db, orgId))[0]).toMatchObject({ externalId: '1107160000000077777', senderId: 'ACMEOT', category: 'transactional', body: 'Your OTP is {#numeric#}' })
    })

    it('imports without a status column, as an export of approved templates', async () => {
      const csv = 'template_id,header,template_type,content\n1107160000000088888,ACMEIN,promotional,Hello {#var#}\n'
      expect(await templatesImportDltCsv(db, orgId, csv)).toMatchObject({ ok: true, imported: 1 })
    })

    it('refuses a file whose header names no template id, and says what is missing', async () => {
      const r = await templatesImportDltCsv(db, orgId, 'Header,Category,Content\nACMEIN,promotional,Hi\n')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain('template id')
      expect(await templatesList(db, orgId)).toHaveLength(0)
    })

    it('refuses a file that was not UTF-8, whole', async () => {
      const r = await templatesImportDltCsv(db, orgId, 'Template ID,Header,Template Type,Template Content\n1,ACMEIN,promotional,Namaste �\n')
      expect(r).toMatchObject({ ok: false, message: expect.stringContaining('UTF-8') })
    })

    it('refuses a quoted value that never closes, whole', async () => {
      const r = await templatesImportDltCsv(db, orgId, 'Template ID,Header,Template Type,Template Content\n1,ACMEIN,promotional,"Hi\n')
      expect(r).toMatchObject({ ok: false, message: expect.stringContaining('never closed') })
    })

    it('refuses an empty file', async () => {
      expect(await templatesImportDltCsv(db, orgId, '﻿\n\n')).toMatchObject({ ok: false })
    })
  })

  /**
   * Review round 9 [14]: Postgres refuses U+0000 in text, and `checkTemplate`
   * let one through in every field — so a pasted body or a corrupted export
   * threw drizzle's error, which the route let escape whole (a 500, and the
   * bound parameters in the platform log), and an import lost its per-line
   * report for every line before the bad one. A template is the registered
   * text exactly, so a NUL is refused, never replaced with U+FFFD.
   */
  describe('a U+0000 in anything a template stores', () => {
    const SMS = { channel: 'sms' as const, externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'promotional', body: 'Hi {#var#}.' }
    const WHATSAPP = { channel: 'whatsapp' as const, externalId: 'meeting_reminder', senderId: '+919800000000', category: 'utility', body: 'Hi {#var#}' }

    it.each([
      ['the text', SMS, { body: 'Hello {#var#}\u0000 from Acme' }, 'bad_body', 'template text'],
      ['a text that is nothing else', SMS, { body: '\u0000' }, 'bad_body', 'template text'],
      ['the DLT template id', SMS, { externalId: '1107160000000012345\u0000' }, 'bad_external_id', 'DLT template id'],
      ['the DLT header', SMS, { senderId: 'ACMEIN\u0000' }, 'bad_sender', 'DLT header'],
      ['the category', SMS, { category: 'promotional\u0000' }, 'bad_category', 'category'],
      ['the name', SMS, { name: 'Greeting\u0000' }, 'bad_name', 'name'],
      ['the language', SMS, { language: 'en\u0000' }, 'bad_language', 'language'],
      ['a WhatsApp template name', WHATSAPP, { externalId: 'meeting_reminder\u0000' }, 'bad_external_id', 'WhatsApp template name'],
      ['a WhatsApp sender', WHATSAPP, { senderId: '+919800000000\u0000' }, 'bad_sender', 'sender'],
    ] as const)('refuses one in %s with a sentence, and stores nothing', async (_what, base, over, reason, label) => {
      const r = await templatesCreate(db, orgId, { ...base, ...over, createdBy: userId })
      expect(r).toEqual({
        ok: false,
        reason,
        message:
          `The ${label} has a NUL character (U+0000) in it. No registered template carries one, the database cannot ` +
          'store one, and replacing it would record words that were never registered — copy it again from the portal ' +
          'it was registered on. Nothing was recorded.',
      })
      expect(await templatesList(db, orgId)).toHaveLength(0)
      expect(await audits('template.created')).toHaveLength(0)
    })

    it('refuses the line on import, and imports and reports every other line', async () => {
      const csv = [
        'Template ID,Header,Template Type,Template Content,Template Name,Status',
        '1107160000000012345,ACMEIN,Service Explicit,"Hi {#var#}, your call is at {#var#}.",meeting_reminder,Approved',
        '1107160000000012346,ACMEIN,Service Implicit,"Hi {#var#}\u0000 there",nul_body,Approved',
        '1107160000000012347\u0000,ACMEIN,Service Implicit,Hello,nul_id,Approved',
        '1107160000000012348,ACMEIN,Service Implicit,Hello {#var#},nul_name\u0000,Approved',
        '1107160000000012349,ACMEIN,Service Implicit,Goodbye {#var#},after,Approved',
      ].join('\r\n')
      const r = await templatesImportDltCsv(db, orgId, csv, { createdBy: userId })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const byLine = Object.fromEntries(r.lines.map((l) => [l.line, l]))
      expect(byLine[2]).toMatchObject({ outcome: 'imported' })
      expect(byLine[3]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('The template text has a NUL character (U+0000)') })
      expect(byLine[4]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('The DLT template id has a NUL character') })
      expect(byLine[5]).toMatchObject({ outcome: 'refused', why: expect.stringContaining('The name has a NUL character') })
      expect(byLine[6]).toMatchObject({ outcome: 'imported' })
      expect(r).toMatchObject({ imported: 2, alreadyPresent: 0, skipped: 0, refused: 3 })
      const stored = await templatesList(db, orgId)
      expect(stored.map((t) => t.externalId).sort()).toEqual(['1107160000000012345', '1107160000000012349'])
      // Never stored with the NUL replaced: a template is the registered text exactly.
      expect(stored.some((t) => /[\u0000\ufffd]/.test(`${t.body}${t.externalId}${t.name ?? ''}`))).toBe(false)
      const [a] = await audits('template.imported')
      expect(a?.detail).toEqual({ channel: 'sms', imported: 2, alreadyPresent: 0, skipped: 0, refused: 3 })
    })
  })
})
