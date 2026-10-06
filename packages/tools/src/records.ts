/**
 * The records tools: the companies and people in the CRM, the pause that
 * holds a person from every campaign, and the suppression list (2026-10-06).
 *
 * `list_contacts` is a READ (`low`). Every other tool here writes internal
 * state (`medium`, so the gate asks a person before each call) — except
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
 * Three rules are the agent's own, on top of a person's:
 *
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
  can, normaliseEmail, normaliseLinkedIn, normalisePhone, pauseReasonClass,
  type PauseReasonClass, type SuppressionKind,
} from '@agency/core'
import {
  COMPLIANCE_UNSENT_STATUSES, addSuppression as addSuppressionRow, appendAudit, auditSuppressionAdded, companiesUpdate,
  companyPatchInput, consentLedgerFor, contactInput, contactPatchInput, contactPauseByHand, contactResumeByHand,
  contactsLedger, contactsUpdate, createContact, findCompanyByDomain, importCompanies as importCompanyRows,
  isKnownTimeZone, isSharedNumberOptOutPause, updateContactTimeZone,
  type ConsentLedger, type ContactPauseOutcome, type ContactResumeOutcome, type ContactRow,
  type ContactsUpdateOutcome, type LedgerRow,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { isScannableHost, normaliseDomain } from '@agency/scanner'
import {
  bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolErrorCode, type ToolOutcome,
} from './spec.js'

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
    .describe('Who, by their email address on file. Give this or contactId, not both.'),
}

interface FoundContact {
  readonly ok: true
  readonly contact: ContactRow
  readonly domain: string
  /** The zone quiet hours fall back to for a person with none of their own. */
  readonly companyTimeZone: string | null
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
    .select({ contact: schema.contacts, domain: schema.companies.domain, companyTimeZone: schema.companies.timeZone })
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
  return { ok: true, contact: row.contact, domain: row.domain, companyTimeZone: row.companyTimeZone }
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

const addCompanyShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company’s own public website domain, e.g. "rentman.io". A URL is read for its host.'),
  name: companyNameField.optional().describe('The company’s name, if known.'),
  country: companyCountryField.optional().describe('Its country, as people write it. Never used to guess a time zone.'),
  timeZone: companyZoneField
    .optional()
    .describe(
      'Its IANA time zone, e.g. Europe/Amsterdam. Quiet hours fall back to it for people here who have none of their own.',
    ),
}

const COMPANY_FIELD_WORDS: Record<string, string> = { name: 'name', country: 'country', timeZone: 'time zone' }

/** "named Rentman, in the Netherlands, time zone Europe/Amsterdam" — what the row says now. */
function companyFacts(c: Company): string {
  return [
    c.name ? `named ${oneLine(c.name, 80)}` : 'no name recorded',
    c.country ? `country ${oneLine(c.country, 60)}` : 'no country recorded',
    c.timeZone ? `time zone ${oneLine(c.timeZone, 64)}` : 'no time zone',
  ].join(', ')
}

export const addCompany: AgencyToolSpec<typeof addCompanyShape> = {
  name: 'add_company',
  description:
    'Add one company to the CRM by the domain of its own public website, with a name, country and IANA time ' +
    'zone if known. A company already there is left exactly as it is. It records only that the team intends to ' +
    'look at the company: nothing is scanned (scan_company does that when asked), and nothing is sent.',
  shape: addCompanyShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The import page's own gate.
    if (!can(ctx.principal, 'companies:write')) {
      return fail('not_permitted', `The person you are helping cannot add companies. ${NOTHING_SENT}`)
    }
    const addable = addableDomain(input.domain)
    if (!addable.ok) return fail(addable.code, `${addable.message} Nothing was added.`)
    const { domain } = addable

    // The country and zone are checked as `companiesUpdate` checks them, BEFORE
    // anything is written: a refused zone must not leave a company half-added.
    const extras = companyPatchInput.safeParse({
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
    })
    if (!extras.success) return fail('invalid_state', `${issueWords(extras.error)} Nothing was added.`)
    if (extras.data.timeZone && !isKnownTimeZone(extras.data.timeZone)) {
      return fail('invalid_state', `${unknownZone(extras.data.timeZone)} Nothing was added.`)
    }

    const existing = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (existing) {
      await ctx.audit('agent.add_company', { companyId: existing.id, created: false })
      return ok(
        { companyId: existing.id, domain, created: false },
        `${domain} is already in the CRM (${companyFacts(existing)}); nothing was changed. update_company changes ` +
          `its name, country or time zone. ${NOTHING_SENT}`,
      )
    }

    // Source 'agent', so the CRM records that a model put this row here.
    const name = input.name?.trim()
    const result = await importCompanyRows(ctx.db, ctx.orgId, [{ domain, ...(name ? { name } : {}) }], 'agent')
    let company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) throw new Error('a company just imported could not be read back')
    const created = result.inserted === 1

    // Only a row this call created gets the country and zone: one somebody
    // else added between the read and the insert is theirs, as they wrote it.
    if (created && Object.keys(extras.data).length > 0) {
      const updated = await companiesUpdate(ctx.db, ctx.orgId, company.id, extras.data)
      if (!updated.ok) {
        return fail(
          updated.reason === 'not_found' ? 'not_found' : 'invalid_state',
          `${domain} was added, but its country and time zone were not set: ${updated.message}`,
        )
      }
      company = updated.company
      if (updated.changed.length > 0) {
        await appendAudit(ctx.db, {
          orgId: ctx.orgId,
          actor: 'agent',
          action: 'company.updated',
          subjectType: 'company',
          subjectId: company.id,
          detail: { fields: updated.changed },
        }).catch(() => {})
      }
    }

    await ctx.audit('agent.add_company', { companyId: company.id, created })
    if (!created) {
      return ok(
        { companyId: company.id, domain, created: false },
        `${domain} was added by somebody else a moment ago (${companyFacts(company)}); nothing was changed. ` +
          `update_company changes its name, country or time zone. ${NOTHING_SENT}`,
      )
    }
    return ok(
      { companyId: company.id, domain, created: true },
      `Added ${domain} to the CRM: ${companyFacts(company)}. Nothing has been scanned — it has no score and no ` +
        `findings until a scan runs; ask to scan it with scan_company. ${NOTHING_SENT}`,
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
}

const COMPANY_REFUSAL: Record<Extract<Awaited<ReturnType<typeof companiesUpdate>>, { ok: false }>['reason'], ToolErrorCode> = {
  not_found: 'not_found',
  invalid: 'invalid_state',
}

export const updateCompany: AgencyToolSpec<typeof updateCompanyShape> = {
  name: 'update_company',
  description:
    'Change a company’s name, country or IANA time zone in the CRM — the zone is the one quiet hours fall back ' +
    'to for people there with none of their own, and it is never guessed from the country. The domain cannot ' +
    'be changed. This changes the CRM only; nothing is sent.',
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
    }
    if (Object.keys(patch).length === 0) {
      return fail('invalid_state', `Say what to change: a name, a country or a time zone. ${UNCHANGED}`)
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
    return ok(
      { companyId: now.id, domain: now.domain, changed: r.changed },
      `${now.domain}: changed its ${r.changed.map((f) => COMPANY_FIELD_WORDS[f] ?? f).join(', ')} — now ` +
        `${companyFacts(now)}.` +
        (zoneGone
          ? ' With no time zone here, nothing can be sent to people at this company who have none of their own.'
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
        domain: z.string().min(1).max(253).describe('The company’s own public website domain.'),
        name: companyNameField.optional().describe('Its name, if known.'),
      }),
    )
    .min(1)
    .max(50)
    .describe('Up to 50 companies, each by the domain of its own public website, with a name if known.'),
}

type ImportOutcome = 'added' | 'already_present' | 'refused' | 'duplicate'

interface ImportLine {
  readonly line: number
  readonly domain: string
  readonly outcome: ImportOutcome
  readonly why: string | null
}

export const importCompanies: AgencyToolSpec<typeof importCompaniesShape> = {
  name: 'import_companies',
  description:
    'Add a list of up to 50 companies to the CRM by the domains of their own public websites, with names if ' +
    'known. Companies already there are left exactly as they are, and each line is reported as added, already ' +
    'present or refused with why. Nothing is scanned (scan_company does that when asked), and nothing is sent.',
  shape: importCompaniesShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The import page's own gate.
    if (!can(ctx.principal, 'companies:write')) {
      return fail('not_permitted', `The person you are helping cannot add companies. ${NOTHING_SENT}`)
    }

    const checked: Array<{ line: number; domain: string; refused: string | null; duplicate: boolean }> = []
    const rows: Array<{ domain: string; name?: string }> = []
    const seen = new Set<string>()
    input.companies.forEach((row, i) => {
      const addable = addableDomain(row.domain)
      if (!addable.ok) {
        checked.push({ line: i + 1, domain: oneLine(row.domain, 100), refused: addable.message, duplicate: false })
        return
      }
      if (seen.has(addable.domain)) {
        checked.push({ line: i + 1, domain: addable.domain, refused: null, duplicate: true })
        return
      }
      seen.add(addable.domain)
      const name = row.name?.trim()
      rows.push({ domain: addable.domain, ...(name ? { name } : {}) })
      checked.push({ line: i + 1, domain: addable.domain, refused: null, duplicate: false })
    })

    // Source 'agent'. `ON CONFLICT DO NOTHING`: a company already here keeps its row as it is.
    const result = rows.length > 0 ? await importCompanyRows(ctx.db, ctx.orgId, rows, 'agent') : null
    const inserted = new Set(result?.domains ?? [])
    const lines: ImportLine[] = checked.map((c) => ({
      line: c.line,
      domain: c.domain,
      why: c.refused,
      outcome: c.refused !== null ? 'refused' : c.duplicate ? 'duplicate' : inserted.has(c.domain) ? 'added' : 'already_present',
    }))
    const count = (o: ImportOutcome): number => lines.filter((l) => l.outcome === o).length
    const added = lines.filter((l) => l.outcome === 'added').map((l) => l.domain)
    const present = lines.filter((l) => l.outcome === 'already_present').map((l) => l.domain)
    const refused = lines.filter((l) => l.outcome === 'refused')

    await ctx.audit('agent.import_companies', {
      added: count('added'),
      alreadyPresent: count('already_present'),
      refused: count('refused'),
      duplicates: count('duplicate'),
    })

    const detail = [
      ...(added.length ? [`Added: ${added.join(', ')}`] : []),
      ...(present.length ? [`Already in the CRM, left as they were: ${present.join(', ')}`] : []),
      ...refused.map((l) => `Refused, line ${l.line} ("${l.domain}"): ${l.why}`),
    ]
    return ok(
      { lines, added: added.length, alreadyPresent: present.length, refused: refused.length, duplicates: count('duplicate') },
      [
        `${plural(added.length, 'company', 'companies')} added, ${present.length} already in the CRM, ` +
          `${refused.length} refused` +
          (count('duplicate') > 0 ? `, ${count('duplicate')} listed twice (counted once)` : '') +
          '.',
        bounded(detail, 6_000),
        added.length > 0
          ? 'Nothing has been scanned — a new company has no score and no findings until a scan runs; ask to scan ' +
            `one with scan_company. ${NOTHING_SENT}`
          : NOTHING_SENT,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  },
}

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

const addContactShape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company they are at, by its domain. add_company first if it is not in the CRM.'),
  firstName: contactFields.firstName.optional().describe('Their first name.'),
  lastName: contactFields.lastName.optional().describe('Their last name.'),
  title: contactFields.title.optional().describe('Their job title.'),
  email: contactFields.email.optional().describe('Their work email address.'),
  phone: contactFields.phone
    .optional()
    .describe('Their phone number in international form with the country code, e.g. +44 20 7946 0958.'),
  linkedinUrl: contactFields.linkedinUrl
    .optional()
    .describe('Their LinkedIn profile URL, e.g. linkedin.com/in/jane-doe.'),
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
    'number in international form, or a LinkedIn profile — and their IANA time zone if known. It records NO ' +
    'consent of any kind (absence is no) and puts them in no campaign; nothing is sent.',
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
    const phone = rawPhone ? normalisePhone(rawPhone) : null
    if (rawPhone && !phone) return fail('invalid_state', `${PHONE_UNREADABLE(rawPhone)} Nothing was added.`)
    const linkedinUrl = input.linkedinUrl?.trim() || null
    if (linkedinUrl && !normaliseLinkedIn(linkedinUrl)) {
      return fail('invalid_state', `${LINKEDIN_UNREADABLE(linkedinUrl)} Nothing was added.`)
    }

    // The route's parse, then the route's writer: it folds the email, checks
    // the zone, refuses a duplicate address in this org with a sentence.
    const parsed = contactInput.safeParse({
      companyId: company.id,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      email: input.email?.trim() || null,
      phone,
      linkedinUrl,
      timeZone: input.timeZone?.trim() || null,
      source: 'agent',
    })
    if (!parsed.success) return fail('invalid_state', `${issueWords(parsed.error)} Nothing was added.`)
    const result = await createContact(ctx.db, ctx.orgId, parsed.data)
    if (!result.ok) return fail('invalid_state', `${result.message} Nothing was added.`)
    const contact = result.contact

    // The route's own row, as it writes it: never the address (§2.3).
    await appendAudit(ctx.db, {
      orgId: ctx.orgId,
      actor: 'agent',
      action: 'contact.created',
      subjectType: 'contact',
      subjectId: contact.id,
      detail: { companyId: contact.companyId, source: contact.source, hasTimeZone: !!contact.timeZone },
    }).catch(() => {})
    await ctx.audit('agent.add_contact', { contactId: contact.id, companyId: company.id })

    const reach = [
      contact.email ? `email ${maskEmail(contact.email)}` : null,
      contact.phone ? 'a phone number (stored in international form)' : null,
      contact.linkedinUrl ? 'a LinkedIn profile' : null,
    ].filter(Boolean)
    return ok(
      {
        contactId: contact.id,
        domain: company.domain,
        email: maskEmail(contact.email),
        hasPhone: !!contact.phone,
        hasLinkedIn: !!contact.linkedinUrl,
        timeZone: contact.timeZone,
        consentRecorded: false,
      },
      `Added ${personWithId(contact, company.domain)}; on file: ${reach.join(', ')}. ` +
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
    .describe('Their NEW email address; an empty string clears it. Refused while a message to them is waiting to go out.'),
  phone: contactFields.phone
    .optional()
    .describe('Their NEW phone number, in international form; an empty string clears it. Refused while a message to them waits.'),
  linkedinUrl: contactFields.linkedinUrl
    .optional()
    .describe('Their NEW LinkedIn profile URL; an empty string clears it. Refused while a message to them waits.'),
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
    'for an unrecorded opt-out. An address is never changed while a message to them waits to go out. Nothing ' +
    'is sent.',
  shape: updateContactShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // PATCH /api/contacts/[id]'s own gate.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot edit contacts. ${NOTHING_SENT}`)
    }
    const found = await contactFor(ctx, input)
    if (!found.ok) return fail(found.code, found.message)
    const { contact, domain, companyTimeZone } = found

    const patch: Partial<Record<(typeof PATCH_FIELDS)[number], string>> = {}
    for (const f of PATCH_FIELDS) if (input[f] !== undefined) patch[f] = input[f]
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

    // The route's parse, then the route's writer, with every refusal it words:
    // a suppression that would stop matching, a shared number's hold, a
    // duplicate address, an edit raced by an opt-out.
    let changed: string[] = []
    let bounceCleared = false
    let after: ContactRow = contact
    if (Object.keys(patch).length > 0) {
      const parsed = contactPatchInput.safeParse(patch)
      if (!parsed.success) return fail('invalid_state', `${issueWords(parsed.error)} ${UNCHANGED}`)
      const r = await contactsUpdate(ctx.db, ctx.orgId, contact.id, parsed.data, { actor: 'agent' })
      if (!r.ok) return fail(UPDATE_REFUSAL[r.reason], unchanged(r.message))
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
      ...(changed.includes('email') ? [`Their email is now ${maskEmail(after.email) ?? 'cleared'}.`] : []),
      ...(bounceCleared ? ['The bounce mark on their old address was lifted with it.'] : []),
      ...(changed.includes('phone') && after.phone ? ['Their phone is stored in international form.'] : []),
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
      'What the value is: an email address, a whole email domain, a phone number in international form, or a ' +
        'LinkedIn profile URL.',
    ),
  value: z.string().min(1).max(500).describe('The address, domain, number or profile URL to suppress.'),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('Why, in a few words, kept with the row — e.g. "asked by phone to stop". A row nobody can explain gets removed.'),
}

export const addSuppression: AgencyToolSpec<typeof addSuppressionShape> = {
  name: 'add_suppression',
  description:
    'Put an email address, a whole email domain, a phone number or a LinkedIn profile on the suppression list, ' +
    'with the reason — after which no channel may contact it again, whatever any campaign says. Only an owner ' +
    'can take a row off. It only ever stops messages; nothing is sent.',
  shape: addSuppressionShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // POST /api/suppressions's own gate: any member may add an opt-out.
    if (!can(ctx.principal, 'contacts:write')) {
      return fail('not_permitted', `The person you are helping cannot add to the suppression list. ${NOTHING_SENT}`)
    }
    // A person's add on the suppressions page is `manual` (0018), and a person
    // approved this one; the audit rows say the agent asked.
    const r = await addSuppressionRow(ctx.db, {
      orgId: ctx.orgId,
      kind: input.kind,
      value: input.value,
      reason: input.reason,
      source: 'manual',
    })
    if (!r.ok) return fail('invalid_state', `${r.message} Nothing was added.`)

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
    await ctx.audit('agent.add_suppression', { suppressionId, kind: input.kind, alreadyPresent: r.alreadyPresent })

    const words = KIND_WORDS[input.kind]
    return ok(
      { suppressionId, kind: input.kind, alreadyPresent: r.alreadyPresent },
      r.alreadyPresent
        ? `${words.label} suppression was already recorded — ${words.gave} was on the suppression list, and nothing ` +
            `changed. Nothing will be sent to it. ${NOTHING_SENT}`
        : `${words.label} suppression recorded — nothing will be sent to ${words.gave} on any channel, whatever a ` +
            `campaign says; only an owner can take it off, on /suppressions. ${NOTHING_SENT}`,
    )
  },
}

