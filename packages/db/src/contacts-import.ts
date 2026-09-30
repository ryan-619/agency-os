/**
 * Contacts from a CSV (PROMPT.md §2.1, §8.4).
 *
 * Two rules make this more than a loop over `createContact`:
 *
 *  - **It writes NO consent rows.** An import is a list somebody bought,
 *    scraped or exported; it is not a record of anyone agreeing to anything.
 *    Every person it creates starts from NO on every channel (§2.1: absence
 *    means NO), and consent is recorded afterwards, per person, per channel,
 *    with a source — the ledger's job, never this one's. There is no column
 *    in the accepted header that could carry consent, on purpose.
 *  - **A phone it cannot normalise is DROPPED, not stored.** A number with no
 *    `+` and country code cannot be matched by a suppression row (those are
 *    E.164 by CHECK), so storing it would store a number whose opt-out could
 *    never be found. The row is still imported on its other addresses and
 *    the drop is reported by line, so a person can fix the file.
 *
 * Every contact goes through `createContact`, so an import cannot develop its
 * own idea of what a valid address or zone is: the email is folded the way
 * the suppression list folds it, the zone is checked against the runtime, and
 * a row with no way to reach anybody is refused with the same sentence the
 * form gives.
 *
 * No transaction around the batch, deliberately. `createContact` answers a
 * duplicate that races in by catching the unique violation, and inside a
 * transaction that error aborts everything after it. The import is
 * idempotent instead — a re-run reports what is already present and creates
 * nothing twice — so a run cut off halfway is fixed by running it again.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { normaliseEmail, normaliseLinkedIn, normalisePhone } from '@agency/core'
import * as schema from './schema.js'
import { contactInput, createContact } from './contacts.js'
import type { AgencyDb } from './repository.js'

/**
 * The header an import must carry, in any order. Every one is required, even
 * when a file has nothing to put under it: a misspelt `timezone` or
 * `phone_number` would otherwise be ignored as an unknown column, and every
 * zone or number in the file would vanish without a word.
 */
export const CONTACT_IMPORT_COLUMNS = [
  'domain', 'email', 'first_name', 'last_name', 'title', 'phone', 'linkedin_url', 'time_zone',
] as const

type ImportColumn = (typeof CONTACT_IMPORT_COLUMNS)[number]

const COLUMN_FOR_FIELD: Readonly<Record<string, ImportColumn>> = {
  firstName: 'first_name', lastName: 'last_name', title: 'title', email: 'email',
  phone: 'phone', linkedinUrl: 'linkedin_url', timeZone: 'time_zone',
}

export interface ContactSeedRow {
  /** The line of the file the record STARTS on, 1-based — what a report names. */
  readonly line: number
  /** Lower-cased, with any scheme and path removed. Matched to a company already in the CRM. */
  readonly domain: string
  readonly email: string | null
  readonly firstName: string | null
  readonly lastName: string | null
  readonly title: string | null
  readonly phone: string | null
  readonly linkedinUrl: string | null
  readonly timeZone: string | null
  /**
   * Why this record cannot be read the way the header describes it — set by
   * the parser, turned into a refusal by `importContacts`. One bad line is
   * reported against its line number rather than failing a 5,000-row file.
   */
  readonly problem?: string
}

export interface ContactImportResult {
  readonly inserted: number
  readonly alreadyPresent: number
  /** The domains that match no company in this org, each once, in file order. */
  readonly unknownCompany: string[]
  readonly refused: { line: number; message: string }[]
  /** Lines whose phone could not be read as an international number and was left out. */
  readonly phoneDropped: { line: number }[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split a CSV into records: RFC 4180 quoting (`"a, b"`, `""` for a quote,
 * a newline inside quotes), CRLF, LF or a bare CR, a leading BOM, and blank
 * lines and `#` comment lines skipped.
 *
 * A quote only opens a quoted value at the start of one; elsewhere it is an
 * ordinary character, and text after a closing quote is kept rather than
 * refused — what Python's `csv` module and every spreadsheet do with it.
 */
function readRecords(csv: string): Array<{ line: number; cells: string[] }> {
  const text = csv.startsWith('﻿') ? csv.slice(1) : csv
  const out: Array<{ line: number; cells: string[] }> = []
  const n = text.length
  let i = 0
  let line = 1

  /** Index just past the line break at `at` (CRLF counts once). */
  const pastBreak = (at: number): number => (text[at] === '\r' && text[at + 1] === '\n' ? at + 2 : at + 1)

  while (i < n) {
    // At the start of a physical line, which is also the start of a record.
    let eol = i
    while (eol < n && text[eol] !== '\n' && text[eol] !== '\r') eol += 1
    const physical = text.slice(i, eol)
    if (!physical.trim() || physical.trimStart().startsWith('#')) {
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
          throw new Error(
            `The quoted value that starts on line ${startLine} is never closed, so everything after it ` +
              'would be read as one value. Close the quote and import again.',
          )
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

/** `First Name`, `first-name` and `first_name` are one column. */
function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** A company is matched by its domain, so a pasted URL is reduced to one. */
function domainOf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
}

const orNull = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t ? t : null
}

/**
 * Read an import file into rows.
 *
 * The header is REQUIRED and must name every column in
 * `CONTACT_IMPORT_COLUMNS`, in any order; anything else in it (an export's
 * forty other columns) is ignored. A missing column throws an `Error` naming
 * it, because a file read under the wrong idea of its columns puts a phone
 * number where a title goes and says nothing.
 *
 * A record with more values than the header names — almost always a comma
 * inside a value that was not quoted, which shifts every value after it into
 * the wrong column — comes back with a `problem` rather than as data. Fewer
 * values is the same fault read from the other end.
 */
export function parseContactSeeds(csv: string): ContactSeedRow[] {
  const records = readRecords(csv)
  const head = records[0]
  const expected = CONTACT_IMPORT_COLUMNS.join(',')
  if (!head) throw new Error(`There is no header line. The first line must name the columns: ${expected}`)

  const keys = head.cells.map(headerKey)
  const index = new Map<string, number>()
  for (const [pos, key] of keys.entries()) {
    if (!key) continue
    if (index.has(key)) throw new Error(`The header names ${key} twice, so there is no telling which one to read.`)
    index.set(key, pos)
  }
  const missing = CONTACT_IMPORT_COLUMNS.filter((c) => !index.has(c))
  if (missing.length > 0) {
    throw new Error(
      `The header has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}. ` +
        `The first line must name all of: ${expected} (in any order; a column can be empty).`,
    )
  }

  const width = keys.length
  const out: ContactSeedRow[] = []
  for (const record of records.slice(1)) {
    const cells = record.cells
    // A trailing comma or two is a spreadsheet's habit, not a shifted value.
    while (cells.length > width && (cells[cells.length - 1] ?? '').trim() === '') cells.pop()
    const at = (c: ImportColumn): string | undefined => cells[index.get(c) as number]
    const problem =
      cells.length === width
        ? undefined
        : `This line has ${cells.length} value${cells.length === 1 ? '' : 's'} where the header names ${width}. ` +
          'A value containing a comma has to be in double quotes, or every value after it lands in the wrong column.'
    out.push({
      line: record.line,
      domain: domainOf(at('domain') ?? ''),
      email: orNull(at('email')),
      firstName: orNull(at('first_name')),
      lastName: orNull(at('last_name')),
      title: orNull(at('title')),
      phone: orNull(at('phone')),
      linkedinUrl: orNull(at('linkedin_url')),
      timeZone: orNull(at('time_zone')),
      ...(problem ? { problem } : {}),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/**
 * What makes a row the same person as one already on file.
 *
 * The email when there is one — `contacts_org_email_key` is on the folded
 * address, org-wide, so that is what the database would say anyway. Without
 * one, a LinkedIn profile names one person; a phone number does NOT (a
 * switchboard is shared by everybody at a company), so a phone only matches
 * together with the company and the name. This is what makes a re-run of the
 * same file create nothing twice.
 */
function identity(args: {
  companyId: string
  email: string | null
  linkedinUrl: string | null
  phone: string | null
  firstName: string | null
  lastName: string | null
}): string | null {
  if (args.email) {
    const email = normaliseEmail(args.email)
    return email ? `email:${email}` : null
  }
  if (args.linkedinUrl) {
    const profile = normaliseLinkedIn(args.linkedinUrl)
    if (profile) return `linkedin:${profile}`
  }
  if (args.phone) {
    const phone = normalisePhone(args.phone)
    if (phone) {
      const name = `${args.firstName ?? ''} ${args.lastName ?? ''}`.trim().toLowerCase()
      return `phone:${args.companyId}:${phone}:${name}`
    }
  }
  return null
}

/**
 * Create the contacts a parsed file describes.
 *
 * Each row ends in exactly one of: inserted, already present, an unknown
 * company, or refused with its line and the sentence that says why. A
 * dropped phone is reported beside whichever of those it was.
 *
 * Nothing here records consent, and nothing here sends: an imported person
 * is someone the send path will judge from the rows a human records next.
 */
export async function importContacts(
  db: AgencyDb,
  orgId: string,
  rows: readonly ContactSeedRow[],
  source: 'apollo' | 'manual' | 'import' | 'agent' = 'import',
): Promise<ContactImportResult> {
  const result = {
    inserted: 0,
    alreadyPresent: 0,
    unknownCompany: [] as string[],
    refused: [] as { line: number; message: string }[],
    phoneDropped: [] as { line: number }[],
  }
  if (rows.length === 0) return result

  // One lookup for every company the file names — the apex AND the www form,
  // since a list exported from a CRM spells the same site both ways.
  const wanted = new Set<string>()
  for (const r of rows) {
    if (!r.domain) continue
    wanted.add(r.domain)
    wanted.add(r.domain.startsWith('www.') ? r.domain.slice(4) : `www.${r.domain}`)
  }
  const companies = wanted.size
    ? await db
        .select({ id: schema.companies.id, domain: schema.companies.domain })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, orgId), inArray(schema.companies.domain, [...wanted])))
    : []
  const byDomain = new Map(companies.map((c) => [c.domain, c.id]))
  const companyFor = (domain: string): string | undefined =>
    byDomain.get(domain) ?? byDomain.get(domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`)

  // Everyone already on file in this org, reduced to the identities above.
  const existing = await db
    .select({
      companyId: schema.contacts.companyId,
      email: schema.contacts.email,
      linkedinUrl: schema.contacts.linkedinUrl,
      phone: schema.contacts.phone,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.orgId, orgId))
  // A contact with an email is ALSO findable by the identity it would have
  // without one, so a row carrying only the LinkedIn URL (or the number and
  // name) of somebody already on file is a repeat, not a second person.
  const present = new Set<string>()
  const remember = (c: Parameters<typeof identity>[0]): void => {
    for (const key of [identity(c), identity({ ...c, email: null })]) if (key) present.add(key)
  }
  for (const c of existing) remember(c)

  const unknown = new Set<string>()
  for (const row of rows) {
    if (row.problem) {
      result.refused.push({ line: row.line, message: row.problem })
      continue
    }
    if (!row.domain) {
      result.refused.push({
        line: row.line,
        message: 'There is no domain. A contact belongs to a company, and the company is found by its domain.',
      })
      continue
    }
    const companyId = companyFor(row.domain)
    if (!companyId) {
      if (!unknown.has(row.domain)) {
        unknown.add(row.domain)
        result.unknownCompany.push(row.domain)
      }
      continue
    }

    // §2.1: a number the suppression list could never match is not stored.
    let phone: string | null = null
    if (row.phone) {
      phone = normalisePhone(row.phone)
      if (!phone) result.phoneDropped.push({ line: row.line })
    }
    if (row.phone && !phone && !row.email && !row.linkedinUrl) {
      result.refused.push({
        line: row.line,
        message:
          'The phone number is not an international one (it needs a + and a country code), so it was left ' +
          'out — and without it there is no way to reach this person.',
      })
      continue
    }

    const candidate = { companyId, email: row.email, linkedinUrl: row.linkedinUrl, phone, firstName: row.firstName, lastName: row.lastName }
    const key = identity(candidate)
    if (key && present.has(key)) {
      result.alreadyPresent += 1
      continue
    }

    const input = contactInput.safeParse({
      companyId,
      firstName: row.firstName,
      lastName: row.lastName,
      title: row.title,
      email: row.email,
      phone,
      linkedinUrl: row.linkedinUrl,
      timeZone: row.timeZone,
      source,
    })
    if (!input.success) {
      // Named by the file's column, not the code's field — the person fixing
      // it is looking at the header.
      const first = input.error.issues[0]
      const field = String(first?.path[0] ?? '')
      result.refused.push({
        line: row.line,
        message: `${COLUMN_FOR_FIELD[field] ?? (field || 'row')}: ${first?.message ?? 'Invalid.'}`,
      })
      continue
    }

    const created = await createContact(db, orgId, input.data)
    if (!created.ok) {
      result.refused.push({ line: row.line, message: created.message })
      continue
    }
    result.inserted += 1
    remember(created.contact)
  }
  return result
}
