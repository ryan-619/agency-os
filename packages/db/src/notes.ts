/**
 * Notes on a company (0018): a teammate's words, kept apart from evidence.
 *
 * §2.2 says the app must never state a finding it did not observe, and a note
 * is the easiest way to break that without noticing — "they have no CSP" typed
 * after a call reads exactly like a finding once it is on the same page. So a
 * note is always rendered as somebody's words ("note by <name>, <when>"), is
 * never quoted as evidence, and nothing that writes a proposal or a brief may
 * read this table. `packages/core/test/documents-never-read-notes.test.ts`
 * reads those modules' source to hold that line.
 *
 * §2.3: the body is never written to the audit log or a log line. Audit rows
 * carry ids only — a note can hold anything a person typed after a call.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isCheckViolation, isForeignKeyViolation } from './pg-errors.js'

export type NoteRow = typeof schema.notes.$inferSelect

/**
 * 0018's `notes_body_is_bounded`. Postgres's `length()` counts CHARACTERS,
 * and JavaScript's `.length` counts UTF-16 units, so the check before the
 * insert counts code points — otherwise a note of 5,000 emoji is refused here
 * as 10,000 long while the database would have stored it.
 */
export const NOTE_MAX_CHARS = 8000

/** A note with the names a page needs to say whose words they are. */
export interface NoteView extends NoteRow {
  readonly authorName: string | null
  readonly authorEmail: string | null
  /** The contact the note is about, when it is about one. */
  readonly contactName: string | null
}

export type NotesAddResult =
  | { ok: true; note: NoteRow }
  | { ok: false; reason: 'blank' | 'too_long' | 'not_found'; message: string }

const BLANK_MESSAGE = 'A note needs some words in it.'
const tooLongMessage = (n: number): string =>
  `A note is at most ${NOTE_MAX_CHARS.toLocaleString('en-US')} characters; this one is ${n.toLocaleString('en-US')}.`

/** Characters as Postgres counts them. */
function charCount(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/**
 * Add a note to a company, optionally about one of its contacts.
 *
 * Blank and over-long bodies are refused BEFORE the insert, with a sentence;
 * the CHECKs are the backstop and are mapped to the same answers, so a caller
 * never sees a constraint name. The contact has to be at this company — a
 * note filed under one company about somebody at another is the same class
 * of mistake as a finding filed under the wrong name.
 */
export async function notesAdd(
  db: AgencyDb,
  input: {
    readonly orgId: string
    readonly companyId: string
    readonly contactId?: string | null
    readonly authorUserId: string
    readonly body: string
  },
): Promise<NotesAddResult> {
  const body = input.body.trim()
  if (body === '') return { ok: false, reason: 'blank', message: BLANK_MESSAGE }
  const n = charCount(body)
  if (n > NOTE_MAX_CHARS) return { ok: false, reason: 'too_long', message: tooLongMessage(n) }

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, input.orgId), eq(schema.companies.id, input.companyId)))
    .limit(1)
  if (company.length === 0) return { ok: false, reason: 'not_found', message: 'That company is not in the CRM.' }

  const contactId = input.contactId ?? null
  if (contactId) {
    const contact = await db
      .select({ companyId: schema.contacts.companyId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, input.orgId), eq(schema.contacts.id, contactId)))
      .limit(1)
    if (contact.length === 0 || contact[0]!.companyId !== input.companyId) {
      return { ok: false, reason: 'not_found', message: 'That person is not a contact at this company.' }
    }
  }

  let note: NoteRow | undefined
  try {
    const rows = await db
      .insert(schema.notes)
      .values({ orgId: input.orgId, companyId: input.companyId, contactId, authorUserId: input.authorUserId, body })
      .returning()
    note = rows[0]
  } catch (err) {
    if (isCheckViolation(err, 'notes_body_is_not_blank')) return { ok: false, reason: 'blank', message: BLANK_MESSAGE }
    if (isCheckViolation(err, 'notes_body_is_bounded')) return { ok: false, reason: 'too_long', message: tooLongMessage(n) }
    // The same-org keys (0018): an author or a contact from another org is
    // unstorable. Answered as "not found", because the id is the only thing
    // that crossed the boundary.
    if (isForeignKeyViolation(err)) {
      return { ok: false, reason: 'not_found', message: 'That person is not on this team.' }
    }
    throw err
  }
  if (!note) throw new Error('note insert returned no row')

  await appendAudit(db, {
    orgId: input.orgId,
    actor: input.authorUserId,
    action: 'note.added',
    subjectType: 'note',
    subjectId: note.id,
    // Ids only. The body is a person's words and never goes in the log.
    detail: { companyId: input.companyId, noteId: note.id, ...(contactId ? { contactId } : {}) },
  })
  return { ok: true, note }
}

/**
 * A company's notes, pinned first and then newest first, with the author's
 * name. Scoped by org as well as company, so another org's company id reads
 * as a company with no notes rather than as somebody else's.
 */
export async function notesFor(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  limit = 50,
): Promise<NoteView[]> {
  const rows = await db
    .select({
      note: schema.notes,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
      contactEmail: schema.contacts.email,
    })
    .from(schema.notes)
    .leftJoin(schema.users, and(eq(schema.users.id, schema.notes.authorUserId), eq(schema.users.orgId, schema.notes.orgId)))
    .leftJoin(schema.contacts, and(eq(schema.contacts.id, schema.notes.contactId), eq(schema.contacts.orgId, schema.notes.orgId)))
    .where(and(eq(schema.notes.orgId, orgId), eq(schema.notes.companyId, companyId)))
    .orderBy(desc(schema.notes.pinned), desc(schema.notes.createdAt), desc(schema.notes.id))
    .limit(Math.max(1, Math.min(200, Math.floor(limit))))
  return rows.map((r) => ({
    ...r.note,
    authorName: r.authorName,
    authorEmail: r.authorEmail,
    contactName: r.note.contactId
      ? [r.contactFirst, r.contactLast].filter(Boolean).join(' ') || r.contactEmail || 'a contact'
      : null,
  }))
}

/**
 * Whose words these are, as a page or a tool should print it: "note by
 * <this>". A name when the teammate has one, their address when not.
 */
export function notesAuthorLabel(note: { readonly authorName: string | null; readonly authorEmail: string | null }): string {
  return note.authorName?.trim() || note.authorEmail || 'a former teammate'
}

/** Pin a note to the top of its company's list, or unpin it. */
export async function notesPin(
  db: AgencyDb,
  orgId: string,
  id: string,
  pinned: boolean,
): Promise<{ ok: true; note: NoteRow } | { ok: false; reason: 'not_found'; message: string }> {
  const rows = await db
    .update(schema.notes)
    .set({ pinned })
    .where(and(eq(schema.notes.orgId, orgId), eq(schema.notes.id, id)))
    .returning()
  const note = rows[0]
  if (!note) return { ok: false, reason: 'not_found', message: 'No such note.' }
  return { ok: true, note }
}

/**
 * Delete a note — by its author, or by an owner.
 *
 * One DELETE whose predicate carries the permission, so there is no window
 * between checking who wrote it and removing it. When nothing matched, one
 * read tells "there is no such note" apart from "it is somebody else's".
 */
export async function notesDelete(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly byUserId: string; readonly isOwner: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_permitted'; message: string }> {
  const mayDelete = args.isOwner ? sql`true` : eq(schema.notes.authorUserId, args.byUserId)
  const rows = await db
    .delete(schema.notes)
    .where(and(eq(schema.notes.orgId, args.orgId), eq(schema.notes.id, args.id), mayDelete))
    .returning({ id: schema.notes.id, companyId: schema.notes.companyId, authorUserId: schema.notes.authorUserId })
  const gone = rows[0]
  if (!gone) {
    const exists = await db
      .select({ id: schema.notes.id })
      .from(schema.notes)
      .where(and(eq(schema.notes.orgId, args.orgId), eq(schema.notes.id, args.id)))
      .limit(1)
    return exists.length === 0
      ? { ok: false, reason: 'not_found', message: 'No such note.' }
      : { ok: false, reason: 'not_permitted', message: 'Only the person who wrote a note, or an owner, can delete it.' }
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.byUserId,
    action: 'note.deleted',
    subjectType: 'note',
    subjectId: gone.id,
    detail: { companyId: gone.companyId, noteId: gone.id, authorUserId: gone.authorUserId },
  })
  return { ok: true }
}
