/**
 * The registered message templates (0019): list, create, switch on and off,
 * and import from a DLT portal's CSV export.
 *
 * A row is a REGISTRATION — the words a regulator or a platform has on file
 * for this sender — so it is written by a person, from the portal, and never
 * by a model. Nothing here sends anything; an SMS is drafted from a template
 * by `smsDraft` (sms.ts) and goes through the one send path like every other
 * message.
 *
 * A template is never edited in place. DLT issues a NEW template id when a
 * registered body changes, and a sent message's `template_id` names the
 * words it was checked against (RESTRICT), so changing them under it would
 * make "it matched its template" a claim about words nobody sent. A template
 * that should stop being used is deactivated.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import {
  normaliseDltHeader, parseTemplate, parseTemplateCategory,
  type TemplateCategory, type TemplateChannel,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export type TemplateRow = typeof schema.messageTemplates.$inferSelect

/** The channels a template can be for — 0019's CHECK. */
export const TEMPLATE_CHANNEL_LIST = ['sms', 'whatsapp', 'voice'] as const satisfies readonly TemplateChannel[]

/** 0019's bounds, restated so a refusal is a sentence rather than a CHECK violation. */
const MAX_BODY = 4000
const MAX_NAME = 200
const MAX_EXTERNAL_ID = 128
const MAX_SENDER = 32
const MAX_LANGUAGE = 35

/** An org's templates: by channel, active first, newest first. */
export async function templatesList(
  db: AgencyDb,
  orgId: string,
  opts: { readonly channel?: TemplateChannel; readonly activeOnly?: boolean } = {},
): Promise<TemplateRow[]> {
  return db
    .select()
    .from(schema.messageTemplates)
    .where(
      and(
        eq(schema.messageTemplates.orgId, orgId),
        opts.channel ? eq(schema.messageTemplates.channel, opts.channel) : undefined,
        opts.activeOnly ? eq(schema.messageTemplates.active, true) : undefined,
      ),
    )
    .orderBy(
      asc(schema.messageTemplates.channel),
      desc(schema.messageTemplates.active),
      desc(schema.messageTemplates.createdAt),
    )
}

export interface TemplateInput {
  readonly channel: TemplateChannel
  readonly externalId: string
  readonly senderId: string
  /** As typed or exported: folded by `parseTemplateCategory`. */
  readonly category: string
  readonly body: string
  readonly name?: string | null
  readonly language?: string | null
  /** A users.id in this org, or null for an import nobody signed. */
  readonly createdBy?: string | null
}

export type TemplateRefusal =
  | 'bad_channel'
  | 'bad_external_id'
  | 'bad_sender'
  | 'bad_category'
  | 'bad_body'
  | 'bad_language'
  | 'duplicate'

/** A template as it would be stored, or the one sentence that says why it cannot be. */
type Checked =
  | {
      readonly ok: true
      readonly row: {
        channel: TemplateChannel
        externalId: string
        senderId: string
        category: TemplateCategory
        body: string
        name: string | null
        language: string
      }
    }
  | { readonly ok: false; readonly reason: TemplateRefusal; readonly message: string }

/**
 * Read a template the way 0019 will store it: the header upper-cased, the
 * category folded, the body parsed (a `{#…#}` kind this system does not know
 * is refused — rendering from it could only fail the operator's scrub). Each
 * refusal names what to fix, because a template that will not store is a
 * message that cannot be drafted.
 */
function checkTemplate(input: TemplateInput): Checked {
  const channel = input.channel
  if (!(TEMPLATE_CHANNEL_LIST as readonly string[]).includes(channel)) {
    return { ok: false, reason: 'bad_channel', message: `"${String(channel)}" is not a template channel (sms, whatsapp or voice).` }
  }
  const externalId = input.externalId.trim()
  if (!externalId || /\s/.test(externalId) || externalId.length > MAX_EXTERNAL_ID) {
    return {
      ok: false,
      reason: 'bad_external_id',
      message:
        channel === 'whatsapp'
          ? 'The template name is missing, has a space in it, or is too long.'
          : 'The DLT template id is missing, has a space in it, or is too long.',
    }
  }
  // A spreadsheet that read a 19-digit id as a number writes it back as
  // 1.10716E+18 — a different id, which the operator would reject.
  if (/^\d(?:\.\d+)?e\+?\d+$/i.test(externalId)) {
    return {
      ok: false,
      reason: 'bad_external_id',
      message: `The template id reads "${externalId}", which is a spreadsheet's rounding of a long number. Export the id column as text.`,
    }
  }
  let senderId: string
  if (channel === 'sms') {
    const header = normaliseDltHeader(input.senderId)
    if (!header) {
      return {
        ok: false,
        reason: 'bad_sender',
        message: 'A DLT header is six letters or digits, like ACMEIN — the sender id the DLT portal issued.',
      }
    }
    senderId = header
  } else {
    senderId = input.senderId.trim()
    if (!senderId || senderId.length > MAX_SENDER) {
      return { ok: false, reason: 'bad_sender', message: 'The sender is missing or too long.' }
    }
  }
  const category = parseTemplateCategory(input.category, channel)
  if (!category) {
    return {
      ok: false,
      reason: 'bad_category',
      message:
        channel === 'whatsapp'
          ? `"${input.category.trim()}" is not a WhatsApp category: marketing, utility or authentication.`
          : `"${input.category.trim()}" is not a DLT category: promotional, transactional, service implicit or service explicit.`,
    }
  }
  const body = input.body
  if (!body.trim() || body.length > MAX_BODY) {
    return { ok: false, reason: 'bad_body', message: `The template text is missing or longer than ${MAX_BODY} characters.` }
  }
  const parsed = parseTemplate(body)
  if (!parsed.ok) return { ok: false, reason: 'bad_body', message: parsed.message }
  const language = (input.language ?? '').trim() || 'en'
  if (language.length > MAX_LANGUAGE) {
    return { ok: false, reason: 'bad_language', message: 'The language is longer than a language tag can be.' }
  }
  const name = (input.name ?? '').trim().slice(0, MAX_NAME) || null
  return { ok: true, row: { channel, externalId, senderId, category, body, name, language } }
}

/**
 * Record one template. Refused, with a sentence, when it would not store or
 * when this org already has one with that id on that channel — a DLT id
 * names one registered body, and a second row for it would be a second
 * claim about what was registered.
 */
export async function templatesCreate(
  db: AgencyDb,
  orgId: string,
  input: TemplateInput,
): Promise<{ readonly ok: true; readonly template: TemplateRow } | { readonly ok: false; readonly reason: TemplateRefusal; readonly message: string }> {
  const checked = checkTemplate(input)
  if (!checked.ok) return checked
  const [row] = await db
    .insert(schema.messageTemplates)
    .values({ orgId, ...checked.row, createdBy: input.createdBy ?? null })
    .onConflictDoNothing({
      target: [schema.messageTemplates.orgId, schema.messageTemplates.channel, schema.messageTemplates.externalId],
    })
    .returning()
  if (!row) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `A ${checked.row.channel} template with the id ${checked.row.externalId} is already recorded. Deactivate it, or use the new id the portal issued.`,
    }
  }
  await appendAudit(db, {
    orgId,
    actor: input.createdBy ?? 'system',
    action: 'template.created',
    subjectType: 'message_template',
    subjectId: row.id,
    // The registration's ids and kind. Not the body: it is the agency's own
    // wording, but an audit row is read by more people than need it.
    detail: { channel: row.channel, category: row.category, externalId: row.externalId },
  }).catch(() => {})
  return { ok: true, template: row }
}

/**
 * Switch a template on or off. Deactivating is how a template stops being
 * used: a draft already written from it is refused `no_template` at sending,
 * and nothing new can be drafted from it. Idempotent — a template already in
 * the asked state is returned unchanged, and nothing is audited.
 */
export async function templatesSetActive(
  db: AgencyDb,
  args: { readonly orgId: string; readonly templateId: string; readonly active: boolean; readonly actor: string },
): Promise<{ readonly ok: true; readonly template: TemplateRow; readonly changed: boolean } | { readonly ok: false; readonly reason: 'not_found' }> {
  const [changed] = await db
    .update(schema.messageTemplates)
    .set({ active: args.active })
    .where(
      and(
        eq(schema.messageTemplates.id, args.templateId),
        eq(schema.messageTemplates.orgId, args.orgId),
        eq(schema.messageTemplates.active, !args.active),
      ),
    )
    .returning()
  if (changed) {
    await appendAudit(db, {
      orgId: args.orgId,
      actor: args.actor,
      action: args.active ? 'template.activated' : 'template.deactivated',
      subjectType: 'message_template',
      subjectId: changed.id,
      detail: { channel: changed.channel, externalId: changed.externalId },
    }).catch(() => {})
    return { ok: true, template: changed, changed: true }
  }
  const [current] = await db
    .select()
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.id, args.templateId), eq(schema.messageTemplates.orgId, args.orgId)))
    .limit(1)
  return current ? { ok: true, template: current, changed: false } : { ok: false, reason: 'not_found' }
}

// ---------------------------------------------------------------------------
// The DLT portal's CSV export
// ---------------------------------------------------------------------------

/**
 * The column names a DLT export uses, per field, as they are matched: the
 * header cell lower-cased with every space, hyphen, underscore and dot taken
 * out, so `Template ID`, `TEMPLATE_ID` and `template_id` are all
 * `templateid`. The SmartPing portal's exact columns are not public, so the
 * list holds the common spellings across the DLT portals:
 *
 *   externalId  Template ID · TEMPLATE_ID · template_id · DLT Template ID ·
 *               Content Template ID · CT ID
 *   senderId    Header · Sender ID · SenderID · Header Name · Headers · Sender
 *   category    Template Type · Category · Content Type · Template Category · Type
 *   body        Template Content · Content · Message · Template Message ·
 *               Template Text · Body
 *   name        Template Name · Name                       (optional)
 *   status      Status · Template Status · Approval Status (optional)
 *
 * A new spelling is ONE string in its field's list. The first alias in a
 * list that the header has wins, so a file with both `Template Content` and
 * `Content` reads the first.
 */
const DLT_COLUMN_ALIASES = {
  externalId: ['templateid', 'dlttemplateid', 'contenttemplateid', 'ctid'],
  senderId: ['header', 'senderid', 'headername', 'headers', 'sender'],
  category: ['templatetype', 'category', 'contenttype', 'templatecategory', 'type'],
  body: ['templatecontent', 'content', 'message', 'templatemessage', 'templatetext', 'body'],
  name: ['templatename', 'name'],
  status: ['status', 'templatestatus', 'approvalstatus'],
} as const

type DltField = keyof typeof DLT_COLUMN_ALIASES
const REQUIRED_FIELDS: readonly DltField[] = ['externalId', 'senderId', 'category', 'body']

/** The statuses a portal gives a template that may be sent from. Anything else is skipped. */
const SENDABLE_STATUS = new Set(['approved', 'active', 'approve'])

const columnKey = (raw: string): string => raw.trim().toLowerCase().replace(/[\s\-_.]+/g, '')

export interface TemplateImportLine {
  /** The line the record starts on, counting from 1 at the header. */
  readonly line: number
  readonly externalId: string | null
  readonly outcome: 'imported' | 'already_present' | 'skipped' | 'refused'
  /** Why, for everything but a plain import — and a note when one was made (several headers). */
  readonly why?: string
}

export type TemplateImportResult =
  | {
      readonly ok: true
      readonly lines: readonly TemplateImportLine[]
      readonly imported: number
      readonly alreadyPresent: number
      readonly skipped: number
      readonly refused: number
    }
  | { readonly ok: false; readonly message: string }

/**
 * Import a DLT portal's template export as SMS templates.
 *
 * Every line ends in exactly one of: imported, already present (the same id
 * with the same header, category and text), skipped (not approved on the
 * portal, or a repeat of an earlier line), or refused with the sentence
 * that says why. Idempotent: a re-import of the same file imports nothing
 * and refuses nothing it imported the first time. An id already stored with
 * DIFFERENT words is refused, never overwritten — the portal issues a new
 * id when a body changes, and a sent message names the words it was checked
 * against.
 *
 * The file is refused whole when it is not readable as one: no header, a
 * required column missing, a quoted value never closed, or text that was
 * not UTF-8 (a body that came through a lossy decode would never match the
 * message the operator compares it with).
 */
export async function templatesImportDltCsv(
  db: AgencyDb,
  orgId: string,
  csvText: string,
  opts: { readonly createdBy?: string | null } = {},
): Promise<TemplateImportResult> {
  if (csvText.includes('�')) {
    return {
      ok: false,
      message:
        'This file was not UTF-8, so some characters were lost reading it, and a template whose text is not exactly ' +
        'what was registered would never be delivered. Save it as CSV UTF-8 and import it again.',
    }
  }
  let records: { line: number; cells: string[] }[]
  try {
    records = readCsv(csvText)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'The file could not be read as CSV.' }
  }
  const head = records[0]
  if (!head) return { ok: false, message: 'The file is empty. Export the approved templates from the DLT portal as CSV.' }

  const keys = head.cells.map(columnKey)
  const at: Partial<Record<DltField, number>> = {}
  for (const field of Object.keys(DLT_COLUMN_ALIASES) as DltField[]) {
    for (const alias of DLT_COLUMN_ALIASES[field]) {
      const pos = keys.indexOf(alias)
      if (pos !== -1) {
        at[field] = pos
        break
      }
    }
  }
  const missing = REQUIRED_FIELDS.filter((f) => at[f] === undefined)
  if (missing.length > 0) {
    const names: Record<DltField, string> = {
      externalId: 'a template id (Template ID)',
      senderId: 'a header (Header, or Sender ID)',
      category: 'a category (Template Type, or Category)',
      body: 'the text (Template Content, Content, or Message)',
      name: 'a name',
      status: 'a status',
    }
    return {
      ok: false,
      message: `The header has no column for ${missing.map((f) => names[f]).join(', ')}. The first line must name them.`,
    }
  }

  const existing = new Map(
    (await templatesList(db, orgId, { channel: 'sms' })).map((t) => [t.externalId, t] as const),
  )
  const seen = new Set<string>()
  const lines: TemplateImportLine[] = []
  const width = head.cells.length

  for (const record of records.slice(1)) {
    const cell = (f: DltField): string => {
      const pos = at[f]
      return pos === undefined ? '' : (record.cells[pos] ?? '').trim()
    }
    const rawId = cell('externalId') || null
    const out = (outcome: TemplateImportLine['outcome'], why?: string): void => {
      lines.push({ line: record.line, externalId: rawId, outcome, ...(why ? { why } : {}) })
    }
    if (record.cells.length !== width) {
      out(
        'refused',
        `This line has ${record.cells.length} values where the header names ${width}. A value containing a comma must be in double quotes.`,
      )
      continue
    }
    const status = cell('status').toLowerCase()
    if (at.status !== undefined && !SENDABLE_STATUS.has(status)) {
      out('skipped', `Its status on the portal is "${cell('status') || 'blank'}"; only approved templates are imported.`)
      continue
    }

    // A template can be linked to several headers on the portal. One row per
    // template id, so the first readable header is stored and the line says so.
    const headers = cell('senderId').split(/[\s,;|/]+/).filter(Boolean)
    const firstHeader = headers.map((h) => normaliseDltHeader(h)).find((h): h is string => h !== null)
    const checked = checkTemplate({
      channel: 'sms',
      externalId: rawId ?? '',
      senderId: firstHeader ?? cell('senderId'),
      category: cell('category'),
      // The body keeps its own spacing: the operator compares it exactly.
      body: at.body === undefined ? '' : (record.cells[at.body] ?? ''),
      name: cell('name') || null,
    })
    if (!checked.ok) {
      out('refused', checked.message)
      continue
    }
    const row = checked.row
    if (seen.has(row.externalId)) {
      out('skipped', 'The same template id appears on an earlier line of this file.')
      continue
    }
    seen.add(row.externalId)

    const stored = existing.get(row.externalId)
    if (stored) {
      const same = stored.body === row.body && stored.senderId === row.senderId && stored.category === row.category
      if (same) out('already_present')
      else {
        out(
          'refused',
          'A template with this id is already recorded with a different header, category or text. The portal issues a new id when a template changes, so check the export; the stored one was left as it was.',
        )
      }
      continue
    }

    const [inserted] = await db
      .insert(schema.messageTemplates)
      .values({ orgId, ...row, createdBy: opts.createdBy ?? null })
      .onConflictDoNothing({
        target: [schema.messageTemplates.orgId, schema.messageTemplates.channel, schema.messageTemplates.externalId],
      })
      .returning({ id: schema.messageTemplates.id })
    if (!inserted) {
      // Another import recorded it a moment ago.
      out('already_present')
      continue
    }
    out(
      'imported',
      headers.length > 1 ? `Linked to ${headers.length} headers on the portal; stored with the first, ${row.senderId}.` : undefined,
    )
  }

  const count = (o: TemplateImportLine['outcome']): number => lines.filter((l) => l.outcome === o).length
  const result = {
    ok: true as const,
    lines,
    imported: count('imported'),
    alreadyPresent: count('already_present'),
    skipped: count('skipped'),
    refused: count('refused'),
  }
  await appendAudit(db, {
    orgId,
    actor: opts.createdBy ?? 'system',
    action: 'template.imported',
    subjectType: null,
    subjectId: null,
    detail: {
      channel: 'sms',
      imported: result.imported,
      alreadyPresent: result.alreadyPresent,
      skipped: result.skipped,
      refused: result.refused,
    },
  }).catch(() => {})
  return result
}

/**
 * RFC 4180 records with the line each starts on. A field is quoted when it
 * holds a comma, a quote or a line break, and a quote inside one is doubled;
 * a line break inside a quoted field is kept as `\n`. CRLF or LF ends a
 * record, a leading byte-order mark is dropped, and a line that is blank
 * where a record would begin is skipped. A quoted field that never closes
 * is refused rather than read to the end of the file.
 */
function readCsv(csv: string): { line: number; cells: string[] }[] {
  const text = csv.replace(/^﻿/, '')
  const out: { line: number; cells: string[] }[] = []
  const n = text.length
  let i = 0
  let line = 1
  const pastBreak = (k: number): number => (text[k] === '\r' && text[k + 1] === '\n' ? k + 2 : k + 1)

  while (i < n) {
    let eol = i
    while (eol < n && text[eol] !== '\n' && text[eol] !== '\r') eol += 1
    if (!text.slice(i, eol).trim()) {
      i = eol < n ? pastBreak(eol) : n
      line += 1
      continue
    }
    const startLine = line
    const cells: string[] = []
    let cell = ''
    let quoted = false
    for (;;) {
      if (i >= n) {
        if (quoted) {
          throw new Error(`The quoted value that starts on line ${startLine} is never closed. Close the quote and import again.`)
        }
        cells.push(cell)
        break
      }
      const ch = text[i] as string
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"'
            i += 2
          } else {
            quoted = false
            i += 1
          }
        } else if (ch === '\r' || ch === '\n') {
          cell += '\n'
          i = pastBreak(i)
          line += 1
        } else {
          cell += ch
          i += 1
        }
        continue
      }
      if (ch === '"' && cell.trim() === '') {
        quoted = true
        cell = ''
        i += 1
      } else if (ch === ',') {
        cells.push(cell)
        cell = ''
        i += 1
      } else if (ch === '\r' || ch === '\n') {
        cells.push(cell)
        i = pastBreak(i)
        line += 1
        break
      } else {
        cell += ch
        i += 1
      }
    }
    out.push({ line: startLine, cells })
  }
  return out
}
