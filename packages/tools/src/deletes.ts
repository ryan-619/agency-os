/**
 * The delete tools (2026-10-15): what chat removes when a person asks it to —
 * above all the records the assistant itself invented before 0029, people
 * who do not exist and cafés filed under a dead `business.site` domain, and
 * the meetings and tasks it made for them.
 *
 * Every one is carded (`deletes_records`, `high`): a delete cannot be undone,
 * so a person approves the call before anything is removed, and a turn
 * nobody watches (the morning brief) is declined at once. Each goes through
 * the writer the web's Delete calls (`contactDelete`, `companyDelete`,
 * `meetingDelete`, `taskDelete` in packages/db/src/deletes.ts) with the actor
 * `agent`, so the agent's delete and a person's remove the same rows, refuse
 * for the same reasons in the same sentences, and leave the same audit row.
 * Each tool asks `can()` what its route asks: `contacts:write` for people,
 * an owner's `users:write` for companies, `deals:write` for a meeting or a
 * task.
 *
 * The card shows only what the model typed, so every item carries, beside
 * its id, what a person checks — a contact's name and email domain, a
 * company's domain, a meeting's company, a task's title — and the handler
 * compares it with the stored row before it deletes. An item that does not
 * match is KEPT and said so: the person approved deleting what the card
 * named, not whatever the id happens to point at.
 *
 * What reaches the model: names, a company's domain, counts and the writer's
 * own sentence. Never an address or a number — a booking-page lead, whose
 * `.inbound` domain is a person's address, is called "a booking-page lead".
 * The `agent.*` rows carry ids and counts; `why` is on the approval card the
 * person read, and is audited nowhere else.
 */
import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { can, isNoSiteDomain } from '@agency/core'
import { companyDelete, contactDelete, meetingDelete, readMeetingWithCompany, taskDelete } from '@agency/db'
import * as schema from '@agency/db/schema'
import { normaliseDomain } from '@agency/scanner'
import { TOOL_TEXT_BUDGET, TOOL_TIME_BUDGET_MS, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

const NOTHING_SENT = 'Nothing was sent.'
const NOTHING_DELETED = 'Nothing was deleted.'

/** At most this many people in one call — one card a person can still read item by item. */
export const DELETE_PER_CALL = 25

/**
 * At most this many companies in one call (review, 2026-10-15). Each costs
 * about thirty round trips — its people, the company, the rows that decide
 * it, its drafts, its counts — and the worker on the operator's Mac reaches
 * the database in another continent at about 200 ms a trip: twenty-five took
 * over two minutes, against the MCP call's 30 s.
 */
export const DELETE_COMPANIES_PER_CALL = 5

/**
 * The most people a company may have for delete_companies to start it
 * (review, 2026-10-15). A company's delete costs about two dozen round trips
 * whatever its size, and about one more per person — the shared-number
 * question `contactKeepReasons` asks of each person nothing else keeps. At
 * about 200 ms a trip from the operator's Mac, a company started just inside
 * `DELETE_BUDGET_MS` (20 s) has 10 s before the MCP call's 30 s: fifteen
 * people make it about 37 trips, 7.4 s, finishing near 27.5 s with room for
 * the audit row and the answer. Fifty ran to about 35 s. A bigger one is
 * kept, and deleted on its company page, which this call's clock does not
 * bind.
 */
export const DELETE_COMPANY_PEOPLE_MAX = 15

/**
 * A delete call stops STARTING items here — the one in hand finishes, in its
 * own transaction — leaving the rest of the tool's budget for the audit row
 * and the answer, as enrol_contacts stops drafting (review round 16). Cut
 * off at 30 s, the model was told the delete failed while every record went,
 * and it said so to the person and asked for a second card.
 */
export const DELETE_BUDGET_MS = TOOL_TIME_BUDGET_MS - 5_000

/**
 * What a company delete's answer says will keep it out — exactly what the
 * keys match, and no more (review, 2026-10-15): a business with no website is
 * known only by the placeholder it was filed under, so the same café filed
 * again another way comes back, and the model must not be told it cannot.
 */
export const DELETED_NOT_FILED_AGAIN =
  'Neither the night shift nor add_company, import_companies, add_businesses or scan_company files a deleted ' +
  'company again by its domain or its Google place id. A business with no website is known only by the ' +
  'placeholder it was filed under: found on Google Maps again, by its place id; through add_company, only with ' +
  'the same name, city and address as before. Another spelling, an address given once and left out the next ' +
  'time, or a Google listing for one first filed by name is not recognised, so check search_crm before filing ' +
  'one again. A person can add one with a website back on /companies. An audit page or preview link already ' +
  'sent for one stops opening.'

/** What the answer says of the items a call did not reach before its time ran out. */
const OUT_OF_TIME = 'Not deleted — the time for this call ran out; call again for these:'

/**
 * A delete call's answer, in an order no cut can lose (review, 2026-10-15):
 * the headline and the items not reached FIRST — the ids the model must ask
 * for again, each on one short line — then each item's line, cut to the room
 * the head and the closing lines leave, then the closing lines. Through
 * `bounded`, which cuts from the tail, twenty-five long names lost seven of
 * the not-reached ids and the closing "Nothing was sent".
 */
function answerText(head: readonly string[], items: readonly string[], tail: readonly string[]): string {
  const size = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0)
  const note = (n: number): string =>
    `  … ${n} more ${n === 1 ? 'line' : 'lines'} cut to fit; the headline counts every item.`
  let room = TOOL_TEXT_BUDGET - size(head) - size(tail) - note(items.length).length - 1
  const shown: string[] = []
  for (const line of items) {
    if (line.length + 1 > room) break
    shown.push(line)
    room -= line.length + 1
  }
  const cut = items.length - shown.length
  return [...head, ...shown, ...(cut > 0 ? [note(cut)] : []), ...tail].join('\n')
}

/** The not-reached block: the sentence, then one line per item — its id first, and a short name. */
function notReachedLines(items: readonly { readonly id: string; readonly name: string }[]): string[] {
  if (items.length === 0) return []
  return [`  ${OUT_OF_TIME}`, ...items.map((n) => `    id ${n.id}${n.name ? ` — ${oneLine(n.name, 40)}` : ''}`)]
}

/** The model's ids, as the database prints them, each once (review, 2026-10-15). */
function eachOnce<T>(items: readonly T[], idOf: (item: T) => string, withId: (item: T, id: string) => T): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    // `z.uuid()` takes capitals, and the rows come back lower-cased: looked up
    // as typed, an existing person or company was "no such … — it may already
    // have been deleted", and the model told the person it was gone.
    const id = idOf(item).toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(withId(item, id))
  }
  return out
}

/** The clock and the budget a delete call runs on; a test passes its own. */
export interface DeleteToolOptions {
  /** How long a call may go on starting items. Defaults to `DELETE_BUDGET_MS`. */
  readonly budgetMs?: number
  /** Milliseconds, as `Date.now` reads them. */
  readonly clock?: () => number
}

/** Whether a call that started at `startedAt` may start another item. */
function timeLeft(opts: DeleteToolOptions): () => boolean {
  const clock = opts.clock ?? Date.now
  const budgetMs = opts.budgetMs ?? DELETE_BUDGET_MS
  const startedAt = clock()
  return () => clock() - startedAt < budgetMs
}

/** "Deleted 1 of 5 contacts; 1 kept, each with why; 3 not reached:" — the parts that are not zero. */
function headline(deleted: number, asked: string, kept: number, notReached: number): string {
  return (
    `Deleted ${deleted} of ${asked}` +
    (kept > 0 ? `; ${kept} kept, each with why` : '') +
    (notReached > 0 ? `; ${notReached} not reached` : '') +
    ':'
  )
}

/**
 * Text from a row or from the model, made safe to quote on one line, cut by
 * code points. A name is somebody's typing, and a stray line break must not
 * let it pose as the tool's own line.
 */
function oneLine(text: string | null | undefined, max = 80): string {
  const folded = (text ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(folded)
  return chars.length <= max ? folded : `${chars.slice(0, max - 1).join('')}…`
}

/** For comparing what the model typed with what is stored: case and spacing do not count. */
const fold = (text: string | null | undefined): string => oneLine(text, 400).toLowerCase()

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "1 draft and 2 notes" — the nonzero parts, or null when there are none. */
function andList(parts: readonly string[]): string | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * How a company is named to the model. A booking page's `<address>.inbound`
 * placeholder IS a person's address, so it is never printed; a business with
 * no website of its own is named by its name.
 */
function companyWords(domain: string | null, name: string | null): string {
  if (!domain) return 'no company'
  if (domain.endsWith('.inbound')) return 'a booking-page lead'
  if (isNoSiteDomain(domain)) return `${oneLine(name, 80) || 'a business'} (no website on record)`
  return domain
}

/**
 * Whether what the model typed names this company: its domain as the CRM
 * stores one (case, scheme, path and `www.` do not count), or — for a
 * business with no website, as the company page's Delete takes it — its name.
 */
function namesCompany(given: string, company: { readonly domain: string; readonly name: string | null }): boolean {
  const typed = given.trim().toLowerCase()
  if (typed === company.domain || normaliseDomain(typed) === company.domain) return true
  return isNoSiteDomain(company.domain) && fold(company.name) !== '' && fold(given) === fold(company.name)
}

/** A domain the model typed, quoted back — unless it carries an `@`, which makes it somebody's address. */
function typedDomainWords(raw: string): string {
  return raw.includes('@') ? 'the domain given' : `“${oneLine(raw, 100)}”`
}

/** "…@carbonmaps.io", "@carbonmaps.io" or "carbonmaps.io" — the domain alone. */
function typedEmailDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^(?:…|\.\.\.)/, '').replace(/^.*@/, '')
}

function storedEmailDomain(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).trim().toLowerCase() : null
}

/** The class of a fault, never its message — a driver's message quotes the values it was bound. */
function faultClass(err: unknown): string {
  return err instanceof Error ? err.name || 'Error' : 'Error'
}

// ---------------------------------------------------------------------------
// delete_contacts
// ---------------------------------------------------------------------------

const deleteContactsShape = {
  contacts: z
    .array(
      z.object({
        contactId: z.uuid().describe('The person, by the id list_contacts or search_crm printed.'),
        name: z
          .string()
          .max(160)
          .optional()
          .describe('Their name as list_contacts printed it — a check shown on the card: nothing is deleted when it does not match.'),
        emailDomain: z
          .string()
          .max(253)
          .optional()
          .describe('The domain of their email as list_contacts showed it (…@domain) — a check, like name. Never a whole address.'),
      }),
    )
    .min(1)
    .max(DELETE_PER_CALL)
    .describe(`Up to ${DELETE_PER_CALL} people, each by id, with what you were shown of them.`),
  why: z
    .string()
    .min(1)
    .max(200)
    .describe('Why, in a few words, for the person approving — e.g. "invented by the assistant to test the features".'),
}

export function makeDeleteContacts(opts: DeleteToolOptions = {}): AgencyToolSpec<typeof deleteContactsShape> {
  return {
    name: 'delete_contacts',
    description:
      'Delete people from the CRM that nothing was ever sent to or received from — a person the assistant made up, ' +
      'a duplicate, a mistake — with their waiting drafts, consents they granted and notes about them. Each by id, ' +
      'with the name and email domain list_contacts showed, checked against the record before anything goes. A ' +
      'person approves the call first, and it cannot be undone. Refused, per person and in words, for anybody a ' +
      'message went to or came from, a call named, who said no or whose own opt-out could not be recorded — an ' +
      'owner erases them on /contacts instead — and for anybody holding a number a text asked to stop from that ' +
      'could not be recorded, until the number is on /suppressions. A suppression on their address stays. A call ' +
      'answers inside its time and names anybody it did not reach, to be asked for again. Nothing is sent.',
    shape: deleteContactsShape,
    async handler(input, ctx): Promise<ToolOutcome<unknown>> {
      const mayStart = timeLeft(opts)
      // The Delete on /contacts' own gate.
      if (!can(ctx.principal, 'contacts:write')) {
        return fail('not_permitted', `The person you are helping cannot delete contacts. ${NOTHING_DELETED}`)
      }
      if (!oneLine(input.why)) return fail('invalid_state', `Say why — the person approving reads it. ${NOTHING_DELETED}`)

      const items = eachOnce(input.contacts, (c) => c.contactId, (c, contactId) => ({ ...c, contactId }))
      const rows = await ctx.db
        .select({
          id: schema.contacts.id,
          firstName: schema.contacts.firstName,
          lastName: schema.contacts.lastName,
          title: schema.contacts.title,
          email: schema.contacts.email,
          domain: schema.companies.domain,
          companyName: schema.companies.name,
        })
        .from(schema.contacts)
        .leftJoin(
          schema.companies,
          and(eq(schema.companies.id, schema.contacts.companyId), eq(schema.companies.orgId, schema.contacts.orgId)),
        )
        .where(and(eq(schema.contacts.orgId, ctx.orgId), inArray(schema.contacts.id, items.map((i) => i.contactId))))
      const byId = new Map(rows.map((r) => [r.id, r]))

      const lines: string[] = []
      const deletedIds: string[] = []
      const notReached: { readonly id: string; readonly name: string }[] = []
      for (const item of items) {
        const row = byId.get(item.contactId)
        const name = row ? oneLine([row.firstName, row.lastName].filter((p) => p && p.trim()).join(' ')) : ''
        const title = row ? oneLine(row.title, 60) : ''
        const label = row
          ? `${name || '(no name recorded)'}${title ? ` (${title})` : ''} at ${companyWords(row.domain, row.companyName)} — id ${row.id}`
          : `id ${item.contactId}`
        // Out of time: this one, and every one after it, is left as it is.
        if (!mayStart()) {
          notReached.push({ id: item.contactId, name })
          continue
        }
        if (!row) {
          lines.push(`Kept id ${item.contactId}: no such contact in this org — it may already have been deleted.`)
          continue
        }

        // What the card named, against what is stored. A name is shown to the
        // model; an address only by its domain, so only the domain is compared.
        if (item.name !== undefined && fold(item.name) !== fold(name || '(no name recorded)')) {
          lines.push(`Kept ${label}: the name on file is not “${oneLine(item.name, 80)}”. Read them again with list_contacts.`)
          continue
        }
        if (item.emailDomain !== undefined && typedEmailDomain(item.emailDomain) !== storedEmailDomain(row.email)) {
          lines.push(
            `Kept ${label}: their email on file is ${row.email ? 'at another domain' : 'not recorded'}, not …@` +
              `${oneLine(typedEmailDomain(item.emailDomain), 100)}. Read them again with list_contacts.`,
          )
          continue
        }

        try {
          const r = await contactDelete(ctx.db, { orgId: ctx.orgId, contactId: row.id, actor: 'agent' })
          if (!r.ok) {
            lines.push(`Kept ${label}: ${r.message}`)
            continue
          }
          deletedIds.push(row.id)
          const went = andList([
            ...(r.draftsRemoved > 0 ? [plural(r.draftsRemoved, 'waiting draft')] : []),
            ...(r.consentsRemoved > 0 ? [plural(r.consentsRemoved, 'consent')] : []),
            ...(r.notesRemoved > 0 ? [plural(r.notesRemoved, 'note')] : []),
          ])
          lines.push(`Deleted ${label}${went ? `, with ${went}` : ''}.`)
        } catch (err) {
          // One transaction per person: a fault rolls back that person alone.
          lines.push(`Kept ${label}: deleting them failed (${faultClass(err)}), and nothing of theirs was removed. Try again.`)
        }
      }

      const kept = items.length - deletedIds.length - notReached.length
      await ctx.audit('agent.delete_contacts', {
        asked: items.length, deleted: deletedIds.length, kept,
        ...(notReached.length > 0 ? { notReached: notReached.length } : {}),
      })
      return ok(
        { deleted: deletedIds, kept, notReached: notReached.map((n) => n.id) },
        answerText(
          [headline(deletedIds.length, plural(items.length, 'contact'), kept, notReached.length), ...notReachedLines(notReached)],
          lines.map((l) => `  ${l}`),
          ['A suppression on anybody’s address stays on the list. ' + NOTHING_SENT],
        ),
      )
    },
  }
}

export const deleteContacts = makeDeleteContacts()

// ---------------------------------------------------------------------------
// delete_companies
// ---------------------------------------------------------------------------

const deleteCompaniesShape = {
  companies: z
    .array(
      z.object({
        companyId: z.uuid().describe('The company, by the id search_crm printed.'),
        domain: z
          .string()
          .min(1)
          .max(253)
          .describe(
            'Its domain exactly as the CRM has it — for a business with no website, its name. Checked against the ' +
              'record and shown on the card: nothing is deleted when it does not match.',
          ),
      }),
    )
    .min(1)
    .max(DELETE_COMPANIES_PER_CALL)
    .describe(`Up to ${DELETE_COMPANIES_PER_CALL} companies, each by id and domain.`),
  why: z
    .string()
    .min(1)
    .max(200)
    .describe('Why, in a few words, for the person approving — e.g. "filed under a business.site domain that does not exist".'),
}

export function makeDeleteCompanies(opts: DeleteToolOptions = {}): AgencyToolSpec<typeof deleteCompaniesShape> {
  return {
    name: 'delete_companies',
    description:
      'Delete companies that nothing was ever sent to or received from — one filed under a made-up or dead domain, ' +
      'a duplicate, a mistake — with everything that hangs off it: its people, their drafts, scans, deals, meetings ' +
      'with no outcome, draft quotes and proposals, notes, tasks, research and share links. An owner’s act; each by ' +
      'id with its domain, checked before anything goes. A person approves the call first, and it cannot be undone. ' +
      'Refused, per company and in words, for one a message went to or came from, a won deal, a quote or proposal ' +
      'that went out, a meeting with its outcome recorded, a call where they asked to stop, a person there who ' +
      'must be erased instead, or one holding a number a text asked to stop from that could not be recorded. Up ' +
      `to ${DELETE_COMPANIES_PER_CALL} a call, each with at most ${DELETE_COMPANY_PEOPLE_MAX} people (a bigger one ` +
      'is deleted on its company page); a call answers inside its time and names any it did not reach, to be ' +
      'asked for again. The night shift and the agency tools do not file a deleted company again by its domain or ' +
      'place id. Nothing is sent.',
    shape: deleteCompaniesShape,
    async handler(input, ctx): Promise<ToolOutcome<unknown>> {
      const mayStart = timeLeft(opts)
      // The company page's Delete is an owner's, with the domain typed back.
      if (!can(ctx.principal, 'users:write')) {
        return fail(
          'not_permitted',
          'Only an owner deletes a company, and the person you are helping is not one. A teammate can delete its ' +
            `people on /contacts, or close its deal as lost. ${NOTHING_DELETED}`,
        )
      }
      if (!oneLine(input.why)) return fail('invalid_state', `Say why — the person approving reads it. ${NOTHING_DELETED}`)

      const items = eachOnce(input.companies, (c) => c.companyId, (c, companyId) => ({ ...c, companyId }))
      const ids = items.map((i) => i.companyId)
      const rows = await ctx.db
        .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, ctx.orgId), inArray(schema.companies.id, ids)))
      // How many people each has, for every item in one statement: what its delete will cost.
      const headcounts = await ctx.db
        .select({ companyId: schema.contacts.companyId, n: sql<number>`count(*)::int` })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.orgId, ctx.orgId), inArray(schema.contacts.companyId, ids)))
        .groupBy(schema.contacts.companyId)
      const peopleAt = new Map(headcounts.map((h) => [h.companyId, h.n]))
      const byId = new Map(rows.map((r) => [r.id, { ...r, people: peopleAt.get(r.id) ?? 0 }]))

      const lines: string[] = []
      const deletedIds: string[] = []
      const notReached: { readonly id: string; readonly name: string }[] = []
      for (const item of items) {
        const row = byId.get(item.companyId)
        const label = row ? `${companyWords(row.domain, row.name)} — id ${row.id}` : `id ${item.companyId}`
        // Out of time: this one, and every one after it, is left as it is.
        if (!mayStart()) {
          notReached.push({ id: item.companyId, name: row ? companyWords(row.domain, row.name) : '' })
          continue
        }
        if (!row) {
          lines.push(`Kept id ${item.companyId}: no such company in this org — it may already have been deleted.`)
          continue
        }
        if (!namesCompany(item.domain, row)) {
          lines.push(
            `Kept ${label}: its domain on file is not ${typedDomainWords(item.domain)}. ` +
              'Find it again with search_crm.',
          )
          continue
        }
        // Its cost grows with its people: past the bound it could not finish
        // inside this call, and would finish after the model was told it failed.
        if (row.people > DELETE_COMPANY_PEOPLE_MAX) {
          lines.push(
            `Kept ${label}: it has ${row.people} people — more than this call can delete in its time. An owner ` +
              'deletes it on its company page, which has no such time limit.',
          )
          continue
        }
        try {
          const r = await companyDelete(ctx.db, { orgId: ctx.orgId, companyId: row.id, actor: 'agent' })
          if (!r.ok) {
            lines.push(`Kept ${label}: ${r.message}`)
            continue
          }
          deletedIds.push(row.id)
          const went = andList([
            ...(r.contacts > 0 ? [plural(r.contacts, 'person', 'people')] : []),
            ...(r.drafts > 0 ? [plural(r.drafts, 'draft')] : []),
            ...(r.deals > 0 ? [plural(r.deals, 'deal')] : []),
            ...(r.meetings > 0 ? [plural(r.meetings, 'meeting')] : []),
            ...(r.quotes > 0 ? [plural(r.quotes, 'draft quote')] : []),
            ...(r.proposals > 0 ? [plural(r.proposals, 'draft proposal')] : []),
            ...(r.scans > 0 ? [plural(r.scans, 'scan')] : []),
          ])
          lines.push(`Deleted ${label}${went ? `, with ${went}` : ''}.`)
        } catch (err) {
          lines.push(`Kept ${label}: deleting it failed (${faultClass(err)}), and nothing of it was removed. Try again.`)
        }
      }

      const kept = items.length - deletedIds.length - notReached.length
      await ctx.audit('agent.delete_companies', {
        asked: items.length, deleted: deletedIds.length, kept,
        ...(notReached.length > 0 ? { notReached: notReached.length } : {}),
      })
      return ok(
        { deleted: deletedIds, kept, notReached: notReached.map((n) => n.id) },
        answerText(
          [
            headline(deletedIds.length, plural(items.length, 'company', 'companies'), kept, notReached.length),
            ...notReachedLines(notReached),
          ],
          lines.map((l) => `  ${l}`),
          [...(deletedIds.length > 0 ? [DELETED_NOT_FILED_AGAIN] : []), NOTHING_SENT],
        ),
      )
    },
  }
}

export const deleteCompanies = makeDeleteCompanies()

// ---------------------------------------------------------------------------
// delete_meeting
// ---------------------------------------------------------------------------

const deleteMeetingShape = {
  meetingId: z.uuid().describe('The meeting, by the id list_meetings printed.'),
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe(
      'The company the meeting is with, by the domain list_meetings printed (a business with no website: its name) — ' +
        'a check shown on the card.',
    ),
  why: z.string().min(1).max(200).describe('Why, in a few words, for the person approving — e.g. "booked with a person who does not exist".'),
}

/** "2026-10-16 15:00 Asia/Kolkata (2026-10-16 09:30 UTC)", or the UTC instant alone for a zone the runtime does not know. */
function inZone(d: Date, zone: string): string {
  const utc = `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d)
    const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '??'
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${zone} (${utc})`
  } catch {
    return utc
  }
}

export const deleteMeeting: AgencyToolSpec<typeof deleteMeetingShape> = {
  name: 'delete_meeting',
  description:
    'Delete a recorded meeting that should never have been recorded — one booked with a person who does not ' +
    'exist, a duplicate, a mistake. A meeting that was arranged and then called off is cancelled with ' +
    'cancel_meeting instead, which keeps the record. By id, with the company it is with, checked before anything ' +
    'goes. A person approves the call first, and it cannot be undone. Refused once its outcome is recorded, and ' +
    'for one that replaced a rescheduled meeting, which is cancelled instead. The deal does not move back, and ' +
    'nobody is told. Nothing is sent.',
  shape: deleteMeetingShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change meetings. ${NOTHING_DELETED}`)
    }
    if (!oneLine(input.why)) return fail('invalid_state', `Say why — the person approving reads it. ${NOTHING_DELETED}`)
    const found = await readMeetingWithCompany(ctx.db, ctx.orgId, input.meetingId)
    if (!found) return fail('not_found', `No such meeting in this org — it may already have been deleted. ${NOTHING_DELETED}`)
    const { meeting, company } = found
    const withWhom = companyWords(company.domain, company.name)
    if (!namesCompany(input.domain, company)) {
      return fail(
        'invalid_state',
        `Meeting ${meeting.id} is with ${withWhom}, not ${typedDomainWords(input.domain)}. ` +
          `Read it again with list_meetings. ${NOTHING_DELETED}`,
      )
    }

    const r = await meetingDelete(ctx.db, { orgId: ctx.orgId, meetingId: meeting.id, actor: 'agent' })
    if (!r.ok) {
      return fail(
        r.code === 'not_found' ? 'not_found' : 'invalid_state',
        `${r.message}${r.code === 'outcome_recorded' ? ' A wrong outcome is corrected with record_meeting_outcome.' : ''} ${NOTHING_DELETED}`,
      )
    }
    await ctx.audit('agent.delete_meeting', { meetingId: meeting.id, companyId: meeting.companyId })
    const title = oneLine(meeting.title, 100)
    return ok(
      { meetingId: meeting.id, deleted: true },
      `Deleted the meeting with ${withWhom}${title ? ` “${title}”` : ''} at ${inZone(meeting.startsAt, meeting.timeZone)} ` +
        `(meeting ${meeting.id}) from the CRM. The deal stays where it is — recording the meeting moved it forward, ` +
        'and a person moves it back on the board if that was wrong. Nobody is told by this; if an invitation went ' +
        `out from a calendar, cancel it there. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------

const deleteTaskShape = {
  taskId: z.uuid().describe('The task, by the id list_tasks printed.'),
  title: z
    .string()
    .min(1)
    .max(500)
    .describe('Its title as list_tasks printed it — a check shown on the card: nothing is deleted when it does not match.'),
  why: z.string().min(1).max(200).describe('Why, in a few words, for the person approving — e.g. "a call to a person who does not exist".'),
}

async function taskWithCompany(ctx: ToolContext, taskId: string) {
  const [row] = await ctx.db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      kind: schema.tasks.kind,
      companyId: schema.tasks.companyId,
      domain: schema.companies.domain,
      companyName: schema.companies.name,
    })
    .from(schema.tasks)
    .leftJoin(schema.companies, and(eq(schema.companies.id, schema.tasks.companyId), eq(schema.companies.orgId, schema.tasks.orgId)))
    .where(and(eq(schema.tasks.orgId, ctx.orgId), eq(schema.tasks.id, taskId)))
    .limit(1)
  return row ?? null
}

export const deleteTask: AgencyToolSpec<typeof deleteTaskShape> = {
  name: 'delete_task',
  description:
    'Delete a task that should not exist — a call to a person who does not exist, a duplicate, a mistake. A task ' +
    'that was done is closed with complete_task instead. By id, with its title, checked before anything goes. A ' +
    'person approves the call first, and it cannot be undone. Refused for a LinkedIn step, which the person who ' +
    'sent it closes on /tasks, and for a call where they asked to stop, which is that request’s record. Nothing ' +
    'is sent.',
  shape: deleteTaskShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot change tasks. ${NOTHING_DELETED}`)
    }
    if (!oneLine(input.why)) return fail('invalid_state', `Say why — the person approving reads it. ${NOTHING_DELETED}`)
    const task = await taskWithCompany(ctx, input.taskId)
    if (!task) return fail('not_found', `No such task in this org — it may already have been deleted. ${NOTHING_DELETED}`)
    const title = oneLine(task.title, 200)
    if (fold(input.title) !== fold(task.title)) {
      return fail(
        'invalid_state',
        `Task ${task.id} is “${title}”, not “${oneLine(input.title, 200)}”. Read it again with list_tasks. ${NOTHING_DELETED}`,
      )
    }

    const r = await taskDelete(ctx.db, { orgId: ctx.orgId, taskId: task.id, actor: 'agent' })
    if (!r.ok) return fail(r.code === 'not_found' ? 'not_found' : 'invalid_state', `${r.message} ${NOTHING_DELETED}`)
    await ctx.audit('agent.delete_task', { taskId: task.id, kind: task.kind, companyId: task.companyId })
    const about = task.domain ? ` about ${companyWords(task.domain, task.companyName)}` : ''
    return ok(
      { taskId: task.id, deleted: true },
      `Deleted the task “${title}”${about} (task ${task.id}). ${NOTHING_SENT}`,
    )
  },
}
