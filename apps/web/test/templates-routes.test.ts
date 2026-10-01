/**
 * Settings → Templates and its three routes (0019), through their pure
 * halves: who may read and write, what a request may carry, the strict
 * UTF-8 read of an import, and what a stored row looks like once it leaves
 * the server. The routes themselves import `@/auth` and cannot be imported
 * here, so the last block reads their source to pin that each one asks the
 * gate before it reads anything.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PROMOTIONAL_WINDOW, SMS_TEMPLATE_CATEGORIES, WHATSAPP_TEMPLATE_CATEGORIES, templateCategoriesFor,
  type Role,
} from '@agency/core'
import type { TemplateRow } from '@agency/db/queries'
import {
  NOT_UTF8, TEMPLATES_READ, TEMPLATES_WRITE, TEMPLATE_IMPORT_MAX_BYTES, TEMPLATE_REFUSAL_STATUS, decodeUtf8,
  firstIssue, mayReadTemplates, mayWriteTemplates, templateCreateSchema, templatePatchSchema, templateView,
} from '../src/app/api/templates/rules'
import {
  CATEGORY_HINT, NOT_SENDABLE_NOTE, TEMPLATES_LEDE, TEMPLATE_CATEGORY_OPTIONS, bodySegments,
} from '../src/app/settings/templates/words'

const ORG = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
const as = (role: string) => ({ id: '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0002', orgId: ORG, role: role as Role })

describe('who may read and change the templates', () => {
  /** The capability that already gates campaign configuration: a template is the other half of what a campaign sends. */
  it('is the campaigns capability', () => {
    expect(TEMPLATES_READ).toBe('campaigns:read')
    expect(TEMPLATES_WRITE).toBe('campaigns:write')
  })

  it.each(['owner', 'member'])('lets an %s read and write', (role) => {
    expect(mayReadTemplates(as(role))).toBe(true)
    expect(mayWriteTemplates(as(role))).toBe(true)
  })

  /** `can()` fails closed: a role it does not know — a viewer, a typo — gets neither. */
  it.each(['viewer', 'admin ', 'Owner', ''])('refuses the unknown role %j', (role) => {
    expect(mayReadTemplates(as(role))).toBe(false)
    expect(mayWriteTemplates(as(role))).toBe(false)
  })

  it('refuses nobody signed in', () => {
    expect(mayReadTemplates(null)).toBe(false)
    expect(mayWriteTemplates(undefined)).toBe(false)
  })
})

describe('what a request may carry', () => {
  const valid = {
    channel: 'sms', externalId: '1107160000000012345', senderId: 'ACMEIN', category: 'service_explicit',
    body: 'Hi {#var#}, your review is ready. Reply STOP to opt out.',
  }

  it('reads one template, the name and language optional', () => {
    expect(templateCreateSchema.safeParse(valid).success).toBe(true)
    expect(templateCreateSchema.safeParse({ ...valid, name: null, language: 'en' }).success).toBe(true)
  })

  it('bounds every field at 0019’s limits, with a sentence', () => {
    const tooLong = templateCreateSchema.safeParse({ ...valid, body: 'x'.repeat(4001) })
    expect(tooLong.success).toBe(false)
    if (!tooLong.success) expect(firstIssue(tooLong.error)).toBe('The template text is at most 4,000 characters.')
    expect(templateCreateSchema.safeParse({ ...valid, externalId: '1'.repeat(129) }).success).toBe(false)
    expect(templateCreateSchema.safeParse({ ...valid, senderId: 'A'.repeat(33) }).success).toBe(false)
  })

  it('refuses a channel templates do not have', () => {
    const r = templateCreateSchema.safeParse({ ...valid, channel: 'email' })
    expect(r.success).toBe(false)
    if (!r.success) expect(firstIssue(r.error)).toBe('Choose SMS, WhatsApp or voice.')
  })

  it('switches a template with a boolean and nothing else', () => {
    expect(templatePatchSchema.safeParse({ active: false }).success).toBe(true)
    expect(templatePatchSchema.safeParse({ active: 'false' }).success).toBe(false)
    expect(templatePatchSchema.safeParse({}).success).toBe(false)
  })

  it('answers a duplicate 409 and every other refusal 400', () => {
    expect(TEMPLATE_REFUSAL_STATUS.duplicate).toBe(409)
    for (const [reason, status] of Object.entries(TEMPLATE_REFUSAL_STATUS)) {
      if (reason !== 'duplicate') expect(status, reason).toBe(400)
    }
  })
})

describe('an import is read as strict UTF-8', () => {
  it('reads UTF-8, Hindi included, and drops a leading byte-order mark', () => {
    const csv = 'Template ID,Header,Template Type,Template Content\n1107,ACMEIN,Service Explicit,नमस्ते {#var#}\n'
    expect(decodeUtf8(new TextEncoder().encode(csv))).toBe(csv)
    expect(decodeUtf8(new TextEncoder().encode(`\uFEFF${csv}`))).toBe(csv)
  })

  /** Excel's plain "CSV" is Windows-1252: `é` is the single byte 0xE9, which is not UTF-8. */
  it('refuses Windows-1252 rather than reading it with replacement characters', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('Template Content\nCaf'), 0xe9, 0x0a])
    expect(decodeUtf8(bytes)).toBeNull()
    expect(NOT_UTF8).toContain('Save it as "CSV UTF-8"')
  })

  it('takes up to a megabyte, as the contacts import does', () => {
    expect(TEMPLATE_IMPORT_MAX_BYTES).toBe(1_000_000)
  })
})

describe('a stored template, as it leaves the server', () => {
  const row: TemplateRow = {
    id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
    orgId: ORG,
    channel: 'sms',
    externalId: '1107160000000012345',
    senderId: 'ACMEIN',
    category: 'service_explicit',
    language: 'en',
    name: 'Review ready',
    body: 'Hi {#var#}, call {#cbn#}.',
    active: true,
    createdBy: '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0002',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  } as TemplateRow

  it('names its fields, reads the body into text and slots, and leaves the org and its author behind', () => {
    const v = templateView(row)
    expect(v).toEqual({
      id: row.id,
      channel: 'sms',
      externalId: '1107160000000012345',
      senderId: 'ACMEIN',
      category: 'service_explicit',
      name: 'Review ready',
      language: 'en',
      body: 'Hi {#var#}, call {#cbn#}.',
      active: true,
      createdAt: '2026-10-01T10:00:00.000Z',
      parts: [
        { kind: 'text', text: 'Hi ' },
        { kind: 'slot', variable: 'var' },
        { kind: 'text', text: ', call ' },
        { kind: 'slot', variable: 'cbn' },
        { kind: 'text', text: '.' },
      ],
      slots: 2,
    })
    expect(JSON.stringify(v)).not.toContain(ORG)
  })
})

describe('what the page says', () => {
  /** The form restates the categories (no core runtime in the browser); here they are held to core's. */
  it('offers exactly the categories core accepts per channel', () => {
    expect(TEMPLATE_CATEGORY_OPTIONS.sms).toEqual([...SMS_TEMPLATE_CATEGORIES])
    expect(TEMPLATE_CATEGORY_OPTIONS.voice).toEqual([...templateCategoriesFor('voice')])
    expect(TEMPLATE_CATEGORY_OPTIONS.whatsapp).toEqual([...WHATSAPP_TEMPLATE_CATEGORIES])
  })

  it('states the promotional band in TRAI’s words, as the send path holds it', () => {
    expect(CATEGORY_HINT.promotional).toContain(PROMOTIONAL_WINDOW.words)
  })

  it('says the registration happens on the portal, and this page only records it', () => {
    expect(TEMPLATES_LEDE).toContain('DLT portal (SmartPing)')
    expect(TEMPLATES_LEDE).toContain('this page only records what is registered there')
    expect(NOT_SENDABLE_NOTE.whatsapp).toContain('Sending WhatsApp is not available yet')
  })

  it('marks each {#…#} slot in the body, and leaves a look-alike as text', () => {
    expect(bodySegments('Hi {#var#}{#numeric#}, {# var #} ok')).toEqual([
      { slot: false, text: 'Hi ' },
      { slot: true, text: '{#var#}' },
      { slot: true, text: '{#numeric#}' },
      { slot: false, text: ', {# var #} ok' },
    ])
  })
})

describe('each route asks the gate before it reads anything', () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

  it.each([
    ['GET /api/templates', 'route.ts', 'GET', 'mayReadTemplates('],
    ['POST /api/templates', 'route.ts', 'POST', 'mayWriteTemplates('],
    ['PATCH /api/templates/[id]', '[id]/route.ts', 'PATCH', 'mayWriteTemplates('],
    ['POST /api/templates/import', 'import/route.ts', 'POST', 'mayWriteTemplates('],
  ])('%s', (_label, file, method, gate) => {
    const src = read(`../src/app/api/templates/${file}`)
    const handler = src.slice(src.indexOf(`export async function ${method}(`))
    const next = handler.indexOf('export async function', 1)
    const body = next === -1 ? handler : handler.slice(0, next)
    expect(body).toContain(gate)
    expect(body.indexOf(gate)).toBeLessThan(Math.max(body.indexOf('request.'), body.indexOf('context.params')))
    expect(body).toMatch(/status: 403/)
  })

  it('the import decodes strictly and bounds the body before it reads it', () => {
    const src = read('../src/app/api/templates/import/route.ts')
    expect(src).toContain('decodeUtf8(bytes)')
    expect(src.indexOf("request.headers.get('content-length')")).toBeLessThan(src.indexOf('request.arrayBuffer()'))
  })
})
