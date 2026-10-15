/**
 * The records tools: the companies and people in the CRM, the pause that
 * holds a person from every campaign, and the suppression list (2026-10-06).
 *
 * `list_contacts` is a READ (`low`). Every other tool here writes internal
 * state (`medium`, and run at once: `runsWithoutApproval` lets internal
 * writes through without a card) — except
 * `resume_contact`, which is `high`: lifting a pause lets campaigns write to
 * somebody again, and that is a person's decision (§2.4). None of them sends
 * anything, and every write's summary ends "Nothing was sent."
 *
 * Every write goes through the function its web route calls, after the
 * checks the route makes first: `importCompanies` and `companiesUpdate` (the
 * import page and PATCH /api/companies/[id]), `createContact`,
 * `contactsUpdate` and `updateContactTimeZone` (POST and PATCH
 * /api/contacts), `contactPauseByHand` and `contactResumeByHand` (the
 * /contacts Pause and Resume), and `addSuppression` (POST /api/suppressions).
 * Where the route writes an audit row of its own, the tool writes the same
 * row with the actor `agent`; where the function takes an actor, it is
 * `agent`. So the agent's write and a person's are the same row, refused for
 * the same reasons in the same sentences.
 *
 * Four rules are the agent's own, on top of a person's:
 *
 *   - true data only (2026-10-13): an email address, a phone number, a named
 *     person, a LinkedIn profile and a website are stored only when this
 *     conversation SHOWED them — the person typed them, or a tool returned
 *     them (a page read, a search, a connector's answer) — never when the
 *     model composed them. An address is stored with where it came from (the
 *     page, `chat`, `connector:<name>`), an email whose domain receives no
 *     mail is refused, and a business with no website of its own is filed as
 *     website "none" rather than under a domain nobody showed. The checks
 *     read the worker's page reader and the conversation's ledger; a test or
 *     a script without them skips them;
 *   - a company is added only by a domain the scanner would request
 *     (`isScannableHost`) — a model-supplied domain is the untrusted input
 *     that check exists for — and never as the booking page's
 *     `<address>.inbound` placeholder, which names a person, not a website;
 *   - an address (email, phone, LinkedIn) is not changed while a message to
 *     the person is waiting to go out: the sender reads the address at the
 *     moment it sends, so an approved message would go to the new one, and
 *     a person, who can see those messages, makes that change on /contacts;
 *   - a pause it writes is a teammate's hold (`manual`) and nothing else: a
 *     reason that would read as the system's own pause for an opt-out that
 *     could not be stored is refused, because nobody could ever lift it.
 *
 * What reaches the model (§2.3, §5.5): names, titles, a company's domain,
 * and an email address masked to its domain — never a full address, a
 * number or a profile. A pause is shown by its CLASS (`pauseReasonClass`),
 * never its reason, which can carry a teammate's address or the person's
 * own words; `resume_contact` takes that class back, and lifts the pause
 * only while it is still of that class. The `agent.*` rows carry ids,
 * counts, flags and fixed words.
 */
import { z } from 'zod'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  COMPANY_STAGES, addressSourceWords, can, isNoSiteDomain, maskAddress, maskPhone, noSiteDomain, normaliseEmail,
  normaliseLinkedIn, normalisePhone, pageLabel, pauseReasonClass, readablePathProblem, textNamesPerson,
  textShowsEmail, textShowsPhone,
  type FindPhonesOptions, type PauseReasonClass, type SuppressionKind,
} from '@agency/core'
import {
  COMPLIANCE_UNSENT_STATUSES, addSuppression as addSuppressionRow, appendAudit, auditSuppressionAdded, companiesSetReachFacts,
  companiesUpdate, companyPatchInput, consentLedgerFor, contactInput, contactPatchInput, contactPauseByHand,
  contactResumeByHand, contactsLedger, contactsUpdate, createContact, findCompanyByDomain,
  importCompanies as importCompanyRows, isKnownTimeZone, isSharedNumberOptOutPause, updateContactTimeZone,
  type ConsentLedger, type ContactPauseOutcome, type ContactResumeOutcome, type ContactRow,
  type ContactsUpdateOutcome, type LedgerRow,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { isScannableHost, normaliseDomain, type PageRead } from '@agency/scanner'
import {
  TOOL_TIME_BUDGET_MS, bounded, fail, ok, type AgencyToolSpec, type SeenOrigin, type ToolContext, type ToolErrorCode,
  type ToolOutcome,
} from './spec.js'
import {
  WEB_WORK_MS, connectorSource, deadline, foundByHandle, foundByValue, hasNameParts, pageSource, phoneOptsFor,
  phoneValue, readWithin, serverOf, showsIt, textShowsLinkedIn, websiteCheck, within,
} from './web.js'

const NOTHING_SENT = 'Nothing was sent.'
const UNCHANGED = 'Nothing was changed.'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Company = typeof schema.companies.$inferSelect

interface Refusal {
  readonly ok: false
  readonly code: ToolErrorCode
  readonly message: string
}

const refuse = (code: ToolErrorCode, message: string): Refusal => ({ ok: false, code, message })

/** A db sentence, with the tail every refusal here ends on — unless it says so already. */
function unchanged(message: string): string {
  return /nothing was changed/i.test(message) ? message : `${message.trim()} ${UNCHANGED}`
}

/** "2026-09-15 12:00 UTC". */
function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * Text from a row or from the model, made safe to quote on one line: control
 * characters become spaces, whitespace is folded, and it is cut by code
 * points so a cut never leaves half a character. A name is somebody's
 * typing, and a stray line break must not let it pose as the tool's own line.
 */
function oneLine(text: string | null | undefined, max = 80): string {
  const folded = (text ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(folded)
  return chars.length <= max ? folded : `${chars.slice(0, max - 1).join('')}…`
}

/** An email address by its domain only — `…@rentman.io` — as the send-check route masks a recipient. */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at > 0 && at < email.length - 1 ? `…@${oneLine(email.slice(at + 1), 100)}` : null
}

function nameOf(c: Pick<ContactRow, 'firstName' | 'lastName'>): string {
  return oneLine([c.firstName, c.lastName].filter((p) => p && p.trim()).join(' ')) || '(no name recorded)'
}

/** "Jo Bloggs (CTO) at rentman.io" — never their address. */
function personLabel(c: Pick<ContactRow, 'firstName' | 'lastName' | 'title'>, domain: string): string {
  const title = oneLine(c.title, 60)
  return `${nameOf(c)}${title ? ` (${title})` : ''} at ${domain}`
}

/**
 * The same, with the id the contact tools take as `contactId`. The model
 * reads only a tool's summary, never its data (the MCP adapter hands it
 * `summary` alone), so an id it needs for a later call is printed here.
 */
function personWithId(c: Pick<ContactRow, 'id' | 'firstName' | 'lastName' | 'title'>, domain: string): string {
  return `${personLabel(c, domain)} — id ${c.id}`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A zod issue in the route's own words: "<field>: <message>". */
function issueWords(error: z.ZodError): string {
  const first = error.issues[0]
  return `${first?.path.join('.') || 'input'}: ${first?.message ?? 'Invalid.'}`
}

// ---------------------------------------------------------------------------
// Finding a company and a person — in this org, and answered alike when not
// ---------------------------------------------------------------------------

/**
 * The company by domain, in this org. Another org's company of the same
 * domain is answered exactly as one that does not exist.
 */
async function companyByDomain(ctx: ToolContext, raw: string): Promise<{ ok: true; company: Company } | Refusal> {
  const domain = normaliseDomain(raw)
  if (!domain) return refuse('not_found', `"${oneLine(raw, 100)}" is not a domain.`)
  const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
  if (!company) return refuse('not_found', `No company with domain "${oneLine(domain, 100)}" is in the CRM.`)
  return { ok: true, company }
}

/** The way every contact tool names a person: by id, or by the email address on file — one of the two. */
const personShape = {
  contactId: z
    .uuid()
    .optional()
    .describe('Who, by the contact id list_contacts or search_crm gave. Give this or contactEmail, not both.'),
  contactEmail: z
    .string()
    .max(254)
    .optional()
    .describe(
      'Who, by their email address on file, as the person you are helping gave it (the tools print an address ' +
        'by its domain only). Give this or contactId, not both.',
    ),
}

interface FoundContact {
  readonly ok: true
  readonly contact: ContactRow
  readonly domain: string
  /** The zone quiet hours fall back to for a person with none of their own. */
  readonly companyTimeZone: string | null
  /** As recorded: whether a number written without +91 is read as India's. */
  readonly companyCountry: string | null
}

/**
 * One person in THIS org, by id or by address. A contact of another org —
 * by its id or its address — is answered exactly like nobody, and the
 * caller writes nothing.
 */
async function contactFor(
  ctx: ToolContext,
  input: { readonly contactId?: string | undefined; readonly contactEmail?: string | undefined },
): Promise<FoundContact | Refusal> {
  const byId = input.contactId !== undefined
  const byEmail = input.contactEmail !== undefined && input.contactEmail.trim() !== ''
  if (byId === byEmail) {
    return refuse('invalid_state', `Name the person by contactId or by contactEmail — exactly one of the two. ${UNCHANGED}`)
  }
  let match: SQL
  if (byId) {
    match = eq(schema.contacts.id, input.contactId!)
  } else {
    const email = normaliseEmail(input.contactEmail!)
    if (!email) return refuse('not_found', `That could not be read as an email address, so it names nobody in the CRM. ${UNCHANGED}`)
    match = sql`lower(${schema.contacts.email}) = ${email}`
  }
  const rows = await ctx.db
    .select({
      contact: schema.contacts,
      domain: schema.companies.domain,
      companyTimeZone: schema.companies.timeZone,
      companyCountry: schema.companies.country,
    })
    .from(schema.contacts)
    .innerJoin(
      schema.companies,
      and(eq(schema.companies.id, schema.contacts.companyId), eq(schema.companies.orgId, ctx.orgId)),
    )
    .where(and(eq(schema.contacts.orgId, ctx.orgId), match))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return refuse(
      'not_found',
      byId ? `No contact with that id is in the CRM. ${UNCHANGED}` : `Nobody with that email address is in the CRM. ${UNCHANGED}`,
    )
  }
  return {
    ok: true, contact: row.contact, domain: row.domain, companyTimeZone: row.companyTimeZone, companyCountry: row.companyCountry,
  }
}

/**
 * A domain the agent may add: one the scanner would request, and never the
 * booking page's `<address>.inbound` placeholder — a company named after a
 * person who booked from a personal address, which names no website (the
 * rescan never picks one either). The reason has no tail: a single add and
 * a list each say what was written.
 */
function addableDomain(raw: string): { ok: true; domain: string } | Refusal {
  const domain = normaliseDomain(raw)
  if (!domain) return refuse('invalid_state', `"${oneLine(raw, 100)}" is not a domain.`)
  if (domain.endsWith('.inbound')) {
    return refuse(
      'not_permitted',
      `"${oneLine(domain, 100)}" is the booking page’s placeholder for a person who booked from a personal address, ` +
        'not a company’s website.',
    )
  }
  if (!isScannableHost(domain)) {
    return refuse(
      'not_permitted',
      `"${oneLine(domain, 100)}" is not a public hostname. A company is added by the domain of its own public ` +
        'website — the scanner refuses anything else: an IP address, localhost, a reserved or internal name.',
    )
  }
  return { ok: true, domain }
}

/** `companiesUpdate`'s sentence for a zone the runtime does not know, and `createContact`'s. */
const unknownZone = (zone: string): string =>
  `"${oneLine(zone, 64)}" is not a timezone this system recognises. Use an IANA name like Europe/London.`

// ---------------------------------------------------------------------------
// True data only (2026-10-13): where an address, a person and a website came from
// ---------------------------------------------------------------------------

/** What an address is recorded as having come from, as the `contact.created` row names it: a kind, never the page. */
type SourceKind = 'page' | 'chat' | 'connector'

/** An address as it will be stored, with where it came from. */
interface Sourced {
  /** Normalised: a lower-case address, or E.164. */
  readonly value: string
  /** In core's ADDRESS_SOURCE_PATTERN, or null when nothing could be asked (a test, a script). */
  readonly source: string | null
  readonly kind: SourceKind | null
  /** The page that showed it, for the check that it names the person too. */
  readonly page: string | null
  /** Something the reader could not check just now, said in the summary. */
  readonly note: string | null
}

/** What the model gave for one address: its value as typed, a handle, a page it says shows it. */
interface AddressClaim {
  readonly raw?: string | undefined
  readonly from?: string | undefined
  readonly sourceUrl?: string | undefined
}

const given = (v: string | undefined): string | null => (v !== undefined && v.trim() !== '' ? v.trim() : null)

/** Pages read during one call, so the address check and the name check read each once. */
type PageReads = Map<string, Promise<PageRead>>

function readOnce(ctx: ToolContext, pages: PageReads, url: string, signal: AbortSignal): Promise<PageRead> {
  let read = pages.get(url)
  if (!read) {
    read = ctx.web
      ? readWithin(ctx.web, url, signal)
      : Promise.resolve<PageRead>({ ok: false, url, why: 'unreachable', detail: 'No page reader in this run.' })
    pages.set(url, read)
  }
  return read
}

/** The words of a page a check reads: its title, its words and its HTML (a `mailto:` or `tel:` link shows an address its words may not). */
const pageHaystack = (p: Extract<PageRead, { ok: true }>): string => `${p.title ?? ''}\n${p.text}\n${p.html}`

const NOT_SHOWN_EMAIL = (masked: string): string =>
  `${masked} appears nowhere in this conversation — not in anything the person typed, a page you read or a tool’s ` +
  'result. An address is never composed from a name or a pattern (first@domain, info@…). Use find_contact_details ' +
  'or read_page on a page that shows it, or ask the person.'
const NOT_SHOWN_PHONE = (masked: string): string =>
  `${masked} appears nowhere in this conversation — not in anything the person typed, a page you read or a tool’s ` +
  'result. A number is never guessed or completed. Use find_contact_details or read_page on a page that shows it, ' +
  'or ask the person.'
const STALE_HANDLE = (raw: string): string =>
  `"${oneLine(raw, 24)}" is not a handle from a page read in the last two hours. Read the page again (read_page or ` +
  'find_contact_details) and use the handle it gives.'
/**
 * One of our readers (read_page, find_contact_details) showed it — a role inbox
 * is shown whole — but more than two hours ago, so the handle that remembered
 * its page is gone. Saying it appears nowhere would be false, and would invite
 * a guess.
 */
const HANDLE_EXPIRED = (masked: string): string =>
  `${masked} was shown by a page read more than two hours ago, and the handle that remembered which page has ` +
  'expired. Read the page again (read_page or find_contact_details) and give the handle it prints, so it is stored ' +
  'with where it came from.'

/** Whether only the agency's own readers of the open web showed a value — never the person, never a connector. */
function shownByOurReaderOnly(origins: readonly SeenOrigin[]): boolean {
  return origins.length > 0 && origins.every((o) => o.kind === 'tool' && serverOf(o.tool) === 'agency') && origins.some(showsIt)
}

const NEEDS_A_READER =
  'A page given as where it came from is read to check that it shows it, and the page reader runs in the worker, ' +
  'which this run does not have. Give the value without a source, or ask the person.'

/** A page address as the model gave it: a bare host is read over https. Null for anything that is not one. */
function sourcePageUrl(raw: string): URL | null {
  const text = raw.trim()
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/**
 * Where one email address or phone number came from — or why it may not be
 * stored. In order: a handle a page read gave (its page is the source); a
 * page the model names, read now and required to show it; a page this org's
 * tools already saw it on; the person's own words (`chat`); a connector's
 * result (`connector:<server>`). Our own tools' answers do not count: they
 * show a person's address only by its handle, so an address found there
 * whole was typed by the model. Nothing shows it: refused, nothing written.
 *
 * An email's domain is then asked whether it receives mail at all: one that
 * cannot ("no_domain", "no_mail") makes the address a guess that can never
 * arrive, and is refused; a resolver that could not answer is let through
 * with a note.
 */
async function sourcedAddress(
  ctx: ToolContext,
  which: 'email' | 'phone',
  claim: AddressClaim,
  phoneOpts: FindPhonesOptions,
  pages: PageReads,
  signal: AbortSignal,
): Promise<{ ok: true; sourced: Sourced | null } | Refusal> {
  const raw = given(claim.raw)
  const from = given(claim.from)
  const sourceUrl = given(claim.sourceUrl)
  const what = which === 'email' ? 'email address' : 'phone number'
  const norm = (v: string): string | null => (which === 'email' ? normaliseEmail(v) : normalisePhone(v))
  const mask = (v: string): string => (which === 'email' ? maskAddress(v) : maskPhone(v))
  const now = ctx.now().getTime()

  let sourced: Omit<Sourced, 'note'> | null = null
  if (from) {
    const hit = foundByHandle(ctx.orgId, from, now)
    if (!hit) return refuse('invalid_state', STALE_HANDLE(from))
    if (hit.kind !== which) {
      return refuse(
        'invalid_state',
        `${hit.handle} stands for ${hit.kind === 'email' ? 'an email address' : 'a phone number'}, not ` +
          `${which === 'email' ? 'an email address' : 'a phone number'}.`,
      )
    }
    if (raw && norm(raw) !== hit.value) {
      return refuse('invalid_state', `The ${what} given is not the one ${hit.handle} stands for. Give the handle alone.`)
    }
    sourced = { value: hit.value, source: hit.url, kind: 'page', page: hit.url }
  } else if (raw) {
    const value = norm(raw)
    // One that cannot be read is refused by the writer, in the route's words.
    if (!value) return { ok: true, sourced: null }
    if (sourceUrl) {
      if (!ctx.web) return refuse('unreachable', NEEDS_A_READER)
      const url = sourcePageUrl(sourceUrl)
      if (!url) return refuse('invalid_state', `"${oneLine(sourceUrl, 120)}" is not a web page’s address.`)
      const problem = readablePathProblem(url)
      if (problem) return refuse('not_permitted', problem)
      // As read_page asks first: an IP address, localhost or a reserved name is never read.
      if (!isScannableHost(url.hostname.toLowerCase())) {
        return refuse('not_permitted', `"${oneLine(url.hostname, 100)}" is not a public website, so it is never read.`)
      }
      const page = await readOnce(ctx, pages, url.toString(), signal)
      if (!page.ok) {
        return refuse(
          'unreachable',
          `${pageLabel(url.toString())} could not be read (${oneLine(page.detail, 160)}), so it cannot show that ${what}.`,
        )
      }
      const shown =
        which === 'email' ? textShowsEmail(pageHaystack(page), value) : textShowsPhone(pageHaystack(page), value, phoneOpts)
      if (!shown) {
        return refuse(
          'invalid_state',
          `${mask(value)} does not appear on ${pageLabel(page.finalUrl)}. Name the page that shows it — or use ` +
            'find_contact_details or read_page and give the handle they print.',
        )
      }
      const source = pageSource(page.finalUrl) ?? pageSource(url.toString())
      if (!source) return refuse('invalid_state', `${pageLabel(page.finalUrl)}’s address is too long to record as a source.`)
      sourced = { value, source, kind: 'page', page: page.finalUrl }
    } else {
      const hit = foundByValue(ctx.orgId, which, value, now)
      if (hit) {
        sourced = { value, source: hit.url, kind: 'page', page: hit.url }
      } else if (ctx.conversation) {
        const test =
          which === 'email' ? (t: string) => textShowsEmail(t, value) : (t: string) => textShowsPhone(t, value, phoneOpts)
        const origins = await within(() => ctx.conversation!.find(test), signal)
        if (origins === 'late' || origins === 'failed') {
          return refuse('unreachable', `Whether this conversation showed that ${what} could not be checked just now. Try again.`)
        }
        const server = origins
          .map((o) => (o.kind === 'tool' ? serverOf(o.tool) : null))
          .find((s): s is string => s !== null && s !== 'agency')
        if (origins.some((o) => o.kind === 'person')) sourced = { value, source: 'chat', kind: 'chat', page: null }
        else if (server) sourced = { value, source: connectorSource(server), kind: 'connector', page: null }
        else if (shownByOurReaderOnly(origins)) return refuse('invalid_state', HANDLE_EXPIRED(mask(value)))
        else return refuse('not_permitted', which === 'email' ? NOT_SHOWN_EMAIL(mask(value)) : NOT_SHOWN_PHONE(mask(value)))
      } else {
        sourced = { value, source: null, kind: null, page: null }
      }
    }
  } else if (sourceUrl) {
    return refuse('invalid_state', `A source was given for a ${what}, but no ${what}. Give it (or its handle) with the source.`)
  } else {
    return { ok: true, sourced: null }
  }

  let note: string | null = null
  if (which === 'email' && ctx.web) {
    const web = ctx.web
    const domain = sourced.value.slice(sourced.value.lastIndexOf('@') + 1)
    const mail = await within(() => web.mailHosts(domain), signal)
    if (mail !== 'late' && mail !== 'failed' && !mail.ok && (mail.why === 'no_domain' || mail.why === 'no_mail')) {
      return refuse(
        'invalid_state',
        `${domain} receives no email — there is no mail server for it, so nothing sent there can arrive. Find the ` +
          'address the business publishes (find_contact_details), or ask the person.',
      )
    }
    if (mail === 'late' || mail === 'failed' || !mail.ok) note = `Whether ${domain} receives mail could not be checked just now.`
  }
  return { ok: true, sourced: { ...sourced, note } }
}

/** "seen on 127atelier.in/pages/contact" — or that nothing was recorded. */
function sourceWords(s: Sourced | null): string {
  return addressSourceWords(s?.source ?? null).words
}

/** The same, as a sentence of its own. */
function sourceSentence(s: Sourced | null): string {
  return s?.source ? `It was ${addressSourceWords(s.source).words}.` : 'Where it came from was not recorded.'
}

/**
 * Whether this conversation — or a page an address came from — names the
 * person: every part of their name of two letters or more, as a whole word.
 * A role ("VP Engineering at carbonmaps") is never a reason to make one up.
 */
async function personShown(
  ctx: ToolContext,
  first: string | null,
  last: string | null,
  pageUrls: readonly string[],
  pages: PageReads,
  signal: AbortSignal,
): Promise<boolean | 'late'> {
  if (!ctx.conversation || !hasNameParts(first, last)) return true
  const origins = await within(() => ctx.conversation!.find((t) => textNamesPerson(t, first, last)), signal)
  if (origins === 'late') return 'late'
  if (origins !== 'failed' && origins.some(showsIt)) return true
  for (const url of pageUrls) {
    const page = await readOnce(ctx, pages, url, signal)
    if (page.ok && textNamesPerson(`${page.title ?? ''}\n${page.text}`, first, last)) return true
  }
  return false
}

const NOT_SHOWN_PERSON = (name: string, fromPage: boolean): string =>
  `Nobody called ${oneLine(name, 80)} appears in this conversation${fromPage ? ' or on the page their address came from' : ''} ` +
  '— not in anything the person typed, a page you read or a tool’s result; never invent a person to fill a role. ' +
  'Add the business’s own published address without a name, or ask the person who to write to.'

/** Whether this conversation showed this LinkedIn profile (its `in/<slug>`). */
async function linkedinShown(ctx: ToolContext, key: string, signal: AbortSignal): Promise<boolean | 'late'> {
  if (!ctx.conversation) return true
  const origins = await within(() => ctx.conversation!.find((t) => textShowsLinkedIn(t, key)), signal)
  if (origins === 'late') return 'late'
  return origins !== 'failed' && origins.some(showsIt)
}

const NOT_SHOWN_LINKEDIN = (key: string): string =>
  `linkedin.com/${key} appears nowhere in this conversation — not in anything the person typed, a page you read or ` +
  'a tool’s result. A profile is never composed from a name. Use the one a search or a page showed, or ask the person.'

const OUT_OF_TIME = 'It could not be checked in time — try again.'

/**
 * A writer's sentence with each address the model holds only by its HANDLE
 * put back behind its mask. `createContact` and `contactsUpdate` quote the
 * address they refuse ("… is already a contact in this CRM"), and read_page
 * and find_contact_details never hand a person's whole address to the model;
 * a refusal must not do it for them. An address the model typed whole is its
 * own words, and is quoted as before.
 */
function maskHeld(message: string, held: ReadonlyArray<{ readonly which: 'email' | 'phone'; readonly value: string } | null>): string {
  let out = message
  for (const h of held) {
    if (!h) continue
    const masked = h.which === 'email' ? maskAddress(h.value) : maskPhone(h.value)
    out = out.replace(new RegExp(h.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), masked)
  }
  return out
}

/** An address by handle, or the page that shows it (2026-10-13). */
const addressFields = {
  from: z.string().max(24),
  source: z.string().max(2048),
}

// ---------------------------------------------------------------------------
// list_contacts
// ---------------------------------------------------------------------------

const CONSENT_CHANNEL_WORDS: Record<ConsentLedger['channels'][number]['channel'], string> = {
  email: 'email',
  sms: 'SMS',
  voice: 'voice',
  whatsapp: 'WhatsApp',
}

/** As recorded. A refusal is final until an owner lifts it, so it reads louder than the rest. */
const CONSENT_WORDS: Record<ConsentLedger['channels'][number]['state'], string> = {
  granted: 'granted',
  refused: 'REFUSED',
  never_asked: 'never asked',
}

/** `unreadable` is its own answer and never reads as clear (§2.1). */
const STANDING_WORDS: Record<ConsentLedger['suppression']['email'], string> = {
  suppressed: 'ON THE LIST',
  clear: 'clear',
  unparseable: 'unreadable — treated as on the list',
  none: 'none on file',
}

/** What each pause class means for whoever reads it, and what lifts it — never the reason's words. */
const PAUSE_WORDS: Record<PauseReasonClass, string> = {
  replied: 'their reply paused them; answering it from /inbox or resume_contact lifts it',
  manual: 'a teammate’s hold; resume_contact lifts it',
  unsubscribed: 'they unsubscribed — their opt-out; do not suggest resuming them',
  opt_out_not_recorded:
    'they asked to stop and the opt-out could not be recorded; it is recorded on /suppressions, never resumed',
  erasure: 'their erasure did not finish; an owner finishes it on /contacts, never resumes it',
  other: 'paused for another reason, which /contacts shows; resume_contact lifts it if that is right',
}

/**
 * The pause, by its class and what lifts it. A shared number's hold is its
 * own sentence (it may not have been them), and a holder whose own pause
 * stood hears that Resume waits for the number (`sharedNumberHold`, the
 * ledger's reading of the gate `contactResumeByHand` asks).
 */
function pauseWords(pausedAt: Date, reason: string | null, sharedNumberHold: boolean): string {
  const pausedFor = pauseReasonClass(reason)
  const head = `PAUSED since ${when(pausedAt)} (pausedFor: ${pausedFor})`
  if (isSharedNumberOptOutPause(reason)) {
    return (
      `${head} — a text from a phone number they share with another contact asked to stop and could not be ` +
      'recorded; it may not have been them. resume_contact is refused until the number is recorded on /suppressions'
    )
  }
  if (!sharedNumberHold) return `${head} — ${PAUSE_WORDS[pausedFor]}`
  const lifts = pausedFor === 'replied' ? 'neither answering their reply nor resume_contact lifts it' : 'resume_contact is refused'
  return (
    `${head} — ${PAUSE_WORDS[pausedFor]}; but they also hold a phone number a text asked to stop from, which could ` +
    `not be recorded, so ${lifts} until the number is recorded on /suppressions`
  )
}

interface ContactView {
  readonly contactId: string
  readonly name: string
  readonly title: string | null
  /** Masked to its domain. */
  readonly email: string | null
  readonly hasPhone: boolean
  readonly hasLinkedIn: boolean
  readonly timeZone: string | null
  /** Whose zone quiet hours are checked in; null when neither has one. */
  readonly zoneFrom: 'contact' | 'company' | null
  readonly consent: Record<ConsentLedger['channels'][number]['channel'], ConsentLedger['channels'][number]['state']>
  readonly suppression: { readonly email: string; readonly phone: string; readonly linkedin: string }
  readonly paused: boolean
  readonly pausedAt: string | null
  readonly pausedFor: PauseReasonClass | null
  readonly sharedNumberHold: boolean
  readonly emailBounced: { readonly at: string; readonly code: string | null } | null
}

function contactView(r: LedgerRow, ledger: ConsentLedger): ContactView {
  const consent = Object.fromEntries(ledger.channels.map((c) => [c.channel, c.state])) as ContactView['consent']
  return {
    contactId: r.id,
    name: nameOf(r),
    title: oneLine(r.title, 60) || null,
    email: maskEmail(r.email),
    hasPhone: !!r.phone,
    hasLinkedIn: !!r.linkedinUrl,
    timeZone: r.timeZone ?? r.companyTimeZone ?? null,
    zoneFrom: r.timeZone ? 'contact' : r.companyTimeZone ? 'company' : null,
    consent,
    suppression: {
      email: ledger.suppression.email,
      phone: ledger.suppression.phone,
      linkedin: ledger.suppression.linkedin,
    },
    paused: r.pausedAt !== null,
    pausedAt: r.pausedAt?.toISOString() ?? null,
    pausedFor: r.pausedAt !== null ? pauseReasonClass(r.pausedReason) : null,
    sharedNumberHold: ledger.sharedNumberHold,
    emailBounced: r.emailBouncedAt ? { at: r.emailBouncedAt.toISOString(), code: r.emailBounceCode } : null,
  }
}

function contactLine(v: ContactView, r: LedgerRow, ledger: ConsentLedger): string {
  const reach = [
    v.email ? `email ${v.email}` : null,
    v.hasPhone ? 'phone on file' : null,
    v.hasLinkedIn ? 'LinkedIn on file' : null,
  ].filter(Boolean)
  const zone =
    v.zoneFrom === 'contact'
      ? `zone ${oneLine(v.timeZone, 64)}`
      : v.zoneFrom === 'company'
        ? `zone ${oneLine(v.timeZone, 64)} (the company’s)`
        : 'NO TIME ZONE — nothing can be sent to them until one is set'
  const consent = ledger.channels.map((c) => `${CONSENT_CHANNEL_WORDS[c.channel]} ${CONSENT_WORDS[c.state]}`).join(', ')
  const standing = (
    [
      ['email', ledger.suppression.email],
      ['phone', ledger.suppression.phone],
      ['LinkedIn', ledger.suppression.linkedin],
    ] as const
  )
    .filter(([, s]) => s !== 'none')
    .map(([label, s]) => `${label} ${STANDING_WORDS[s]}`)
    .join(', ')
  const parts = [
    `${v.name}${v.title ? ` (${v.title})` : ''}`,
    `id ${v.contactId}`,
    reach.length ? reach.join(', ') : 'no way to reach them on file',
    zone,
    `consent: ${consent}`,
    `suppression: ${standing || 'nothing on file to check'}`,
    r.pausedAt ? pauseWords(r.pausedAt, r.pausedReason, ledger.sharedNumberHold) : 'not paused',
    ...(r.emailBouncedAt
      ? [
          `email BOUNCED ${when(r.emailBouncedAt)}${r.emailBounceCode ? ` (${oneLine(r.emailBounceCode, 12)})` : ''} — ` +
            'correcting the address lifts it',
        ]
      : []),
  ]
  return `  ${parts.join(' · ')}`
}

const listContactsShape = {
  domain: z.string().min(1).max(253).describe('The company whose people to list, by its domain, e.g. "rentman.io".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many people, in the order they were recorded. Default 20, at most 50.'),
}

export const listContacts: AgencyToolSpec<typeof listContactsShape> = {
  name: 'list_contacts',
  description:
    'Read the people recorded at one company: each one’s id (which update_contact, pause_contact and ' +
    'resume_contact take), name and title, how they can be reached (an email shown by its domain only), their ' +
    'time zone, consent per channel as recorded, where they stand on the suppression list, whether they are ' +
    'paused and by what (pausedFor), and a bounced address. A read; it changes nothing and sends nothing.',
  shape: listContactsShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The /contacts page's own gate.
    if (!can(ctx.principal, 'contacts:read')) {
      return fail('not_permitted', 'The person you are helping cannot read contacts.')
    }
    const found = await companyByDomain(ctx, input.domain)
    if (!found.ok) return fail(found.code, found.message)
    const { company } = found

    const limit = input.limit ?? 20
    // One more than asked, so the answer can say there are more.
    const rows = await contactsLedger(ctx.db, ctx.orgId, { companyId: company.id, limit: limit + 1 })
    const more = rows.length > limit
    // What /contacts reads per row: the consent ledger, which `get_consent` reads too.
    const read = await Promise.all(
      rows.slice(0, limit).map(async (r) => ({ r, ledger: await consentLedgerFor(ctx.db, ctx.orgId, r.id) })),
    )
    // Deleted between the two reads: not shown, rather than shown half-known.
    const people = read.flatMap(({ r, ledger }) => (ledger ? [{ r, ledger, view: contactView(r, ledger) }] : []))

    await ctx.audit('agent.list_contacts', { companyId: company.id, returned: people.length, more })

    const domain = company.domain
    if (people.length === 0) {
      return ok(
        { companyId: company.id, domain, contacts: [], more: false },
        `Nobody is recorded at ${domain}. add_contact records a person. A read: nothing was changed and nothing was sent.`,
      )
    }
    return ok(
      { companyId: company.id, domain, contacts: people.map((p) => p.view), more },
      bounded([
        `${plural(people.length, 'person', 'people')} recorded at ${domain}` +
          (more ? ` — more are recorded than shown; raise limit (at most 50), or read /contacts` : '') +
          '. A read: nothing was changed and nothing was sent.',
        'Each id is the contactId update_contact, pause_contact and resume_contact take. Addresses are shown by ' +
          'their domain only. Consent is as recorded — never asked is a no everywhere except cold email, and ' +
          'LinkedIn has no consent row. A pause is shown by its class (pausedFor), which resume_contact takes ' +
          'back; why they were paused is on /contacts.',
        ...people.map((p) => contactLine(p.view, p.r, p.ledger)),
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// add_company
// ---------------------------------------------------------------------------

const companyNameField = z.string().max(160)
const companyCountryField = z.string().max(80)
const companyZoneField = z.string().max(64)

/**
 * What a company is, from research (0021): the fields add_company,
 * update_company and import_companies take beside the name, country and zone.
 * A headcount is a claim, never an observation, so it is given with where it
 * came from; a recorded headcount above the active profile's maximum makes
 * the next scan's score `enterprise_scale`.
 */
const firmographicFields = {
  industry: z.string().max(80).describe('Its sector, briefly, e.g. "fintech — payments" or "B2B SaaS — HR".'),
  city: z.string().max(80).describe('The city of its main office, e.g. "Bengaluru".'),
  headcount: z
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .describe('Roughly how many people work there, as a whole number — the middle of a range like "51-200" is fine.'),
  headcountSource: z
    .string()
    .max(300)
    .describe('Where the headcount came from: a URL (its LinkedIn page, a directory) or a short note. Give one with every headcount.'),
  stage: z.enum(COMPANY_STAGES).describe(`Its funding stage: ${COMPANY_STAGES.join(', ')}.`),
  description: z.string().max(600).describe('One or two sentences on what it sells and to whom, from its own site.'),
}

type FirmographicInput = {
  industry?: string | undefined
  city?: string | undefined
  headcount?: number | null | undefined
  headcountSource?: string | undefined
  stage?: (typeof COMPANY_STAGES)[number] | null | undefined
  description?: string | undefined
}

/** The firmographic keys of an input that were given, for `companiesUpdate`. */
function firmographicPatch(input: FirmographicInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['industry', 'city', 'headcount', 'headcountSource', 'stage', 'description'] as const) {
    if (input[key] !== undefined) out[key] = input[key]
  }
  return out
}

/**
 * Where a business is reached when it has no website, or beside one
 * (2026-10-13): its main phone line and its street address, as a listing or
 * a page showed them. Stored only on a company this call creates.
 */
const companyReachFields = {
  website: z
    .string()
    .min(1)
    .max(253)
    .describe(
      'Its own website — a domain or URL this conversation showed — or "none" when no website of its own was seen: ' +
        'then name and city (or address) are required, and it is filed under a placeholder that is never scanned. ' +
        'Never a domain you composed, and never a business.site address (shut down in 2024).',
    ),
  phone: z
    .string()
    .max(40)
    .describe('Its main phone line, exactly as the person, a listing or a page showed it — e.g. +91 98765 43210.'),
  phoneFrom: addressFields.from.describe('Its phone by the handle read_page or find_contact_details printed (P-…), instead of phone.'),
  address: z.string().max(300).describe('Its street address, as its listing or a page shows it.'),
}

const addCompanyShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe(
      'The company’s own public website domain, e.g. "rentman.io" — one this conversation showed. A URL is read for ' +
        'its host. Give this or website.',
    ),
  website: companyReachFields.website.optional(),
  name: companyNameField.optional().describe('The company’s name, as it was shown.'),
  country: companyCountryField.optional().describe('Its country, as people write it. Never used to guess a time zone.'),
  timeZone: companyZoneField
    .optional()
    .describe(
      'Its IANA time zone, e.g. Europe/Amsterdam. Quiet hours fall back to it for people here who have none of their own.',
    ),
  industry: firmographicFields.industry.optional(),
  city: firmographicFields.city.optional(),
  headcount: firmographicFields.headcount.optional(),
  headcountSource: firmographicFields.headcountSource.optional(),
  stage: firmographicFields.stage.optional(),
  description: firmographicFields.description.optional(),
  phone: companyReachFields.phone.optional(),
  phoneFrom: companyReachFields.phoneFrom.optional(),
  address: companyReachFields.address.optional(),
}

const COMPANY_FIELD_WORDS: Record<string, string> = {
  name: 'name',
  country: 'country',
  timeZone: 'time zone',
  industry: 'industry',
  city: 'city',
  stage: 'stage',
  headcount: 'headcount',
  headcountSource: 'headcount source',
  description: 'description',
}

/** "named Rentman, in the Netherlands, time zone Europe/Amsterdam, …" — what the row says now. */
function companyFacts(c: Company): string {
  return [
    c.name ? `named ${oneLine(c.name, 80)}` : 'no name recorded',
    c.country ? `country ${oneLine(c.country, 60)}` : 'no country recorded',
    c.timeZone ? `time zone ${oneLine(c.timeZone, 64)}` : 'no time zone',
    ...(c.industry ? [`industry ${oneLine(c.industry, 80)}`] : []),
    ...(c.city ? [`city ${oneLine(c.city, 80)}`] : []),
    ...(c.stage ? [`stage ${c.stage}`] : []),
    ...(c.headcount !== null
      ? [`~${c.headcount.toLocaleString('en')} staff${c.headcountSource ? ` (per ${oneLine(c.headcountSource, 120)})` : ''}`]
      : []),
  ].join(', ')
}

/** Where a new company is filed: a domain somebody showed, or — for a business with none of its own — a placeholder. */
interface CompanyTarget {
  readonly ok: true
  readonly domain: string
  /** Filed as website "none", under `noSiteDomain`: never scanned, never resolved. */
  readonly none: boolean
}

/**
 * The domain a company is added under, from `domain` or `website` (exactly
 * one). Website "none" files a business with no website of its own under
 * `noSiteDomain`, told apart from a namesake by its name and where it is — so
 * it needs a name, and a city or an address. A real domain must be one the
 * scanner would request, and never the booking page's `.inbound` placeholder
 * (`addableDomain`); whether it was SHOWN, and answers, is `websiteCheck`'s.
 */
function companyTarget(input: {
  readonly domain?: string | undefined
  readonly website?: string | undefined
  readonly name?: string | undefined
  readonly city?: string | undefined
  readonly address?: string | undefined
}): CompanyTarget | Refusal {
  const domain = given(input.domain)
  const website = given(input.website)
  if (!!domain === !!website) {
    return refuse(
      'invalid_state',
      'Give the company’s website as domain or as website — exactly one of the two. website "none" files a business ' +
        'with no website of its own.',
    )
  }
  const site = (website ?? domain)!
  if (site.toLowerCase() === 'none') {
    const name = given(input.name)
    if (!name) {
      return refuse('invalid_state', 'A business with no website of its own is filed by its name: give name, and its city or address.')
    }
    const city = given(input.city)
    const address = given(input.address)
    if (!city && !address) {
      return refuse(
        'invalid_state',
        `${oneLine(name, 80)} has no website of its own, so it is told apart from businesses of the same name by where ` +
          'it is: give its city or its address.',
      )
    }
    const id = (v: string | null): string => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    return { ok: true, domain: noSiteDomain(name, `name:${id(name)}|${id(city)}|${id(address)}`), none: true }
  }
  const addable = addableDomain(site)
  if (!addable.ok) return addable
  return { ok: true, domain: addable.domain, none: false }
}

/** A company's phone as it will be stored (E.164), and where it came from — or why not. */
async function companyPhone(
  ctx: ToolContext,
  input: { readonly phone?: string | undefined; readonly phoneFrom?: string | undefined },
  opts: FindPhonesOptions,
  signal: AbortSignal,
): Promise<{ ok: true; value: string | null; source: string | null } | Refusal> {
  const raw = given(input.phone)
  const from = given(input.phoneFrom)
  const now = ctx.now().getTime()
  if (from) {
    const hit = foundByHandle(ctx.orgId, from, now)
    if (!hit) return refuse('invalid_state', STALE_HANDLE(from))
    if (hit.kind !== 'phone') return refuse('invalid_state', `${hit.handle} stands for an email address, not a phone number.`)
    if (raw && phoneValue(raw, opts) !== hit.value) {
      return refuse('invalid_state', `The phone number given is not the one ${hit.handle} stands for. Give the handle alone.`)
    }
    return { ok: true, value: hit.value, source: hit.url }
  }
  if (!raw) return { ok: true, value: null, source: null }
  const value = phoneValue(raw, opts)
  if (!value) return refuse('invalid_state', PHONE_UNREADABLE(raw))
  const hit = foundByValue(ctx.orgId, 'phone', value, now)
  if (hit) return { ok: true, value, source: hit.url }
  if (!ctx.conversation) return { ok: true, value, source: null }
  const origins = await within(() => ctx.conversation!.find((t) => textShowsPhone(t, value, opts)), signal)
  if (origins === 'late' || origins === 'failed') return refuse('unreachable', OUT_OF_TIME)
  // As for a person's number: our own tools show a number only by its handle, so one seen whole there was typed by the model.
  const person = origins.some((o) => o.kind === 'person')
  const server = origins
    .map((o) => (o.kind === 'tool' ? serverOf(o.tool) : null))
    .find((s): s is string => s !== null && s !== 'agency')
  if (!person && !server) {
    if (shownByOurReaderOnly(origins)) return refuse('invalid_state', HANDLE_EXPIRED(maskPhone(value)))
    return refuse('not_permitted', NOT_SHOWN_PHONE(maskPhone(value)))
  }
  return { ok: true, value, source: person ? 'chat' : connectorSource(server!) }
}

/** The fields a new company's reach facts changed, for the route's `company.updated` row beside the rest. */
async function setReach(
  ctx: ToolContext,
  companyId: string,
  phone: string | null,
  address: string | null,
): Promise<{ ok: true; company: Company | null; changed: string[] } | { ok: false; message: string }> {
  if (!phone && !address) return { ok: true, company: null, changed: [] }
  const r = await companiesSetReachFacts(ctx.db, ctx.orgId, companyId, {
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
  })
  return r.ok ? { ok: true, company: r.company, changed: r.changed } : { ok: false, message: r.message }
}

export const addCompany: AgencyToolSpec<typeof addCompanyShape> = {
  name: 'add_company',
  description:
    'Add one company to the CRM by the domain of its own public website — one this conversation showed (the person, ' +
    'a search result or a page) — or, for a business with no website of its own, with website "none" and its name ' +
    'and city or address. With what you know of it: name, country, IANA time zone, industry, city, headcount (with ' +
    'where that number came from), stage, a one-line description, and its phone and address as they were shown. A ' +
    'company already there is left exactly as it is — update_company changes it. Nothing is scanned (scan_company ' +
    'does that), and nothing is sent.',
  shape: addCompanyShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The import page's own gate.
    if (!can(ctx.principal, 'companies:write')) {
      return fail('not_permitted', `The person you are helping cannot add companies. ${NOTHING_SENT}`)
    }
    const target = companyTarget(input)
    if (!target.ok) return fail(target.code, `${target.message} Nothing was added.`)
    const { domain } = target

    // The country and zone are checked as `companiesUpdate` checks them, BEFORE
    // anything is written: a refused zone must not leave a company half-added.
    const extras = companyPatchInput.safeParse({
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...firmographicPatch(input),
    })
    if (!extras.success) return fail('invalid_state', `${issueWords(extras.error)} Nothing was added.`)
    if (extras.data.timeZone && !isKnownTimeZone(extras.data.timeZone)) {
      return fail('invalid_state', `${unknownZone(extras.data.timeZone)} Nothing was added.`)
    }
    if (extras.data.headcountSource && extras.data.headcount === undefined) {
      return fail('invalid_state', 'A headcount source needs the headcount it is for. Nothing was added.')
    }

    const existing = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (existing) {
      await ctx.audit('agent.add_company', { companyId: existing.id, created: false })
      return ok(
        { companyId: existing.id, domain, created: false },
        `${domain} is already in the CRM (${companyFacts(existing)}); nothing was changed. update_company changes ` +
          `what is recorded about it. ${NOTHING_SENT}`,
      )
    }

    // True data only: the phone was shown, and the website was shown and answers.
    const phoneOpts = phoneOptsFor({ country: input.country ?? null, domain })
    let note: string | null = null
    let phone: { value: string | null; source: string | null }
    const clock = deadline(WEB_WORK_MS)
    try {
      const p = await companyPhone(ctx, input, phoneOpts, clock.signal)
      if (!p.ok) return fail(p.code, `${p.message} Nothing was added.`)
      phone = p
      if (!target.none) {
        const check = await websiteCheck(ctx, domain, given(input.name), clock.signal)
        if (!check.ok) return fail(check.late ? 'unreachable' : 'not_permitted', `${check.why} Nothing was added.`)
        note = check.note
      }
    } finally {
      clock.stop()
    }

    // Source 'agent', so the CRM records that a model put this row here.
    const name = input.name?.trim()
    const result = await importCompanyRows(ctx.db, ctx.orgId, [{ domain, ...(name ? { name } : {}) }], 'agent')
    let company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) throw new Error('a company just imported could not be read back')
    const created = result.inserted === 1

    // Only a row this call created gets the country, the zone and how it is
    // reached: one somebody else added between the read and the insert is
    // theirs, as they wrote it.
    if (created) {
      const fields: string[] = []
      if (Object.keys(extras.data).length > 0) {
        const updated = await companiesUpdate(ctx.db, ctx.orgId, company.id, extras.data)
        if (!updated.ok) {
          return fail(
            updated.reason === 'not_found' ? 'not_found' : 'invalid_state',
            `${domain} was added, but the details given with it were not set: ${updated.message}`,
          )
        }
        company = updated.company
        fields.push(...updated.changed)
      }
      const reach = await setReach(ctx, company.id, phone.value, given(input.address))
      if (!reach.ok) return fail('invalid_state', `${domain} was added, but its phone and address were not set: ${reach.message}`)
      if (reach.company) company = reach.company
      fields.push(...reach.changed)
      if (fields.length > 0) {
        await appendAudit(ctx.db, {
          orgId: ctx.orgId,
          actor: 'agent',
          action: 'company.updated',
          subjectType: 'company',
          subjectId: company.id,
          detail: { fields },
        }).catch(() => {})
      }
    }

    await ctx.audit('agent.add_company', { companyId: company.id, created })
    if (!created) {
      return ok(
        { companyId: company.id, domain, created: false },
        `${domain} was added by somebody else a moment ago (${companyFacts(company)}); nothing was changed. ` +
          `update_company changes what is recorded about it. ${NOTHING_SENT}`,
      )
    }
    const reachWords = [
      company.phone ? `its phone ${maskPhone(company.phone)} (${addressSourceWords(phone.source).words})` : null,
      company.address ? 'its address' : null,
    ].filter(Boolean)
    const reachSentence = reachWords.length ? ` On file: ${reachWords.join(' and ')}.` : ''
    if (target.none) {
      return ok(
        { companyId: company.id, domain, created: true, website: 'none' },
        `Filed ${oneLine(company.name, 80)} as a business with no website of its own, under the placeholder ${domain} ` +
          `— how every page and tool names it; it is never scanned: ${companyFacts(company)}.${reachSentence} It is ` +
          'reached by a call or a visit (create_task) or an email a person was given. ' +
          NOTHING_SENT,
      )
    }
    return ok(
      { companyId: company.id, domain, created: true },
      `Added ${domain} to the CRM: ${companyFacts(company)}.${reachSentence}${note ? ` ${note}` : ''} Nothing has been ` +
        `scanned — it has no score and no findings until a scan runs; ask to scan it with scan_company. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// update_company
// ---------------------------------------------------------------------------

const updateCompanyShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company to change, by its domain. The domain itself cannot be changed — every scan hangs off it.'),
  name: companyNameField.optional().describe('Its new name. An empty string clears it.'),
  country: companyCountryField.optional().describe('Its country, as people write it. An empty string clears it.'),
  timeZone: companyZoneField
    .optional()
    .describe(
      'Its IANA time zone, e.g. Europe/Amsterdam. An empty string clears it — then nothing can be sent to people ' +
        'here who have no zone of their own.',
    ),
  industry: firmographicFields.industry.optional().describe('Its sector. An empty string clears it.'),
  city: firmographicFields.city.optional().describe('The city of its main office. An empty string clears it.'),
  headcount: firmographicFields.headcount
    .nullable()
    .optional()
    .describe('Roughly how many people work there. null clears it, and its source with it.'),
  headcountSource: firmographicFields.headcountSource.optional(),
  stage: firmographicFields.stage.nullable().optional().describe('Its funding stage. null clears it.'),
  description: firmographicFields.description.optional().describe('What it sells and to whom. An empty string clears it.'),
}

const COMPANY_REFUSAL: Record<Extract<Awaited<ReturnType<typeof companiesUpdate>>, { ok: false }>['reason'], ToolErrorCode> = {
  not_found: 'not_found',
  invalid: 'invalid_state',
}

export const updateCompany: AgencyToolSpec<typeof updateCompanyShape> = {
  name: 'update_company',
  description:
    'Change what the CRM records about a company: its name, country, IANA time zone, industry, city, ' +
    'headcount (with where that number came from), funding stage or description. The zone is the one quiet ' +
    'hours fall back to for people there with none of their own, and it is never guessed from the country. A ' +
    'headcount or country changes the score only at the next scan (scan_company). The domain cannot be ' +
    'changed. This changes the CRM only; nothing is sent.',
  shape: updateCompanyShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // PATCH /api/companies/[id]'s own gate.
    if (!can(ctx.principal, 'companies:write')) {
      return fail('not_permitted', `The person you are helping cannot edit companies. ${NOTHING_SENT}`)
    }
    const found = await companyByDomain(ctx, input.domain)
    if (!found.ok) return fail(found.code, `${found.message} ${UNCHANGED}`)
    const { company } = found

    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...firmographicPatch(input),
    }
    if (Object.keys(patch).length === 0) {
      return fail(
        'invalid_state',
        `Say what to change: a name, country, time zone, industry, city, headcount, stage or description. ${UNCHANGED}`,
      )
    }
    // The route's parse, with its words; `companiesUpdate` parses again.
    const parsed = companyPatchInput.safeParse(patch)
    if (!parsed.success) return fail('invalid_state', `${issueWords(parsed.error)} ${UNCHANGED}`)

    const r = await companiesUpdate(ctx.db, ctx.orgId, company.id, parsed.data)
    if (!r.ok) return fail(COMPANY_REFUSAL[r.reason], unchanged(r.message))
    if (r.changed.length > 0) {
      await appendAudit(ctx.db, {
        orgId: ctx.orgId,
        actor: 'agent',
        action: 'company.updated',
        subjectType: 'company',
        subjectId: company.id,
        // The field NAMES, never the values, as the route writes it.
        detail: { fields: r.changed },
      }).catch(() => {})
    }
    await ctx.audit('agent.update_company', { companyId: company.id, fields: r.changed })

    const now = r.company
    if (r.changed.length === 0) {
      return ok(
        { companyId: now.id, domain: now.domain, changed: [] },
        `${now.domain}: nothing changed — that is what is recorded already (${companyFacts(now)}). ${NOTHING_SENT}`,
      )
    }
    const zoneGone = r.changed.includes('timeZone') && !now.timeZone
    const rescores = r.changed.some((f) => f === 'headcount' || f === 'country')
    return ok(
      { companyId: now.id, domain: now.domain, changed: r.changed },
      `${now.domain}: changed its ${r.changed.map((f) => COMPANY_FIELD_WORDS[f] ?? f).join(', ')} — now ` +
        `${companyFacts(now)}.` +
        (zoneGone
          ? ' With no time zone here, nothing can be sent to people at this company who have none of their own.'
          : '') +
        (rescores
          ? ' Its size or country is judged against the active profile at its next scan; scan_company re-scores it now.'
          : '') +
        ` ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// import_companies
// ---------------------------------------------------------------------------

const importCompaniesShape = {
  companies: z
    .array(
      z.object({
        domain: z
          .string()
          .min(1)
          .max(253)
          .optional()
          .describe('The company’s own public website domain, as this conversation showed it. Give this or website.'),
        website: companyReachFields.website.optional(),
        name: companyNameField.optional().describe('Its name, as it was shown.'),
        country: companyCountryField.optional().describe('Its country, if known.'),
        timeZone: companyZoneField
          .optional()
          .describe('Its IANA time zone, e.g. Asia/Kolkata — quiet hours fall back to it for people there with none.'),
        industry: firmographicFields.industry.optional(),
        city: firmographicFields.city.optional(),
        headcount: firmographicFields.headcount.optional(),
        headcountSource: firmographicFields.headcountSource.optional(),
        stage: firmographicFields.stage.optional(),
        description: firmographicFields.description.optional(),
        phone: companyReachFields.phone.optional(),
        phoneFrom: companyReachFields.phoneFrom.optional(),
        address: companyReachFields.address.optional(),
      }),
    )
    .min(1)
    .max(50)
    .describe(
      'Up to 50 companies, each by the domain of its own public website — or website "none" with its name and city ' +
        'for a business with none of its own — with what you know of it (country, time zone, industry, city, ' +
        'headcount with its source, stage, description, its phone and address as shown).',
    ),
}

type ImportOutcome = 'added' | 'already_present' | 'refused' | 'duplicate'

interface ImportLine {
  readonly line: number
  readonly domain: string
  readonly outcome: ImportOutcome
  readonly why: string | null
}

/** How many lines' websites and phones are checked at once. */
const IMPORT_CHECKS_AT_ONCE = 6
const NOT_CHECKED_IN_TIME = 'Not checked in time — add it again.'
/**
 * What an import's checks may spend: the tool budget less what writing up to
 * fifty new companies needs after them — an insert, then for each its details,
 * its phone and address and its audit row, a handful of round trips apiece.
 * A line not checked by then is refused, and added again by the next call.
 */
const IMPORT_CHECK_MS = TOOL_TIME_BUDGET_MS - 13_000

type ImportRow = z.infer<typeof importCompaniesShape.companies>[number]

export function makeImportCompanies(opts: { readonly budgetMs?: number } = {}): AgencyToolSpec<typeof importCompaniesShape> {
  const budgetMs = opts.budgetMs ?? IMPORT_CHECK_MS
  return {
    name: 'import_companies',
    description:
      'Add a list of up to 50 companies to the CRM by the domains of their own public websites — each one this ' +
      'conversation showed — or website "none" with a name and city for a business with no website of its own, ' +
      'each with what you know of it: country, time zone, industry, city, headcount with its source, stage, ' +
      'description, phone and address as shown. Companies already there are left exactly as they are, and each line ' +
      'is reported as added, already present or refused with why. Nothing is scanned (scan_company does that when ' +
      'asked), and nothing is sent.',
    shape: importCompaniesShape,
    async handler(input, ctx): Promise<ToolOutcome<unknown>> {
      // The import page's own gate.
      if (!can(ctx.principal, 'companies:write')) {
        return fail('not_permitted', `The person you are helping cannot add companies. ${NOTHING_SENT}`)
      }

      interface Candidate {
        readonly line: number
        readonly domain: string
        readonly none: boolean
        readonly row: ImportRow
      }
      const checked: Array<{ line: number; domain: string; refused: string | null; duplicate: boolean }> = []
      const candidates: Candidate[] = []
      // What each new company is recorded as, checked BEFORE anything is
      // written, as add_company checks it: a line whose details would be
      // refused is refused whole rather than half-added.
      const details = new Map<string, Record<string, unknown>>()
      const seen = new Set<string>()
      input.companies.forEach((row, i) => {
        const line = i + 1
        const target = companyTarget(row)
        if (!target.ok) {
          checked.push({ line, domain: oneLine(row.domain ?? row.website ?? row.name ?? '', 100), refused: target.message, duplicate: false })
          return
        }
        if (seen.has(target.domain)) {
          checked.push({ line, domain: target.domain, refused: null, duplicate: true })
          return
        }
        const patch = {
          ...(row.country !== undefined ? { country: row.country } : {}),
          ...(row.timeZone !== undefined ? { timeZone: row.timeZone } : {}),
          ...firmographicPatch(row),
        }
        const parsed = companyPatchInput.safeParse(patch)
        if (!parsed.success) {
          checked.push({ line, domain: target.domain, refused: issueWords(parsed.error), duplicate: false })
          return
        }
        if (parsed.data.timeZone && !isKnownTimeZone(parsed.data.timeZone)) {
          checked.push({ line, domain: target.domain, refused: unknownZone(parsed.data.timeZone), duplicate: false })
          return
        }
        if (parsed.data.headcountSource && parsed.data.headcount === undefined) {
          checked.push({ line, domain: target.domain, refused: 'A headcount source needs the headcount it is for.', duplicate: false })
          return
        }
        seen.add(target.domain)
        if (Object.keys(parsed.data).length > 0) details.set(target.domain, parsed.data)
        candidates.push({ line, domain: target.domain, none: target.none, row })
        checked.push({ line, domain: target.domain, refused: null, duplicate: false })
      })

      // A company already here is left exactly as it is, and needs no checking.
      const present = new Set(
        candidates.length === 0
          ? []
          : (
              await ctx.db
                .select({ domain: schema.companies.domain })
                .from(schema.companies)
                .where(and(eq(schema.companies.orgId, ctx.orgId), inArray(schema.companies.domain, candidates.map((c) => c.domain))))
            ).map((r) => r.domain),
      )

      // True data only, line by line as add_company checks one: its phone was
      // shown, and its website was shown and answers — six at a time, inside
      // the call's time. A line not checked in time is refused, never let through.
      const verdicts = new Map<string, { readonly refused: string } | { readonly phone: string | null }>()
      const queue = candidates.filter((c) => !present.has(c.domain))
      const clock = deadline(budgetMs)
      try {
        const check = async (c: Candidate): Promise<{ refused: string } | { phone: string | null }> => {
          const phone = await companyPhone(ctx, c.row, phoneOptsFor({ country: c.row.country ?? null, domain: c.domain }), clock.signal)
          if (!phone.ok) return { refused: phone.message === OUT_OF_TIME ? NOT_CHECKED_IN_TIME : phone.message }
          if (!c.none) {
            const site = await websiteCheck(ctx, c.domain, given(c.row.name), clock.signal)
            if (!site.ok) return { refused: site.late ? NOT_CHECKED_IN_TIME : site.why }
          }
          return { phone: phone.value }
        }
        const worker = async (): Promise<void> => {
          while (queue.length > 0 && !clock.signal.aborted) {
            const c = queue.shift()!
            verdicts.set(c.domain, await check(c))
          }
        }
        await Promise.all(Array.from({ length: Math.min(IMPORT_CHECKS_AT_ONCE, queue.length) }, worker))
      } finally {
        clock.stop()
      }
      const passed: Candidate[] = []
      for (const c of candidates) {
        const verdict = present.has(c.domain) ? { phone: null } : (verdicts.get(c.domain) ?? { refused: NOT_CHECKED_IN_TIME })
        if ('refused' in verdict) {
          const entry = checked.find((e) => e.line === c.line)!
          entry.refused = verdict.refused
        } else passed.push(c)
      }
      const phones = new Map(
        [...verdicts].flatMap(([domain, v]) => ('phone' in v && v.phone ? [[domain, v.phone] as const] : [])),
      )

      // Source 'agent'. `ON CONFLICT DO NOTHING`: a company already here keeps its row as it is.
      const rows = passed.map((c) => {
        const name = c.row.name?.trim()
        return { domain: c.domain, ...(name ? { name } : {}) }
      })
      const result = rows.length > 0 ? await importCompanyRows(ctx.db, ctx.orgId, rows, 'agent') : null
      const inserted = new Set(result?.domains ?? [])

      // Only a row this call created gets its details — one already here is as
      // whoever recorded it left it (update_company changes it).
      const detailsNotSet: string[] = []
      for (const c of passed) {
        if (!inserted.has(c.domain)) continue
        const patch = details.get(c.domain)
        const phone = phones.get(c.domain) ?? null
        const address = given(c.row.address)
        if (!patch && !phone && !address) continue
        const company = await findCompanyByDomain(ctx.db, ctx.orgId, c.domain)
        if (!company) continue
        const fields: string[] = []
        if (patch) {
          const updated = await companiesUpdate(ctx.db, ctx.orgId, company.id, patch)
          if (!updated.ok) {
            detailsNotSet.push(`${c.domain}: ${updated.message}`)
            continue
          }
          fields.push(...updated.changed)
        }
        const reach = await setReach(ctx, company.id, phone, address)
        if (!reach.ok) detailsNotSet.push(`${c.domain}: ${reach.message}`)
        else fields.push(...reach.changed)
        if (fields.length > 0) {
          await appendAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: 'agent',
            action: 'company.updated',
            subjectType: 'company',
            subjectId: company.id,
            detail: { fields },
          }).catch(() => {})
        }
      }
      const lines: ImportLine[] = checked.map((c) => ({
        line: c.line,
        domain: c.domain,
        why: c.refused,
        outcome: c.refused !== null ? 'refused' : c.duplicate ? 'duplicate' : inserted.has(c.domain) ? 'added' : 'already_present',
      }))
      const count = (o: ImportOutcome): number => lines.filter((l) => l.outcome === o).length
      const added = lines.filter((l) => l.outcome === 'added').map((l) => l.domain)
      const alreadyHere = lines.filter((l) => l.outcome === 'already_present').map((l) => l.domain)
      const refused = lines.filter((l) => l.outcome === 'refused')
      const noSite = added.filter((d) => isNoSiteDomain(d)).length

      await ctx.audit('agent.import_companies', {
        added: count('added'),
        alreadyPresent: count('already_present'),
        refused: count('refused'),
        duplicates: count('duplicate'),
      })

      const detail = [
        ...(added.length ? [`Added: ${added.join(', ')}`] : []),
        ...(alreadyHere.length ? [`Already in the CRM, left as they were: ${alreadyHere.join(', ')}`] : []),
        ...refused.map((l) => `Refused, line ${l.line} ("${l.domain}"): ${l.why}`),
        ...detailsNotSet.map((d) => `Added, but its details were not set — ${d}`),
      ]
      return ok(
        { lines, added: added.length, alreadyPresent: alreadyHere.length, refused: refused.length, duplicates: count('duplicate') },
        [
          `${plural(added.length, 'company', 'companies')} added, ${alreadyHere.length} already in the CRM, ` +
            `${refused.length} refused` +
            (count('duplicate') > 0 ? `, ${count('duplicate')} listed twice (counted once)` : '') +
            '.',
          bounded(detail, 6_000),
          ...(noSite > 0
            ? [`${plural(noSite, 'business was', 'businesses were')} filed with no website of its own (a .nosite.invalid placeholder): never scanned, reached by a call or a visit.`]
            : []),
          added.length > noSite
            ? 'Nothing has been scanned — a new company has no score and no findings until a scan runs; ask to scan ' +
              `one with scan_company. ${NOTHING_SENT}`
            : NOTHING_SENT,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  }
}

export const importCompanies = makeImportCompanies()

// ---------------------------------------------------------------------------
// add_contact
// ---------------------------------------------------------------------------

/** `contactsUpdate`'s sentences for an address the suppression list could never match. */
const PHONE_UNREADABLE = (raw: string): string =>
  `"${oneLine(raw, 40)}" is not a number in international form. Include the country code, like ` +
  '+1 415 555 0100 — without one it cannot be matched against an opt-out.'
const LINKEDIN_UNREADABLE = (raw: string): string =>
  `"${oneLine(raw, 120)}" could not be read as a LinkedIn profile. Paste the full URL, like ` +
  'linkedin.com/in/jane-doe — a bare handle does not say whether it is a person or a company.'

const contactFields = {
  firstName: z.string().max(80),
  lastName: z.string().max(80),
  title: z.string().max(120),
  email: z.string().max(254),
  phone: z.string().max(40),
  linkedinUrl: z.string().max(500),
  timeZone: z.string().max(64),
}


/** The kind of source an address was stored with, for the route's `contact.created` row: never the page itself. */
const kindOf = (s: Sourced | null): SourceKind | null => s?.kind ?? null

const addContactShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company they are at, by its domain. add_company first if it is not in the CRM.'),
  firstName: contactFields.firstName
    .optional()
    .describe('Their first name — only a person this conversation named: the person you help, a page or a search.'),
  lastName: contactFields.lastName.optional().describe('Their last name, as it was shown.'),
  title: contactFields.title.optional().describe('Their job title.'),
  email: contactFields.email
    .optional()
    .describe(
      'Their email address exactly as something in this conversation showed it — the person typed it, or a page or ' +
        'a search returned it. Never composed from a name or a pattern. Or give emailFrom.',
    ),
  emailFrom: addressFields.from.optional().describe('Their email by the handle read_page or find_contact_details printed (E-…).'),
  emailSource: addressFields.source
    .optional()
    .describe('The page that shows the email, if not a handle: it is read to check that it does, and stored as where it came from.'),
  phone: contactFields.phone
    .optional()
    .describe('Their phone number in international form with the country code, e.g. +44 20 7946 0958 — as it was shown.'),
  phoneFrom: addressFields.from.optional().describe('Their phone by the handle read_page or find_contact_details printed (P-…).'),
  phoneSource: addressFields.source
    .optional()
    .describe('The page that shows the number, if not a handle: it is read to check that it does.'),
  linkedinUrl: contactFields.linkedinUrl
    .optional()
    .describe('Their LinkedIn profile URL as a search or a page showed it, e.g. linkedin.com/in/jane-doe.'),
  timeZone: contactFields.timeZone
    .optional()
    .describe('Their IANA time zone, e.g. Europe/London. With none of theirs or the company’s, nothing can be sent to them.'),
}

/** The zone quiet hours are checked in for a person, in a sentence. */
function zoneSentence(contactZone: string | null, company: Pick<Company, 'domain' | 'timeZone'>): string {
  if (contactZone) return `Quiet hours are checked in their zone, ${oneLine(contactZone, 64)}.`
  if (company.timeZone) {
    return `Quiet hours fall back to ${company.domain}’s zone, ${oneLine(company.timeZone, 64)}.`
  }
  return (
    `Neither they nor ${company.domain} has a time zone, so the send path will refuse to send to them until one ` +
    'is set (update_contact or update_company).'
  )
}

export const addContact: AgencyToolSpec<typeof addContactShape> = {
  name: 'add_contact',
  description:
    'Add a person at a company to the CRM, with at least one way to reach them — an email address, a phone ' +
    'number in international form, or a LinkedIn profile — and their IANA time zone if known. Only what this ' +
    'conversation showed: an address by its handle from read_page or find_contact_details, or exactly as the person ' +
    'or a search gave it — never one composed from a name or a pattern, never a made-up person. Each address is ' +
    'stored with where it came from. It records NO consent of any kind (absence is no) and puts them in no ' +
    'campaign; nothing is sent.',
  shape: addContactShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // POST /api/contacts's own gate.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot add contacts. ${NOTHING_SENT}`)
    }
    const found = await companyByDomain(ctx, input.domain)
    if (!found.ok) return fail(found.code, `${found.message} Nothing was added.`)
    const { company } = found

    // §2.1: a number the suppression list could never match is not stored,
    // and one it can is stored as E.164 — what the import and an edit store.
    // A LinkedIn URL is kept as typed (a link somebody clicks), but only one
    // `normaliseLinkedIn` can read: the key an opt-out is recorded against.
    const rawPhone = input.phone?.trim() || null
    if (rawPhone && !normalisePhone(rawPhone)) return fail('invalid_state', `${PHONE_UNREADABLE(rawPhone)} Nothing was added.`)
    const linkedinUrl = input.linkedinUrl?.trim() || null
    const linkedinKey = linkedinUrl ? normaliseLinkedIn(linkedinUrl) : null
    if (linkedinUrl && !linkedinKey) {
      return fail('invalid_state', `${LINKEDIN_UNREADABLE(linkedinUrl)} Nothing was added.`)
    }

    // True data only: each address from what this conversation showed, the
    // person named by it too, and an email at a domain that receives mail.
    const phoneOpts = phoneOptsFor(company)
    const pages: PageReads = new Map()
    const clock = deadline(WEB_WORK_MS)
    let email: Sourced | null
    let phone: Sourced | null
    try {
      const e = await sourcedAddress(
        ctx, 'email', { raw: input.email, from: input.emailFrom, sourceUrl: input.emailSource }, phoneOpts, pages, clock.signal,
      )
      if (!e.ok) return fail(e.code, `${e.message} Nothing was added.`)
      const p = await sourcedAddress(
        ctx, 'phone', { raw: input.phone, from: input.phoneFrom, sourceUrl: input.phoneSource }, phoneOpts, pages, clock.signal,
      )
      if (!p.ok) return fail(p.code, `${p.message} Nothing was added.`)
      email = e.sourced
      phone = p.sourced
      if (linkedinKey) {
        const shown = await linkedinShown(ctx, linkedinKey, clock.signal)
        if (shown === 'late') return fail('unreachable', `${OUT_OF_TIME} Nothing was added.`)
        if (!shown) return fail('not_permitted', `${NOT_SHOWN_LINKEDIN(linkedinKey)} Nothing was added.`)
      }
      const first = given(input.firstName)
      const last = given(input.lastName)
      const addressPages = [email?.page, phone?.page].filter((u): u is string => !!u)
      const named = await personShown(ctx, first, last, addressPages, pages, clock.signal)
      if (named === 'late') return fail('unreachable', `${OUT_OF_TIME} Nothing was added.`)
      if (!named) {
        return fail('not_permitted', `${NOT_SHOWN_PERSON([first, last].filter(Boolean).join(' '), addressPages.length > 0)} Nothing was added.`)
      }
    } finally {
      clock.stop()
    }

    // The route's parse, then the route's writer: it folds the email, checks
    // the zone, refuses a duplicate address in this org with a sentence. A
    // source goes only beside the address it is about.
    const emailValue = email?.value ?? (input.email?.trim() || null)
    const phoneValueStored = phone?.value ?? null
    const parsed = contactInput.safeParse({
      companyId: company.id,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      email: emailValue,
      phone: phoneValueStored,
      linkedinUrl,
      timeZone: input.timeZone?.trim() || null,
      source: 'agent',
      ...(email?.source ? { emailSource: email.source } : {}),
      ...(phone?.source ? { phoneSource: phone.source } : {}),
    })
    if (!parsed.success) return fail('invalid_state', `${issueWords(parsed.error)} Nothing was added.`)
    const result = await createContact(ctx.db, ctx.orgId, parsed.data)
    if (!result.ok) {
      const held = [
        given(input.emailFrom) && email ? { which: 'email' as const, value: email.value } : null,
        given(input.phoneFrom) && phone ? { which: 'phone' as const, value: phone.value } : null,
      ]
      return fail('invalid_state', `${maskHeld(result.message, held)} Nothing was added.`)
    }
    const contact = result.contact

    // The route's own row, as it writes it: never the address (§2.3), and of
    // where each came from only its KIND — a page's address can carry a person's name.
    await appendAudit(ctx.db, {
      orgId: ctx.orgId,
      actor: 'agent',
      action: 'contact.created',
      subjectType: 'contact',
      subjectId: contact.id,
      detail: {
        companyId: contact.companyId,
        source: contact.source,
        hasTimeZone: !!contact.timeZone,
        emailSourceKind: contact.email ? kindOf(email) : null,
        phoneSourceKind: contact.phone ? kindOf(phone) : null,
      },
    }).catch(() => {})
    await ctx.audit('agent.add_contact', { contactId: contact.id, companyId: company.id })

    const reach = [
      contact.email ? `email ${maskEmail(contact.email)} (${sourceWords(email)})` : null,
      contact.phone ? `a phone number (stored in international form; ${sourceWords(phone)})` : null,
      contact.linkedinUrl ? 'a LinkedIn profile' : null,
    ].filter(Boolean)
    const notes = [email?.note, phone?.note].filter((n): n is string => !!n)
    return ok(
      {
        contactId: contact.id,
        domain: company.domain,
        email: maskEmail(contact.email),
        hasPhone: !!contact.phone,
        hasLinkedIn: !!contact.linkedinUrl,
        timeZone: contact.timeZone,
        consentRecorded: false,
        emailSourceKind: contact.email ? kindOf(email) : null,
        phoneSourceKind: contact.phone ? kindOf(phone) : null,
      },
      `Added ${personWithId(contact, company.domain)}; on file: ${reach.join(', ')}. ` +
        (notes.length ? `${notes.join(' ')} ` : '') +
        'No consent row of any kind was recorded, and absence is a no: SMS, voice and WhatsApp stay closed to them ' +
        'until a person records an opt-in on /contacts, while cold email and LinkedIn need none and still meet every ' +
        'other send rule. They are in no campaign. ' +
        `${zoneSentence(contact.timeZone, company)} ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// update_contact
// ---------------------------------------------------------------------------

const updateContactShape = {
  ...personShape,
  firstName: contactFields.firstName.optional().describe('Their first name. An empty string clears it.'),
  lastName: contactFields.lastName.optional().describe('Their last name. An empty string clears it.'),
  title: contactFields.title.optional().describe('Their job title. An empty string clears it.'),
  email: contactFields.email
    .optional()
    .describe(
      'Their NEW email address, exactly as this conversation showed it (never composed); an empty string clears it. ' +
        'Refused while a message to them is waiting to go out.',
    ),
  emailFrom: addressFields.from.optional().describe('Their new email by the handle read_page or find_contact_details printed (E-…).'),
  emailSource: addressFields.source
    .optional()
    .describe('The page that shows the new email, if not a handle: it is read to check that it does.'),
  phone: contactFields.phone
    .optional()
    .describe('Their NEW phone number, in international form, as it was shown; an empty string clears it. Refused while a message to them waits.'),
  phoneFrom: addressFields.from.optional().describe('Their new phone by the handle read_page or find_contact_details printed (P-…).'),
  phoneSource: addressFields.source
    .optional()
    .describe('The page that shows the new number, if not a handle: it is read to check that it does.'),
  linkedinUrl: contactFields.linkedinUrl
    .optional()
    .describe('Their NEW LinkedIn profile URL, as a search or a page showed it; an empty string clears it. Refused while a message to them waits.'),
  timeZone: contactFields.timeZone
    .optional()
    .describe('Their IANA time zone, e.g. Europe/London. An empty string clears it.'),
}

type AddressField = 'email' | 'phone' | 'linkedinUrl'
const ADDRESS_FIELDS: readonly AddressField[] = ['email', 'phone', 'linkedinUrl']
const PATCH_FIELDS = ['firstName', 'lastName', 'title', 'email', 'phone', 'linkedinUrl'] as const

const CONTACT_FIELD_WORDS: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  title: 'title',
  email: 'email address',
  phone: 'phone number',
  linkedinUrl: 'LinkedIn profile',
  timeZone: 'time zone',
}

/**
 * Where a message on this field goes: the key it is matched and sent by,
 * or the text itself for one that cannot be read. Two spellings of one
 * number or profile are one destination; a cleared field is none.
 */
function destination(field: AddressField, raw: string | null | undefined): string | null {
  const v = raw?.trim()
  if (!v) return null
  const key = field === 'email' ? normaliseEmail(v) : field === 'phone' ? normalisePhone(v) : normaliseLinkedIn(v)
  return key ?? `unreadable:${v}`
}

const UPDATE_REFUSAL: Record<Extract<ContactsUpdateOutcome, { ok: false }>['reason'], ToolErrorCode> = {
  no_such_contact: 'not_found',
  unreadable: 'invalid_state',
  no_address: 'invalid_state',
  duplicate: 'invalid_state',
  suppressed: 'invalid_state',
  shared_number_hold: 'invalid_state',
  changed_meanwhile: 'invalid_state',
}

export const updateContact: AgencyToolSpec<typeof updateContactShape> = {
  name: 'update_contact',
  description:
    'Change a person’s name, title, IANA time zone, or an address (email, phone, LinkedIn), under the rules a ' +
    'teammate editing them meets: an address on the suppression list is not edited away, nor a number held ' +
    'for an unrecorded opt-out. An address is never changed while a message to them waits to go out, and a new ' +
    'one must have been shown in this conversation (by handle, a page, the person or a search) — never composed. ' +
    'Nothing is sent.',
  shape: updateContactShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // PATCH /api/contacts/[id]'s own gate.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot edit contacts. ${NOTHING_SENT}`)
    }
    const found = await contactFor(ctx, input)
    if (!found.ok) return fail(found.code, found.message)
    const { contact, domain, companyTimeZone, companyCountry } = found

    const patch: Partial<Record<(typeof PATCH_FIELDS)[number], string>> = {}
    for (const f of PATCH_FIELDS) if (input[f] !== undefined) patch[f] = input[f]
    // An address by its handle is that address, for every rule below.
    const now = ctx.now().getTime()
    for (const [field, from] of [['email', input.emailFrom], ['phone', input.phoneFrom]] as const) {
      const handle = given(from)
      if (!handle) continue
      const hit = foundByHandle(ctx.orgId, handle, now)
      if (!hit) return fail('invalid_state', `${STALE_HANDLE(handle)} ${UNCHANGED}`)
      if (hit.kind !== field) {
        return fail('invalid_state', `${hit.handle} stands for ${hit.kind === 'email' ? 'an email address' : 'a phone number'}. ${UNCHANGED}`)
      }
      if (patch[field] === undefined || patch[field]!.trim() === '') patch[field] = hit.value
    }
    const zone = input.timeZone === undefined ? undefined : input.timeZone.trim() || null
    if (Object.keys(patch).length === 0 && zone === undefined) {
      return fail('invalid_state', `Say what to change: a name, a title, an address or a time zone. ${UNCHANGED}`)
    }
    // Checked before anything is written, so a refused zone changes nothing.
    if (zone && !isKnownTimeZone(zone)) return fail('invalid_state', `${unknownZone(zone)} ${UNCHANGED}`)

    // The agent's own rule. The sender reads the address when it sends, so a
    // message already approved — or queued, or waiting for a person — would
    // go to the new one, which nobody who decided on it saw.
    const moving = ADDRESS_FIELDS.filter(
      (f) => patch[f] !== undefined && destination(f, patch[f]) !== destination(f, contact[f]),
    )
    if (moving.length > 0) {
      const live = await ctx.db
        .select({ id: schema.touches.id })
        .from(schema.touches)
        .where(
          and(
            eq(schema.touches.orgId, ctx.orgId),
            eq(schema.touches.contactId, contact.id),
            eq(schema.touches.direction, 'out'),
            inArray(schema.touches.status, [...COMPLIANCE_UNSENT_STATUSES]),
          ),
        )
      if (live.length > 0) {
        return fail(
          'invalid_state',
          `${personLabel(contact, domain)} has ${plural(live.length, 'message')} waiting to go out — awaiting ` +
            'approval, approved, queued or being sent — and the sender reads their address at the moment it sends, ' +
            `so changing their ${moving.map((f) => CONTACT_FIELD_WORDS[f]).join(' or ')} now would send ` +
            `${live.length === 1 ? 'it' : 'them'} to the new one: a person changes where their messages go, on ` +
            `/contacts. Their name, title and time zone can still be changed here. ${UNCHANGED}`,
        )
      }
    }

    // True data only: a NEW address was shown in this conversation, a new
    // name too, and a new email's domain receives mail. Clearing needs nothing.
    const phoneOpts = phoneOptsFor({ country: companyCountry, domain })
    const pages: PageReads = new Map()
    const sources: { emailSource?: string; phoneSource?: string } = {}
    const sourcedNow: { email?: Sourced | null; phone?: Sourced | null } = {}
    const clock = deadline(WEB_WORK_MS)
    try {
      for (const field of ['email', 'phone'] as const) {
        if (!moving.includes(field) || !given(patch[field])) continue
        const claim =
          field === 'email'
            ? { raw: patch.email, from: input.emailFrom, sourceUrl: input.emailSource }
            : { raw: patch.phone, from: input.phoneFrom, sourceUrl: input.phoneSource }
        const r = await sourcedAddress(ctx, field, claim, phoneOpts, pages, clock.signal)
        if (!r.ok) return fail(r.code, `${r.message} ${UNCHANGED}`)
        sourcedNow[field] = r.sourced
        if (r.sourced?.source) sources[field === 'email' ? 'emailSource' : 'phoneSource'] = r.sourced.source
      }
      const linkedinKey = moving.includes('linkedinUrl') && given(patch.linkedinUrl) ? normaliseLinkedIn(patch.linkedinUrl!) : null
      if (linkedinKey) {
        const shown = await linkedinShown(ctx, linkedinKey, clock.signal)
        if (shown === 'late') return fail('unreachable', `${OUT_OF_TIME} ${UNCHANGED}`)
        if (!shown) return fail('not_permitted', `${NOT_SHOWN_LINKEDIN(linkedinKey)} ${UNCHANGED}`)
      }
      const newFirst = given(input.firstName) && given(input.firstName) !== (contact.firstName ?? '').trim() ? given(input.firstName) : null
      const newLast = given(input.lastName) && given(input.lastName) !== (contact.lastName ?? '').trim() ? given(input.lastName) : null
      if (newFirst || newLast) {
        const addressPages = [sourcedNow.email?.page, sourcedNow.phone?.page].filter((u): u is string => !!u)
        const named = await personShown(ctx, newFirst, newLast, addressPages, pages, clock.signal)
        if (named === 'late') return fail('unreachable', `${OUT_OF_TIME} ${UNCHANGED}`)
        if (!named) {
          return fail('not_permitted', `${NOT_SHOWN_PERSON([newFirst, newLast].filter(Boolean).join(' '), addressPages.length > 0)} ${UNCHANGED}`)
        }
      }
    } finally {
      clock.stop()
    }

    // The route's parse, then the route's writer, with every refusal it words:
    // a suppression that would stop matching, a shared number's hold, a
    // duplicate address, an edit raced by an opt-out. A source goes only
    // beside the address it is about, which `contactsUpdate` stamps only when
    // that address changes.
    let changed: string[] = []
    let bounceCleared = false
    let after: ContactRow = contact
    if (Object.keys(patch).length > 0) {
      const parsed = contactPatchInput.safeParse({ ...patch, ...sources })
      if (!parsed.success) return fail('invalid_state', `${issueWords(parsed.error)} ${UNCHANGED}`)
      const r = await contactsUpdate(ctx.db, ctx.orgId, contact.id, parsed.data, { actor: 'agent' })
      if (!r.ok) {
        const held = [
          given(input.emailFrom) && patch.email ? { which: 'email' as const, value: patch.email } : null,
          given(input.phoneFrom) && patch.phone ? { which: 'phone' as const, value: patch.phone } : null,
        ]
        return fail(UPDATE_REFUSAL[r.reason], unchanged(maskHeld(r.message, held)))
      }
      changed = r.changed
      bounceCleared = r.bounceCleared
      after = r.contact
      if (r.changed.length > 0) {
        await appendAudit(ctx.db, {
          orgId: ctx.orgId,
          actor: 'agent',
          action: 'contact.updated',
          subjectType: 'contact',
          subjectId: contact.id,
          // The field names, never their values, as the route writes it.
          detail: { fields: r.changed },
        }).catch(() => {})
      }
    }

    // The route's `timeZone` action, when the zone given is not the one on file.
    if (zone !== undefined && zone !== (after.timeZone ?? null)) {
      const z = await updateContactTimeZone(ctx.db, ctx.orgId, contact.id, zone)
      if (!z.ok) return fail('invalid_state', unchanged(z.message))
      await appendAudit(ctx.db, {
        orgId: ctx.orgId,
        actor: 'agent',
        action: 'contact.timezone_set',
        subjectType: 'contact',
        subjectId: contact.id,
        detail: { timeZone: zone },
      }).catch(() => {})
      changed = [...changed, 'timeZone']
      after = { ...after, timeZone: zone }
    }

    await ctx.audit('agent.update_contact', { contactId: contact.id, fields: changed, bounceCleared })

    const label = personWithId(after, domain)
    if (changed.length === 0) {
      return ok(
        { contactId: contact.id, changed: [] },
        `Nothing changed for ${label}: that is what is recorded already. ${NOTHING_SENT}`,
      )
    }
    const notes = [
      ...(changed.includes('email')
        ? [
            after.email
              ? `Their email is now ${maskEmail(after.email)}. ${sourceSentence(sourcedNow.email ?? null)}`
              : 'Their email is now cleared.',
          ]
        : []),
      ...(bounceCleared ? ['The bounce mark on their old address was lifted with it.'] : []),
      ...(changed.includes('phone') && after.phone
        ? [`Their phone is stored in international form. ${sourceSentence(sourcedNow.phone ?? null)}`]
        : []),
      ...[sourcedNow.email?.note, sourcedNow.phone?.note].filter((n): n is string => !!n),
      ...(changed.includes('timeZone') ? [zoneSentence(after.timeZone, { domain, timeZone: companyTimeZone })] : []),
    ]
    return ok(
      { contactId: contact.id, changed, bounceCleared, email: maskEmail(after.email), timeZone: after.timeZone },
      `Updated ${label}: changed their ${changed.map((f) => CONTACT_FIELD_WORDS[f] ?? f).join(', ')}.` +
        (notes.length ? ` ${notes.join(' ')}` : '') +
        ` ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// pause_contact
// ---------------------------------------------------------------------------

const pauseContactShape = {
  ...personShape,
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('Why, in a few words — shown beside the pause on /contacts, e.g. "out of office until March".'),
}

const PAUSE_REFUSAL: Record<Extract<ContactPauseOutcome, { ok: false }>['reason'], ToolErrorCode> = {
  not_found: 'not_found',
  already_paused: 'invalid_state',
  changed_meanwhile: 'invalid_state',
}

/**
 * Who a pause is in the name of: the person whose chat this is, by their
 * sign-in address — the route writes `(by <their address>)`. A hold has to
 * end `(by <who>)` with no parenthesis inside to read as a teammate's
 * (`pauseReasonClass`), so any is dropped.
 */
async function chatOwner(ctx: ToolContext): Promise<string> {
  let who = ctx.principal.id
  if (UUID.test(who)) {
    const rows = await ctx.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, ctx.orgId), eq(schema.users.id, who)))
      .limit(1)
    who = rows[0]?.email ?? who
  }
  return who.replace(/[()]/g, '')
}

export const pauseContact: AgencyToolSpec<typeof pauseContactShape> = {
  name: 'pause_contact',
  description:
    'Hold a person from every campaign, with a short reason a teammate will read on /contacts — a teammate’s ' +
    'hold, which only a person lifts (resume_contact asks one). Over the pause their own reply caused it takes ' +
    'that pause’s place; any other pause stands. It only ever stops messages: nothing is sent.',
  shape: pauseContactShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The /contacts Pause's own gate.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot pause contacts. ${NOTHING_SENT}`)
    }
    const found = await contactFor(ctx, input)
    if (!found.ok) return fail(found.code, found.message)
    const { contact, domain } = found

    const why = oneLine(input.reason, 200)
    if (!why) return fail('invalid_state', `Say why — a pause with no reason gets cleared. ${UNCHANGED}`)
    // The route's shape, `<why> (by <who>)`, which reads as a teammate's hold.
    const reason = `${why} (by the agent, for ${await chatOwner(ctx)})`
    if (pauseReasonClass(reason) !== 'manual') {
      return fail(
        'invalid_state',
        'Say why in other words: a reason that opens “opt-out not recorded” reads as the system’s own pause for ' +
          `an opt-out that could not be stored, and nobody could ever lift it. ${UNCHANGED}`,
      )
    }

    const r = await contactPauseByHand(ctx.db, { orgId: ctx.orgId, contactId: contact.id, reason, now: ctx.now() })
    if (!r.ok) return fail(PAUSE_REFUSAL[r.reason], unchanged(r.message))

    // The route's own row, as it writes it: the reason, and the CLASS of a
    // reply's pause it replaced — never that pause's text.
    await appendAudit(ctx.db, {
      orgId: ctx.orgId,
      actor: 'agent',
      action: 'contact.paused',
      subjectType: 'contact',
      subjectId: contact.id,
      detail: { reason: why.slice(0, 200), alreadyPaused: false, ...(r.replaced ? { replacedPauseFor: r.replaced } : {}) },
    }).catch(() => {})
    await ctx.audit('agent.pause_contact', { contactId: contact.id, replacedPauseFor: r.replaced })

    return ok(
      { contactId: contact.id, paused: true, pausedFor: 'manual', replacedPauseFor: r.replaced },
      `Paused ${personWithId(contact, domain)} (pausedFor: manual): they are held from every campaign, and no ` +
        'message goes to them on any channel until a person resumes them on /contacts (resume_contact asks one ' +
        'first, given this id and pausedFor manual).' +
        (r.replaced
          ? ' It took the place of the pause their reply caused, so answering that reply from /inbox no longer lifts it.'
          : '') +
        ` ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// resume_contact
// ---------------------------------------------------------------------------

/** Every class `pauseReasonClass` answers; the check below fails the build if core adds one. */
const PAUSE_CLASSES = ['replied', 'manual', 'unsubscribed', 'opt_out_not_recorded', 'erasure', 'other'] as const
type EveryPauseClass = Exclude<PauseReasonClass, (typeof PAUSE_CLASSES)[number]> extends never ? true : never
const EVERY_PAUSE_CLASS: EveryPauseClass = true
void EVERY_PAUSE_CLASS

const resumeContactShape = {
  ...personShape,
  pausedFor: z
    .enum(PAUSE_CLASSES)
    .describe('The pause being lifted, by the class list_contacts showed (pausedFor). If it has changed since, nothing is lifted.'),
}

const RESUME_REFUSAL: Record<Extract<ContactResumeOutcome, { ok: false }>['reason'], ToolErrorCode> = {
  not_found: 'not_found',
  not_paused: 'invalid_state',
  changed_meanwhile: 'invalid_state',
  opt_out_not_recorded: 'invalid_state',
  erasure: 'invalid_state',
}

export const resumeContact: AgencyToolSpec<typeof resumeContactShape> = {
  name: 'resume_contact',
  description:
    'Lift a person’s pause, named by its class as list_contacts showed it, so campaigns may write to them again — ' +
    'only through the send rules, which every message still meets when it would go. Refused, as on /contacts, ' +
    'for an opt-out nobody recorded, an unfinished erasure or a shared number’s unrecorded STOP. Nothing is sent.',
  shape: resumeContactShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The /contacts Resume's own gate.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot resume contacts. ${NOTHING_SENT}`)
    }
    const found = await contactFor(ctx, input)
    if (!found.ok) return fail(found.code, found.message)
    const { contact, domain } = found

    // The model read a CLASS, never the reason, and names the pause by it. A
    // pause that is now of another class is not the one it decided about.
    const current = contact.pausedAt !== null ? pauseReasonClass(contact.pausedReason) : null
    if (current !== null && current !== input.pausedFor) {
      return fail(
        'invalid_state',
        `The pause changed since you read it: it is now pausedFor ${current}, not ${input.pausedFor}. Read it again ` +
          `with list_contacts before resuming them. ${UNCHANGED}`,
      )
    }
    // The CURRENT reason's text is what the resume names, so the function's
    // lock judges it: a pause that changed between this read and its lock is
    // `changed_meanwhile`, and only a pause a person may lift is lifted.
    const r = await contactResumeByHand(ctx.db, {
      orgId: ctx.orgId,
      contact: { id: contact.id },
      expectedReason: contact.pausedReason,
      actor: 'agent',
    })
    if (!r.ok) return fail(RESUME_REFUSAL[r.reason], unchanged(r.message))

    await ctx.audit('agent.resume_contact', { contactId: contact.id, pausedFor: current })
    return ok(
      { contactId: contact.id, paused: false, pausedFor: current },
      `Resumed ${personWithId(contact, domain)}: the pause (${current ?? 'none'}) is lifted, so campaigns may write to ` +
        'them again — only through the send rules, which every message still meets at the moment it would go ' +
        '(suppression, consent, quiet hours in their zone, the daily cap and the rest), and only once a person has ' +
        `approved it where the campaign asks for that. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// add_suppression
// ---------------------------------------------------------------------------

const SUPPRESSION_KINDS = ['email', 'domain', 'phone', 'linkedin'] as const satisfies readonly SuppressionKind[]

const KIND_WORDS: Record<(typeof SUPPRESSION_KINDS)[number], { readonly label: string; readonly gave: string }> = {
  email: { label: 'Email address', gave: 'the address you gave' },
  domain: { label: 'Email domain', gave: 'every address at the domain you gave' },
  phone: { label: 'Phone number', gave: 'the number you gave' },
  linkedin: { label: 'LinkedIn profile', gave: 'the profile you gave' },
}

const addSuppressionShape = {
  kind: z
    .enum(SUPPRESSION_KINDS)
    .describe(
      'What to suppress: an email address, a whole email domain, a phone number, or a LinkedIn profile. With ' +
        'contactId: email, phone or linkedin — that person’s own, as stored.',
    ),
  contactId: z
    .uuid()
    .optional()
    .describe(
      'The person who asked, by the id list_contacts or search_crm gave: their own address of this kind, as ' +
        'stored, is recorded — the way to record a contact’s address, which the tools print by its domain only. ' +
        'Give this or value.',
    ),
  value: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'The exact address, domain, number or profile URL the person you are helping gave you — never a guess. ' +
        'Give this or contactId.',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('Why, in a few words, kept with the row — e.g. "asked by phone to stop". A row nobody can explain gets removed.'),
}

type SuppressionKindName = (typeof SUPPRESSION_KINDS)[number]

/** A contact's own address of a kind, as stored — never a domain, which their colleagues share. */
const OWN_ADDRESS: Record<Exclude<SuppressionKindName, 'domain'>, { readonly field: 'email' | 'phone' | 'linkedinUrl'; readonly words: string }> = {
  email: { field: 'email', words: 'email address' },
  phone: { field: 'phone', words: 'phone number' },
  linkedin: { field: 'linkedinUrl', words: 'LinkedIn profile' },
}

/**
 * How many contacts of this org the stored key covers — the send path's own
 * reading of each contact's address (`suppressionKeysFor`'s shapes:
 * `normaliseEmail`, the domain after the `@`, E.164, `normaliseLinkedIn`).
 * Read so the summary can say a typed value matched nobody, rather than
 * report a guess as an opt-out recorded.
 */
async function contactsTheKeyCovers(ctx: ToolContext, kind: SuppressionKindName, key: string): Promise<number> {
  const base = eq(schema.contacts.orgId, ctx.orgId)
  const near =
    kind === 'email'
      ? sql`lower(btrim(${schema.contacts.email})) = ${key}`
      : kind === 'domain'
        ? sql`split_part(lower(btrim(${schema.contacts.email})), '@', 2) = ${key}`
        : kind === 'phone'
          ? sql`${schema.contacts.phone} IS NOT NULL`
          : sql`${schema.contacts.linkedinUrl} IS NOT NULL`
  const rows = await ctx.db
    .select({ email: schema.contacts.email, phone: schema.contacts.phone, linkedinUrl: schema.contacts.linkedinUrl })
    .from(schema.contacts)
    .where(and(base, near))
    .limit(20_000)
  return rows.filter((c) =>
    kind === 'email'
      ? normaliseEmail(c.email ?? '') === key
      : kind === 'domain'
        ? (normaliseEmail(c.email ?? '') ?? '').split('@')[1] === key
        : kind === 'phone'
          ? normalisePhone(c.phone ?? '') === key
          : normaliseLinkedIn(c.linkedinUrl ?? '') === key,
  ).length
}

export const addSuppression: AgencyToolSpec<typeof addSuppressionShape> = {
  name: 'add_suppression',
  description:
    'Put an email address, a whole email domain, a phone number or a LinkedIn profile on the suppression list, ' +
    'with the reason — after which no channel may contact it again, whatever any campaign says. To record a ' +
    'contact’s own address, name them by contactId: the tools print addresses by their domain only, so a value ' +
    'typed from that would be a guess. Only an owner can take a row off. It only ever stops messages; nothing ' +
    'is sent.',
  shape: addSuppressionShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // POST /api/suppressions's own gate: any member may add an opt-out.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot add to the suppression list. ${NOTHING_SENT}`)
    }
    const byContact = input.contactId !== undefined
    const byValue = input.value !== undefined && input.value.trim() !== ''
    if (byContact === byValue) {
      return fail(
        'invalid_state',
        'Give contactId — the person whose own address to record — or value, the exact address you were given: ' +
          'exactly one of the two. Nothing was added.',
      )
    }

    // A contact's own address, read here and never printed: the model is
    // shown addresses by their domain only, and a value typed from that
    // would record a key that matches nobody (review round 16).
    let value: string
    let whose: string | null = null
    if (byContact) {
      if (input.kind === 'domain') {
        return fail(
          'invalid_state',
          'A whole domain is never taken from one person: it would stop every address at their company. ' +
            'Name the kind of their own address (email, phone or linkedin) — or, if the whole company asked, give ' +
            'the domain as value. Nothing was added.',
        )
      }
      const found = await contactFor(ctx, { contactId: input.contactId })
      if (!found.ok) return fail(found.code, found.message)
      const own = OWN_ADDRESS[input.kind]
      const stored = found.contact[own.field]
      whose = nameOf(found.contact)
      if (!stored || !stored.trim()) {
        return fail('invalid_state', `${whose} has no ${own.words} on file, so there is none of theirs to record. Nothing was added.`)
      }
      value = stored
    } else {
      value = input.value!
    }

    // A person's add on the suppressions page is `manual` (0018), and a person
    // approved this one; the audit rows say the agent asked.
    const r = await addSuppressionRow(ctx.db, {
      orgId: ctx.orgId,
      kind: input.kind,
      value,
      reason: input.reason,
      source: 'manual',
    })
    if (!r.ok) {
      // The writer's sentence quotes what it could not read; of a contact's
      // stored address that is their address, which is not printed.
      return fail(
        'invalid_state',
        whose === null
          ? `${r.message} Nothing was added.`
          : `${whose}’s ${OWN_ADDRESS[input.kind as Exclude<SuppressionKindName, 'domain'>].words} on file could not be ` +
              'read as one, so no suppression could match it — correct it on /contacts, then record it. Nothing was added.',
      )
    }

    // The route's own row, through the builder it uses: the one place the log
    // holds the value, by design (audit.ts).
    await appendAudit(
      ctx.db,
      auditSuppressionAdded({
        orgId: ctx.orgId,
        actor: 'agent',
        alreadyPresent: r.alreadyPresent,
        kind: input.kind,
        value: r.value,
        reason: input.reason,
      }),
    ).catch(() => {})
    const rows = await ctx.db
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.orgId, ctx.orgId),
          eq(schema.suppressions.kind, input.kind),
          eq(schema.suppressions.value, r.value),
        ),
      )
      .limit(1)
    const suppressionId = rows[0]?.id ?? null
    const covers = await contactsTheKeyCovers(ctx, input.kind, r.value)
    await ctx.audit('agent.add_suppression', {
      suppressionId,
      kind: input.kind,
      alreadyPresent: r.alreadyPresent,
      contactId: input.contactId ?? null,
      contactsCovered: covers,
    })

    const words = KIND_WORDS[input.kind]
    const what =
      whose !== null
        ? `${whose}’s ${OWN_ADDRESS[input.kind as Exclude<SuppressionKindName, 'domain'>].words} on file`
        : words.gave
    const coverage =
      whose !== null
        ? ''
        : input.kind === 'domain'
          ? ` ${plural(covers, 'contact')} on file ${covers === 1 ? 'has an address' : 'have addresses'} at it.`
          : covers === 0
            ? ' It matches no contact on file: if the person who asked is in the CRM, their address is a different ' +
              'one — name them by contactId to record their own.'
            : ` It is the ${words.label.toLowerCase()} of ${plural(covers, 'contact')} on file.`
    return ok(
      { suppressionId, kind: input.kind, alreadyPresent: r.alreadyPresent, contactId: input.contactId ?? null, contactsCovered: covers },
      r.alreadyPresent
        ? `${words.label} suppression was already recorded — ${what} was on the suppression list, and nothing ` +
            `changed. Nothing will be sent to it.${coverage} ${NOTHING_SENT}`
        : `${words.label} suppression recorded — nothing will be sent to ${what} on any channel, whatever a ` +
            `campaign says; only an owner can take it off, on /suppressions.${coverage} ${NOTHING_SENT}`,
    )
  },
}

