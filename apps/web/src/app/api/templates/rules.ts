import { z } from 'zod'
import { can, parseTemplate, type Principal, type TemplatePart } from '@agency/core'
import type { TemplateRefusal, TemplateRow } from '@agency/db/queries'

/**
 * The registered message templates' routes, the pure half (0019): who may
 * read and write them, what a request may carry, and what a stored row
 * looks like once it leaves the server.
 *
 * Kept beside the routes, with no `server-only` and no `@/` import, so
 * `apps/web/test/templates-routes.test.ts` runs the routes' OWN rules rather
 * than a copy of them.
 *
 * A template is a REGISTRATION: the words the DLT portal (SmartPing, for
 * this agency) holds for a header, under an id it issued. This product does
 * not register anything — the portal does — and it never edits a recorded
 * template in place, because a sent message names the words it was checked
 * against. A template that should stop being used is switched off.
 */

/**
 * Who may read and change the templates: whoever may read and change the
 * campaigns, because a template is the other half of what a campaign sends.
 * Every member today (`can()` has no viewer role); a role `can()` does not
 * know gets neither. Recording a template sends nothing — each SMS drafted
 * from one is still approved by a person, and the send path checks it again.
 */
export const TEMPLATES_READ = 'campaigns:read' as const
export const TEMPLATES_WRITE = 'campaigns:write' as const

export function mayReadTemplates(principal: Principal | null | undefined): boolean {
  return can(principal, TEMPLATES_READ)
}

export function mayWriteTemplates(principal: Principal | null | undefined): boolean {
  return can(principal, TEMPLATES_WRITE)
}

/** A JSON body to add or switch one template: a few kilobytes at most. */
export const TEMPLATE_MAX_REQUEST_BYTES = 16_384
/** A DLT export: one import takes up to a megabyte, as the contacts import does. */
export const TEMPLATE_IMPORT_MAX_BYTES = 1_000_000

/**
 * One template, as typed. The shape only — what makes it storable (a
 * six-character header, a category the channel has, a body whose `{#…#}`
 * kinds are known) is `templatesCreate`'s, which answers each with a
 * sentence. The bounds here are 0019's, so a body cannot be larger than a
 * row could hold.
 */
export const templateCreateSchema = z.object({
  channel: z.enum(['sms', 'whatsapp', 'voice'], 'Choose SMS, WhatsApp or voice.'),
  externalId: z.string().max(128, 'The template id is at most 128 characters.'),
  senderId: z.string().max(32, 'The header is at most 32 characters.'),
  category: z.string().max(60, 'The category is at most 60 characters.'),
  body: z.string().max(4000, 'The template text is at most 4,000 characters.'),
  name: z.string().max(200, 'The name is at most 200 characters.').nullish(),
  language: z.string().max(35, 'The language is at most 35 characters.').nullish(),
})
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>

export const templatePatchSchema = z.object({
  active: z.boolean('Say whether the template is on or off.'),
})

/** The status each of `templatesCreate`'s refusals is answered with. */
export const TEMPLATE_REFUSAL_STATUS: Readonly<Record<TemplateRefusal, number>> = {
  bad_channel: 400,
  bad_external_id: 400,
  bad_sender: 400,
  bad_category: 400,
  bad_body: 400,
  bad_name: 400,
  bad_language: 400,
  duplicate: 409,
}

/** A zod failure as one sentence for the person who pressed the button. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That request could not be read.'
}

/**
 * Bytes as UTF-8, or null when they are not. Strict: a byte sequence that
 * is not UTF-8 is refused rather than read with replacement characters, and
 * a template whose text came through a lossy decode would never match what
 * the operator compares it with — so it would never be delivered.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const NOT_UTF8 =
  'That file is not UTF-8, so some characters in it cannot be read, and a template whose text is not exactly what ' +
  'was registered is never delivered. Save it as "CSV UTF-8" (Excel lists it separately from plain CSV) and import ' +
  'it again.'

/** A template as it leaves the server: the row, dated, with its body read into text and slots. */
export interface TemplateView {
  readonly id: string
  readonly channel: string
  readonly externalId: string
  readonly senderId: string
  readonly category: string
  readonly name: string | null
  readonly language: string
  readonly body: string
  readonly active: boolean
  readonly createdAt: string
  /**
   * The body as literal text and `{#…#}` slots, in order — what the SMS
   * composer fills, and what the page highlights. Null when it does not
   * parse, which a stored row cannot do (`templatesCreate` refuses one).
   */
  readonly parts: readonly TemplatePart[] | null
  /** How many values a message drafted from it needs. */
  readonly slots: number
}

/** Every field named, never spread: `created_by` and the org stay on the server. */
export function templateView(row: TemplateRow): TemplateView {
  const parsed = parseTemplate(row.body)
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.externalId,
    senderId: row.senderId,
    category: row.category,
    name: row.name,
    language: row.language,
    body: row.body,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    parts: parsed.ok ? parsed.template.parts : null,
    slots: parsed.ok ? parsed.template.slots : 0,
  }
}
