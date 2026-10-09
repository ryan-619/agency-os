import {
  AGENCY_TOOL_NAMES, AGENCY_TOOL_RISK, SENSITIVE_KEY, SENSITIVE_VALUE, redact, type SuppressionSource,
} from '@agency/core'
import { inZone } from './format'
import { REFUSAL_WORDS, refusalWords } from './refusal-words'

/**
 * What an audit row SAYS, in front of a person (PROMPT.md §2.3, §2.4).
 *
 * An audit row is an action name, an actor, a subject and a `detail` object,
 * which is exactly right for the record and unreadable as a history. So
 * each catalogued action has one sentence template here, and /audit renders
 * the sentence with the raw row one click away.
 *
 * Three rules the templates keep, and the tests pin:
 *
 *   * **A sentence is built from the row and nothing else.** No template
 *     joins to a message body, a recipient, or a phone number — §2.3's
 *     detail shapes were chosen so the log does not carry them, and a reader
 *     that reconstructed them would undo that. The one join is the company,
 *     by id, which is a public domain.
 *   * **Detail is read through `detailValue` only**, which refuses a key
 *     that looks like a credential (`SENSITIVE_KEY`, the logger's own list)
 *     and a value that looks like a connection string. No template asks for
 *     such a key today; the guard is for the day a writer puts one there.
 *     The raw `<details>` beside it goes through `redact()`, as a backstop.
 *   * **An unknown action is shown as its raw name**, never guessed at. A
 *     writer added next year appears as `thing.happened` until somebody
 *     writes its sentence — honest and ugly rather than wrong.
 *
 * Pure: no `env()`, no database, no `server-only`, no `@/` import, so the
 * whole vocabulary is testable as data (`apps/web/test/audit-copy.test.ts`).
 */

/** The fields of an audit row a sentence may read. */
export interface AuditLine {
  readonly action: string
  readonly actor: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly detail: unknown
}

export interface AuditCompanyRef {
  readonly domain: string
  readonly name: string | null
}

export interface AuditLookups {
  /** The company the row is about, from `auditSubjectsToCompanies`, if one resolved. */
  readonly company?: AuditCompanyRef | null
  /** A display name for a user id found inside `detail` — an approver, a new owner, a handoff target. */
  readonly person?: (userId: string) => string | null
}

// ---------------------------------------------------------------------------
// Reading detail
// ---------------------------------------------------------------------------

/**
 * One value out of `detail`, or undefined. The ONLY way a template reads it.
 * A key that looks like a credential answers nothing, whatever it holds, and
 * so does a string carrying `scheme://user:password@host`.
 */
export function detailValue(detail: unknown, key: string): unknown {
  if (SENSITIVE_KEY.test(key)) return undefined
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return undefined
  const v = (detail as Record<string, unknown>)[key]
  if (typeof v === 'string' && SENSITIVE_VALUE.test(v)) return undefined
  return v
}

function has(detail: unknown, key: string): boolean {
  return (
    !SENSITIVE_KEY.test(key) &&
    detail !== null &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    Object.prototype.hasOwnProperty.call(detail, key)
  )
}

/** Cut by code point, so an emoji is never split in half. */
function clip(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

function text(d: unknown, key: string, max = 100): string | null {
  const v = detailValue(d, key)
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? clip(t, max) : null
}

/** An enum-shaped value (a stage, a channel, a code), or null. Nothing free-text gets through. */
function word(d: unknown, key: string): string | null {
  const v = detailValue(d, key)
  return typeof v === 'string' && /^[a-z][a-z0-9_:-]{0,60}$/i.test(v) ? v : null
}

/**
 * An RFC 3463 delivery status (`5.1.1`, `4.2.2`), or null. `word()` needs a
 * leading letter, so a status read through it never rendered at all — every
 * bounce sentence silently lost the one fact the row carries.
 */
function status(d: unknown, key: string): string | null {
  const v = detailValue(d, key)
  return typeof v === 'string' && /^[245]\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null
}

/** A string value in a known shape (a date, a clock time, a zone), or null. */
function matching(d: unknown, key: string, shape: RegExp): string | null {
  const v = detailValue(d, key)
  return typeof v === 'string' && shape.test(v) ? v : null
}

function num(d: unknown, key: string): number | null {
  const v = detailValue(d, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function flag(d: unknown, key: string): boolean | null {
  const v = detailValue(d, key)
  return typeof v === 'boolean' ? v : null
}

/** How many entries a list in the detail holds — its length only, whatever its entries are. */
function listLength(d: unknown, key: string): number | null {
  const v = detailValue(d, key)
  return Array.isArray(v) ? v.length : null
}

function words(d: unknown, key: string): string[] | null {
  const v = detailValue(d, key)
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9_.:-]{0,80}$/i.test(x))
  return out.length ? out : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A lookup by a string that came out of a row. A plain `map[key]` answers
 * `Object.prototype`'s members too, so an action or channel spelled
 * `constructor` would reach a function where a word was expected.
 */
function own<T>(map: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const spaced = (s: string): string => s.replace(/_/g, ' ')
const quoted = (s: string): string => `“${s}”`
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const CHANNEL_NOUN: Readonly<Record<string, string>> = {
  email: 'email',
  linkedin: 'LinkedIn message',
  sms: 'SMS',
  voice: 'voice message',
  whatsapp: 'WhatsApp message',
}
const CHANNEL_NAME: Readonly<Record<string, string>> = {
  email: 'email', linkedin: 'LinkedIn', sms: 'SMS', voice: 'voice', whatsapp: 'WhatsApp',
}

/** "an email", "a LinkedIn message", "a message". */
function aMessage(channel: string | null): string {
  const noun = own(CHANNEL_NOUN, channel)
  if (!noun) return 'a message'
  return /^[aeiou]/i.test(noun) || noun === 'SMS' ? `an ${noun}` : `a ${noun}`
}
const channelName = (channel: string | null): string =>
  channel ? own(CHANNEL_NAME, channel) ?? spaced(channel) : 'a channel'

const SUPPRESSION_KIND: Readonly<Record<string, string>> = {
  email: 'an email address',
  domain: 'a whole domain',
  phone: 'a phone number',
  linkedin: 'a LinkedIn profile',
}

export interface SourceWords {
  readonly tag: string
  readonly explain: string
}

/**
 * Which path recorded a suppression (0018's `suppressions.source`), for the
 * suppressions page's tag and for a removal's sentence. Keyed by core's
 * `SuppressionSource`, so a sixth source fails this file's typecheck until it
 * has words. `null` is a row written before the column existed — shown as
 * such, never guessed.
 */
export const SUPPRESSION_SOURCE_WORDS: Readonly<Record<SuppressionSource, SourceWords>> = {
  manual: { tag: 'manual', explain: 'added by a person on the suppressions page' },
  reply: { tag: 'reply', explain: 'a reply asked to stop' },
  voice: { tag: 'voice', explain: 'a caller asked to stop, on a call' },
  unsubscribe: { tag: 'unsubscribe', explain: 'the one-click unsubscribe link' },
  erasure: { tag: 'erasure', explain: 'kept when the contact was erased' },
}
export const UNRECORDED_SOURCE: SourceWords = { tag: 'unrecorded', explain: 'recorded before sources were tracked' }

export function suppressionSource(source: string | null): SourceWords {
  if (!source) return UNRECORDED_SOURCE
  // 0018's CHECK admits only the five; anything else is shown as itself, not mapped to one of them.
  return own(SUPPRESSION_SOURCE_WORDS, source) ?? { tag: source, explain: source }
}

const REPLY_KIND: Readonly<Record<string, string>> = {
  interested: 'an interested reply',
  not_now: 'a “not now” reply',
  wrong_person: 'a wrong-person reply',
  auto_reply: 'an auto-reply',
  opted_out: 'a reply asking to stop',
  other: 'a reply',
}

/**
 * What had paused a contact that was resumed — `pauseReasonClass` in
 * packages/db, which is all the inbox writes (never the reason's text).
 */
const PAUSED_FOR: Readonly<Record<string, string>> = {
  replied: 'by their reply',
  unsubscribed: 'by an unsubscribe',
  erasure: 'by an erasure that could not finish',
  manual: 'by a teammate',
  opt_out_not_recorded: 'by an opt-out that could not be recorded',
  other: 'for another reason',
}

/** Why `contact.bounce_unmatched` left a report alone — `outreach.ts`'s own four reasons. */
const BOUNCE_UNMATCHED: Readonly<Record<string, string>> = {
  no_recorded_recipient: 'the returned message has no recorded recipient',
  no_recipient: 'the report names no recipient',
  recipient_mismatch: 'the address it names is not the one that message went to',
  address_changed: 'the contact’s address has changed since that message went',
}

/** Why `cron.digest` did not reach Slack. */
const DIGEST_NOT_POSTED: Readonly<Record<string, string>> = {
  no_slack: 'no Slack webhook is configured',
  slack_failed: 'Slack did not accept it',
}

/** A deal label as `meeting.booked` and `contact.replied` write it: `<outcome>:<stage>`. */
function dealMove(label: string | null): string | null {
  if (!label) return null
  const [outcome, stage] = label.split(':')
  if (!stage || !/^[a-z]+$/.test(stage)) return null
  switch (outcome) {
    case 'created':
      return `opened a deal at ${stage}`
    case 'advanced':
      return `moved the deal to ${stage}`
    case 'unchanged':
      return `the deal stayed at ${stage}`
    default:
      return null
  }
}

/**
 * A company as a sentence names it: its domain. Except a free-mail lead's
 * row, which the booking page files as `<address>.inbound` — that "domain"
 * IS the person's address with its punctuation swapped, so the sentence
 * uses the row's name instead and leaves the address to the company page.
 */
export function companyLabel(c: AuditCompanyRef): string {
  if (c.domain.endsWith('.inbound')) return c.name ? `${c.name} (inbound lead)` : 'an inbound lead'
  return c.domain
}

function domainLabel(d: unknown): string | null {
  const domain = text(d, 'domain', 120)
  if (!domain) return null
  return domain.endsWith('.inbound') ? 'an inbound lead' : domain
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

interface Ctx {
  readonly row: AuditLine
  readonly d: unknown
  /** The company, or "an unknown company". */
  readonly co: string
  /** Whether `co` is a real company — for rows where having none is normal (a task, an export). */
  readonly hasCo: boolean
  readonly person: (id: unknown) => string | null
}
type Template = (c: Ctx) => string

const join = (parts: readonly (string | null | false)[], sep = '; '): string =>
  parts.filter((p): p is string => Boolean(p)).join(sep)
const tail = (parts: readonly (string | null | false)[], lead = ': '): string => {
  const s = join(parts)
  return s ? `${lead}${s}` : ''
}

function when(d: unknown): string | null {
  const at = text(d, 'startsAt', 40)
  const zone = text(d, 'timeZone', 64)
  if (!at || Number.isNaN(Date.parse(at))) return null
  return zone ? inZone(at, zone) : `${at.slice(0, 16).replace('T', ' ')} UTC`
}

const tool = (d: unknown): string => word(d, 'toolName') ?? 'a tool'
const riskNote = (d: unknown): string => {
  const risk = word(d, 'risk')
  return risk ? ` (${risk} risk)` : ''
}
/** "the campaign “Q3 SaaS”", or "a campaign" when the row carries no name. */
const theNamed = (d: unknown, noun: string, key = 'name'): string => {
  const n = text(d, key, 80)
  return n ? `the ${noun} ${quoted(n)}` : `a ${noun}`
}
const who = (c: Ctx): string => (c.row.subjectId ? c.person(c.row.subjectId) : null) ?? 'a teammate'

function exported(c: Ctx, what: string): string {
  const rows = num(c.d, 'rows')
  return `downloaded ${what} as CSV${rows !== null ? ` (${plural(rows, 'row')})` : ''}`
}

function sendHeld(what: string): Template {
  return (c) => `held ${aMessage(word(c.d, 'channel'))} to a contact at ${c.co}: ${what}; it is retried later`
}

const SEND: Record<string, Template> = {
  'send.sent': (c) => {
    const provider = word(c.d, 'provider')
    const approver = has(c.d, 'approvedBy') ? detailValue(c.d, 'approvedBy') : undefined
    const how =
      typeof approver === 'string'
        ? `, approved by ${c.person(approver) ?? 'a teammate'}`
        : approver === null
          ? ' under auto-send'
          : ''
    return `sent ${aMessage(word(c.d, 'channel'))} to a contact at ${c.co}${provider ? ` via ${provider}` : ''}${how}`
  },
  'send.failed': (c) => {
    const err = word(c.d, 'error')
    return `tried to send ${aMessage(word(c.d, 'channel'))} to a contact at ${c.co} and the provider failed${err ? ` (${err})` : ''}`
  },
  'send.no_such_subject': () => 'tried to send for a campaign or contact that no longer exists; nothing was sent',
  // The clock and a paused campaign DEFER a message (the worker re-queues it);
  // everything else in the refusal set is terminal.
  'send.quiet_hours': sendHeld('quiet hours where the recipient is'),
  'send.daily_cap': sendHeld('the campaign reached its daily cap'),
  'send.campaign_inactive': sendHeld('its campaign is not active'),
  'send.needs_approval': (c) =>
    `handed ${aMessage(word(c.d, 'channel'))} to a contact at ${c.co} back for approval: its campaign no longer sends automatically`,
}
for (const code of Object.keys(REFUSAL_WORDS)) {
  SEND[`send.${code}`] ??= (c) =>
    `refused ${aMessage(word(c.d, 'channel'))} to a contact at ${c.co}: ${refusalWords(code)}; nothing was sent`
}

const PROPOSAL_STATUS: Record<string, Template> = {
  'proposal.draft': (c) => `returned the proposal for ${c.co} to draft`,
  'proposal.sent': (c) => `marked the proposal for ${c.co} sent`,
  'proposal.accepted': (c) => `marked the proposal for ${c.co} accepted, which closes the deal as won`,
  'proposal.declined': (c) => `marked the proposal for ${c.co} declined`,
  'proposal.withdrawn': (c) => `withdrew the proposal for ${c.co}`,
}

/**
 * Every agency tool leaves `agent.<tool>` when it runs. The ones above with
 * their own sentence say more; the rest are said from core's registry, so a
 * tool the registry gains has a sentence the day it ships rather than
 * appearing as a raw name. Only the registry's own words are used: a tool
 * that only reads says so, and one that writes says it wrote inside.
 */
const TOOL_SENTENCES: Readonly<Record<string, Template>> = Object.fromEntries(
  AGENCY_TOOL_NAMES.map((name): [string, Template] => {
    const rule = AGENCY_TOOL_RISK[name][1]
    const how =
      rule === 'read_only'
        ? ', which only reads'
        : rule === 'writes_internal_state'
          ? ', which writes inside this system; nothing was sent'
          : ''
    return [`agent.${name}`, () => `ran ${name}${how}`]
  }),
)

const SENTENCES: Readonly<Record<string, Template>> = {
  ...TOOL_SENTENCES,
  // --- the pipeline -------------------------------------------------------
  // Two writers: `POST /api/deals` records `{ stage }`, and `advanceDeal`
  // records every automatic move as `{ from, to }`. Both are read.
  'deal.created': (c) => {
    const stage = word(c.d, 'stage') ?? word(c.d, 'to')
    return `opened a deal for ${c.co}${stage ? ` at ${stage}` : ''}`
  },
  'deal.advanced': (c) => {
    const to = word(c.d, 'stage') ?? word(c.d, 'to')
    const from = word(c.d, 'from')
    if (!to) return `moved the deal for ${c.co} forward`
    return from ? `moved ${c.co} forward from ${from} to ${to}` : `moved ${c.co} forward to ${to}`
  },
  'deal.unchanged': (c) => {
    const stage = word(c.d, 'stage')
    return `asked to advance ${c.co}; the deal was already ${stage ? `at ${stage}` : 'further along'}`
  },
  'deal.moved': (c) => {
    const from = word(c.d, 'from')
    const to = word(c.d, 'to')
    const lost = to === 'lost' ? text(c.d, 'lostReason', 80) : null
    const move = from && to ? `moved ${c.co} from ${from} to ${to}` : `moved the deal for ${c.co}`
    return `${move}${lost ? `: ${quoted(lost)}` : ''}`
  },
  'deal.updated': (c) => {
    const owner = detailValue(c.d, 'ownerUserId')
    const next = text(c.d, 'nextAction', 80)
    return `updated the deal for ${c.co}${tail([
      has(c.d, 'ownerUserId') && (typeof owner === 'string' ? `assigned it to ${c.person(owner) ?? 'a teammate'}` : 'unassigned it'),
      has(c.d, 'nextAction') && (next ? `next action ${quoted(next)}` : 'cleared the next action'),
      has(c.d, 'valueCents') && (num(c.d, 'valueCents') === null ? 'cleared its value' : 'set its value'),
    ])}`
  },
  'deal.next_action_set': (c) => {
    const at = text(c.d, 'to', 40)
    return at && !Number.isNaN(Date.parse(at))
      ? `set the next action on the deal for ${c.co} due ${at.slice(0, 10)}`
      : `cleared when the next action on the deal for ${c.co} is due`
  },
  'meeting.booked': (c) => {
    const at = when(c.d)
    return `recorded a meeting with ${c.co}${at ? ` for ${at}` : ''}${tail(
      [dealMove(text(c.d, 'deal', 40)), flag(c.d, 'needsReview') && 'it needs review'],
      '; ',
    )}`
  },
  'meeting.cancelled': (c) => `cancelled the meeting with ${c.co}`,
  'meeting.outcome_recorded': (c) => {
    const outcome = word(c.d, 'outcome')
    if (!outcome) return `recorded an outcome for the meeting with ${c.co}`
    const at = outcome === 'rescheduled' ? when(c.d) : null
    return `recorded the meeting with ${c.co} as ${spaced(outcome)}${at ? `, to ${at}` : ''}`
  },
  'proposal.generated': (c) => {
    const items = num(c.d, 'scopeItems')
    const streams = num(c.d, 'workstreams')
    const notAssessed = num(c.d, 'notAssessed')
    return `generated a proposal for ${c.co} from its latest scan${tail(
      [
        items !== null && streams !== null && `${plural(items, 'scope item')} in ${plural(streams, 'workstream')}`,
        notAssessed !== null && notAssessed > 0 && `${notAssessed} not assessed`,
      ],
      ' — ',
    )}`
  },
  ...PROPOSAL_STATUS,
  'proposal.exported': (c) => {
    const format = word(c.d, 'format')
    return `exported the proposal for ${c.co}${format ? ` as ${spaced(format)}` : ''}; nothing was sent`
  },
  'proposal.accepted_via_share': (c) =>
    `accepted the proposal for ${c.co} through its share link, which closes the deal as won`,
  // A share link is not a send: a person pastes the URL into a message they write.
  'proposal.share_created': (c) => {
    const until = text(c.d, 'expiresAt', 40)
    const date = until && !Number.isNaN(Date.parse(until)) ? until.slice(0, 10) : null
    return `created a share link for the proposal for ${c.co}${date ? `, open until ${date}` : ''}${
      flag(c.d, 'cappedByEvidence') ? ' (when its evidence ages out)' : ''
    }; nothing was sent`
  },
  'proposal.share_revoked': (c) => `revoked a share link for the proposal for ${c.co}; the link no longer opens`,
  'lead.inbound': (c) => {
    const consented = words(c.d, 'consented')
    return `took a booking for ${c.co} from the public booking page${tail([
      flag(c.d, 'createdCompany') && 'a new company',
      flag(c.d, 'createdContact') ? 'a new contact' : flag(c.d, 'recognised') ? 'a contact already on file' : null,
      consented && `opted in to ${consented.map((ch) => channelName(ch)).join(', ')}`,
    ])}`
  },

  // --- outreach -----------------------------------------------------------
  ...SEND,
  'draft.approved': (c) => `approved a draft ${own(CHANNEL_NOUN, word(c.d, 'channel')) ?? 'message'} to a contact at ${c.co}`,
  'draft.denied': (c) => {
    const note = text(c.d, 'note', 80)
    // A deny on words quoting a scan that aged out OR that a newer scan
    // superseded is recorded as stale_evidence, which enrolment does not
    // count against a new draft. The detail does not say which, and "a
    // re-scan lets it" is false of the second — the re-scan happened, and
    // re-enrolment drafts again straight away — so the words fit both.
    const stale = word(c.d, 'refusalCode') === 'stale_evidence'
    return `denied a draft about ${c.co}${stale ? ' (its evidence was stale — it can be drafted again from a current scan)' : ''}${
      note ? `: ${quoted(note)}` : ''
    }`
  },
  'draft.edited': (c) => {
    // Counts and flags only; the words are never in the log (§2.3).
    const subject = flag(c.d, 'subjectChanged') ? ' and its subject' : ''
    const back = flag(c.d, 'reapprove') ? ' — it had been approved, so it waits for approval again' : ''
    return `edited the words of a draft ${own(CHANNEL_NOUN, word(c.d, 'channel')) ?? 'message'}${subject} about ${c.co}${back}`
  },
  'contact.replied': (c) => {
    const kind = word(c.d, 'replyKind')
    const channel = word(c.d, 'channel')
    const cancelled = num(c.d, 'cancelledQueued')
    return `recorded ${own(REPLY_KIND, kind) ?? 'a reply'}${channel ? ` by ${channelName(channel)}` : ''} from a contact at ${c.co}${tail([
      flag(c.d, 'suppressed') && 'the address went on the suppression list',
      flag(c.d, 'paused') && 'paused them in every campaign',
      cancelled !== null && cancelled > 0 && `cancelled ${cancelled} queued`,
      dealMove(text(c.d, 'deal', 40)),
    ])}`
  },
  // Two writers: a reply filed under a contact (`recordInboundReply`, the
  // contact as subject), and an SMS STOP with no subject and no contact at
  // all. That one comes two ways. `sms.ts`'s `optOutLost` LOOKED: a number
  // no single contact holds, or one that could not be read — there is no
  // contact to name. The DoveSoft route's `record_failed` did not: the
  // recording THREW, most often inside the one matched contact's
  // `recordInboundReply`, which rolled back, so whose number it was is not
  // known and the contact who holds it is to be looked for (review round 5,
  // [14]; it read "a number no single contact holds", and the person
  // following up recorded a bare suppression and never paused them). Nor
  // can it know that nothing was written (review round 7, [8]): a shared
  // number's holders may have been held in one org before another threw,
  // and an earlier delivery may have recorded it all — so the sentence says
  // to CHECK /suppressions, and that the holders may be paused already.
  //
  // And a reply's stop from somebody OTHER than the contact it was filed
  // under (`fromIsContact: false`, review round 7, [7]): a colleague in the
  // thread replying all. Written about the reply or the message it
  // answered, with the contact as `filedUnder`, never as the subject — the
  // inbox reads a row about the contact as THEIR opt-out nobody recorded —
  // and it names the address to record: the sender's, not the contact's.
  //
  // And the contacts who HOLD a number whose STOP could not be recorded,
  // other than the one it was filed under (`sharedNumber`, review round 8):
  // one row per org, about the text when it is stored here, never naming
  // them as the subject or `contactId` — the inbox read a row that did as
  // their own opt-out, however old, and they were locked out for good by a
  // fault DoveSoft's retry recovers from. They are held hard until the
  // number is suppressed, and then eased to the ordinary hold.
  'contact.opt_out_not_recorded': (c) => {
    if (flag(c.d, 'sharedNumber') === true) return sharedNumberOptOut(c.d)
    if (flag(c.d, 'fromIsContact') === false) {
      const lead = `could not record an opt-out from a reply sent by somebody other than the contact at ${c.co} it was filed under`
      const contact = 'the contact is not treated as the one who asked'
      return word(c.d, 'why') === 'record_failed'
        ? `${lead} — recording the reply failed, so the sender may not be on the suppression list: a retry may record it, ` +
            `but check /suppressions for the address the reply came from and record it there if it is missing; ${contact}`
        : `${lead} — the sender is NOT on the suppression list; read their address from the reply and record it by hand; ${contact}`
    }
    if (c.row.subjectType !== 'contact' && !has(c.d, 'contactId') && !has(c.d, 'touchId')) {
      if (word(c.d, 'why') === 'record_failed') {
        return (
          'could not record an opt-out texted in: recording the text failed, so whose number it was is not known, and ' +
          'part of it may already be recorded — by an earlier delivery, or by this one before it failed; it may not be on ' +
          'the suppression list. It was refused so DoveSoft retries, but until a retry is recorded, check /suppressions ' +
          "for the number in the provider's inbound log and record it there if it is missing — anybody holding the " +
          'number may already be paused; pause whoever holds it and is not'
        )
      }
      const why = own(UNPLACED_OPT_OUT_WHY, word(c.d, 'why'))
      return `could not record an opt-out texted from a number no single contact holds${
        why ? ` (${why})` : ''
      } — it is NOT on the suppression list; read the number from the provider's inbound log and record it by hand`
    }
    return `could not record an opt-out from a contact at ${c.co} — it is NOT on the suppression list; follow up by hand`
  },
  'contact.created': (c) => `added a contact at ${c.co}`,
  // Two writers. The contacts route, a person's reason, naming the reply's
  // pause it replaced by CLASS (`replacedPauseFor`) — answering that reply no
  // longer resumes them. And `denyDraft`, putting a reply's pause back when
  // the answer that lifted it was denied (`inboundTouchId`); its reason is
  // the system's own, so the sentence says it instead of quoting it.
  'contact.paused': (c) => {
    if (has(c.d, 'inboundTouchId')) return `paused a contact at ${c.co} — the answer to their reply was denied`
    const reason = text(c.d, 'reason', 80)
    return `paused a contact at ${c.co}${reason ? `: ${quoted(reason)}` : ''}${flag(c.d, 'alreadyPaused') ? ' (already paused)' : ''}${
      word(c.d, 'replacedPauseFor') === 'replied' ? ', replacing the pause their reply caused' : ''
    }`
  },
  // Three writers: the contacts route (a person pressing Resume), the inbox,
  // which resumes only the pause a reply caused and records its CLASS, and
  // `dispatchTouch`, lifting the reply's pause a stuck-send recovery put
  // back over an answer the provider had taken after all (`answerTouchId`,
  // review round 5).
  'contact.resumed': (c) => {
    const why = own(PAUSED_FOR, word(c.d, 'pausedFor'))
    return `resumed a contact at ${c.co}${why ? ` who had been paused ${why}` : ''}${
      has(c.d, 'inboundTouchId')
        ? ', to answer their reply'
        : has(c.d, 'answerTouchId')
          ? ', because the answer to it went after all'
          : ''
    }`
  },
  'contact.timezone_set': (c) => {
    const zone = text(c.d, 'timeZone', 64)
    return zone ? `set the timezone of a contact at ${c.co} to ${zone}` : `cleared the timezone of a contact at ${c.co}`
  },
  'contact.updated': (c) => {
    const fields = words(c.d, 'fields')
    return `edited a contact at ${c.co}${fields ? ` (${fields.map(spaced).join(', ')})` : ''}`
  },
  'contact.exported': (c) => `downloaded the record of a contact at ${c.co}`,
  'contact.erased': (c) => {
    const touches = num(c.d, 'touchesScrubbed')
    const calls = num(c.d, 'callsScrubbed')
    const kept = num(c.d, 'suppressionsAdded')
    return `erased a contact${tail([
      touches !== null && `${plural(touches, 'message')} scrubbed`,
      calls !== null && `${plural(calls, 'call')} scrubbed`,
      kept !== null && `${plural(kept, 'suppression')} kept`,
    ])}`
  },
  'contact.erasure_failed': (c) =>
    `could not erase a contact: nothing was erased and no suppression was recorded${
      flag(c.d, 'paused') ? '; they were paused' : ''
    } — follow up by hand`,
  'contact.unsubscribed': (c) => {
    const addresses = num(c.d, 'addresses')
    const cancelled = num(c.d, 'cancelledQueued')
    return `recorded a one-click unsubscribe from a contact at ${c.co}${tail([
      addresses !== null && addresses > 0 && `${plural(addresses, 'address', 'addresses')} on the suppression list`,
      flag(c.d, 'paused') && 'paused them in every campaign',
      cancelled !== null && cancelled > 0 && `cancelled ${cancelled} queued`,
    ])}`
  },
  // A bounce is evidence about an address, never a suppression: the words say
  // what stopped and what did not.
  'contact.bounced': (c) => {
    const code = status(c.d, 'code')
    const cancelled = num(c.d, 'cancelledQueued')
    return `recorded a hard bounce${code ? ` (${code})` : ''} for a contact at ${c.co}; email to that address stops until it is corrected${
      cancelled !== null && cancelled > 0 ? `, and ${cancelled} queued ${cancelled === 1 ? 'was' : 'were'} cancelled` : ''
    }`
  },
  'contact.bounce_transient': (c) => {
    const code = status(c.d, 'code')
    return `recorded a temporary delivery failure${code ? ` (${code})` : ''} for a contact at ${c.co}; nothing was changed`
  },
  'contact.bounce_cleared': (c) => {
    const code = status(c.d, 'code')
    return `cleared the bounce${code ? ` (${code})` : ''} on a contact at ${c.co}: their email address was changed`
  },
  'contact.bounce_unmatched': (c) => {
    const code = status(c.d, 'code')
    const why = own(BOUNCE_UNMATCHED, word(c.d, 'why'))
    return `did not act on a delivery report${code ? ` (${code})` : ''} about a contact at ${c.co}${why ? `: ${why}` : ''}; no contact was changed`
  },
  'contacts.imported': (c) => {
    const n = (k: string): number | null => num(c.d, k)
    return `imported contacts${tail([
      n('inserted') !== null && `${n('inserted')} added`,
      n('alreadyPresent') !== null && `${n('alreadyPresent')} already present`,
      (n('refused') ?? 0) > 0 && `${n('refused')} refused`,
      (n('unknownCompany') ?? 0) > 0 && `${n('unknownCompany')} for an unknown company`,
      (n('phoneDropped') ?? 0) > 0 && `${n('phoneDropped')} phone numbers dropped`,
    ])}`
  },
  'consent.granted': (c) => {
    const source = text(c.d, 'source', 80)
    return `recorded ${channelName(word(c.d, 'channel'))} consent for a contact at ${c.co}${source ? ` (${source})` : ''}`
  },
  'consent.declined': (c) => `recorded that a contact at ${c.co} declined ${channelName(word(c.d, 'channel'))}`,
  'consent.refusal_lifted': (c) =>
    `lifted a recorded ${channelName(word(c.d, 'channel'))} refusal for a contact at ${c.co}; they are back to never asked, not to yes`,
  'campaign.created': (c) => {
    const cap = num(c.d, 'dailyCap')
    const auto = flag(c.d, 'autoSend')
    return `created ${theNamed(c.d, 'campaign')}${tail(
      [
        word(c.d, 'channel') && channelName(word(c.d, 'channel')),
        auto !== null && `auto-send ${auto ? 'on' : 'off'}`,
        cap !== null && `${cap} a day`,
      ],
      ' — ',
    ).replace(/; /g, ', ')}`
  },
  'campaign.updated': (c) => `updated ${theNamed(c.d, 'campaign')}`,
  'campaign.auto_send_on': (c) =>
    `turned auto-send ON for ${theNamed(c.d, 'campaign')} — its messages now go without a person approving each one`,
  'campaign.auto_send_off': (c) => `turned auto-send off for ${theNamed(c.d, 'campaign')}`,
  'campaign.enrolled': (c) => {
    const queued = num(c.d, 'queued')
    return `enrolled ${queued !== null ? plural(queued, 'contact') : 'contacts'} into a campaign; enrolling queues messages, it sends nothing itself`
  },
  'campaign.steps_saved': (c) => {
    const steps = num(c.d, 'steps')
    if (steps === 0) return 'removed the follow-up steps from a campaign — nobody is followed up after its opener'
    const parts = join([
      (num(c.d, 'messages') ?? 0) > 0 && plural(num(c.d, 'messages')!, 'message'),
      (num(c.d, 'calls') ?? 0) > 0 && plural(num(c.d, 'calls')!, 'call'),
      (num(c.d, 'visits') ?? 0) > 0 && plural(num(c.d, 'visits')!, 'visit'),
    ])
    return `set a campaign's follow-up steps${steps !== null ? ` (${plural(steps, 'step')}${parts ? `: ${parts}` : ''})` : ''}; each message still waits for approval unless the campaign auto-sends`
  },
  'campaign.auto_paused': (c) => {
    const pct = num(c.d, 'bouncePct')
    const limit = num(c.d, 'threshold')
    const bounced = num(c.d, 'bounced')
    const sentTo = num(c.d, 'sentTo')
    const counts = join([bounced !== null && sentTo !== null && `${bounced} of ${sentTo}`, limit !== null && `the limit is ${limit}%`])
    return `paused a campaign automatically${pct !== null ? `: ${pct}% of the addresses it wrote to bounced` : ''}${
      counts ? ` (${counts})` : ''
    }; a person re-activates it`
  },
  'suppression.added': (c) => `added ${own(SUPPRESSION_KIND, word(c.d, 'kind')) ?? 'a value'} to the suppression list`,
  'suppression.already_present': (c) =>
    `tried to add ${own(SUPPRESSION_KIND, word(c.d, 'kind')) ?? 'a value'} that was already on the suppression list; nothing changed`,
  'suppression.removed': (c) => {
    // Only a removal recorded after 0018 carries `hadSource`; its null means
    // the ROW predated sources, which the tag says in the same word as the list.
    const source = has(c.d, 'hadSource') ? ` (source: ${suppressionSource(word(c.d, 'hadSource')).tag})` : ''
    return `removed ${own(SUPPRESSION_KIND, word(c.d, 'kind')) ?? 'a value'} from the suppression list${source}; it may be contacted again`
  },
  'unsubscribe.not_recorded': () =>
    'could not record a one-click unsubscribe — the address is NOT on the suppression list; follow up by hand',
  'reply.handled': (c) => `marked a reply from a contact at ${c.co} handled`,
  'reply.reclassified': (c) => {
    const from = word(c.d, 'from')
    const to = word(c.d, 'to') ?? word(c.d, 'kind')
    const cancelled = num(c.d, 'cancelledQueued')
    // Moving a reply off `auto_reply` does what the reply would have done.
    return `reclassified a reply from a contact at ${c.co}${from && to ? ` from ${spaced(from)} to ${spaced(to)}` : to ? ` as ${spaced(to)}` : ''}${tail([
      flag(c.d, 'paused') && 'paused them in every campaign',
      cancelled !== null && cancelled > 0 && `cancelled ${cancelled} queued`,
    ])}`
  },
  'reply.answer_drafted': (c) =>
    `drafted an answer to a reply from a contact at ${c.co}; it waits for approval and nothing was sent`,
  // --- a suggested answer (0026): never a message, never sent --------------
  'reply.suggested': (c) => {
    const chars = num(c.d, 'chars')
    const model = word(c.d, 'model')
    return `suggested an answer to a reply from a contact at ${c.co}${chars !== null ? ` (${chars} characters` : ''}${model ? `${chars !== null ? ', ' : ' ('}${model}` : ''}${chars !== null || model ? ')' : ''}; it waits on /inbox for a person, and nothing was sent`
  },
  'reply.suggestion_dismissed': (c) => `put away the suggested answer to a reply from a contact at ${c.co}`,
  // --- what came of a call (0027) -------------------------------------------
  'task.outcome_recorded': (c) => {
    const outcome = word(c.d, 'outcome')
    const kind = word(c.d, 'kind') ?? 'call'
    const words: Record<string, string> = {
      reached: 'reached them', no_answer: 'no answer', busy: 'they were busy', wrong_number: 'a wrong number',
      call_back: 'they asked to be called back', not_interested: 'they were not interested', asked_to_stop: 'they asked not to be called',
    }
    return `recorded a ${kind === 'visit' ? 'visit' : 'call'} to ${c.co} as done: ${(outcome && words[outcome]) ?? 'an outcome'}${
      flag(c.d, 'suppressed') ? ' — the number went on the suppression list first' : ''
    }${word(c.d, 'callBackTaskId') ? '; the next call is a task on the day agreed' : ''}`
  },
  // --- what changed (2026-10-09): a scan compared with the one before -------
  'evidence.changed': (c) => {
    const fixed = num(c.d, 'fixed') ?? 0
    const regressed = num(c.d, 'regressed') ?? 0
    const task = word(c.d, 'taskId')
    const parts = [
      regressed > 0 && `${regressed} gap${regressed === 1 ? '' : 's'} opened`,
      fixed > 0 && `${fixed} gap${fixed === 1 ? '' : 's'} fixed`,
    ].filter(Boolean)
    return `compared the latest scan of ${c.co} with the one before: ${parts.join(', ') || 'something changed'}${task ? '; a task was made for the open deal' : ''}`
  },
  'reply.suggestion_used': (c) =>
    `drafted an answer to a reply from a contact at ${c.co} starting from the suggested one; the draft waits for approval`,

  // --- LinkedIn: the provider is a person ----------------------------------
  // Written with the person as actor; the words are never in the row.
  'linkedin.handed': (c) =>
    `was handed a LinkedIn message for a contact at ${c.co} to send from their own account, after every send rule passed`,
  'linkedin.sent': (c) => `said the LinkedIn message for a contact at ${c.co} was sent from their own account`,
  'linkedin.not_sent': (c) =>
    `said the LinkedIn message for a contact at ${c.co} was not sent; it is recorded as failed`,
  'linkedin.dismissed': (c) => `closed a LinkedIn step for a contact at ${c.co} that the send rules had stopped`,

  // --- the agent: its tools, and the gate --------------------------------
  'agent.get_icp': () => 'read the ideal customer profile',
  'agent.search_companies': (c) => {
    const matched = num(c.d, 'matched')
    const returned = num(c.d, 'returned')
    return `searched the companies${matched !== null && returned !== null ? ` (${matched} matched, ${returned} returned)` : ''}`
  },
  'agent.get_company': (c) => `read ${domainLabel(c.d) ?? 'a company'}`,
  'agent.scan_company': (c) => {
    const score = num(c.d, 'score')
    return `scanned the public pages of ${domainLabel(c.d) ?? 'a company'}${score !== null ? ` (score ${score})` : ''}`
  },
  'agent.score_company': (c) => {
    const score = num(c.d, 'score')
    return `scored ${domainLabel(c.d) ?? 'a company'}${score !== null ? ` at ${score}` : ''}${flag(c.d, 'rescanned') ? ' after a fresh scan' : ''}`
  },
  'agent.get_pipeline': (c) => {
    const stage = word(c.d, 'stage')
    const returned = num(c.d, 'returned')
    return `read the pipeline${stage ? ` at ${stage}` : ''}${returned !== null ? ` (${plural(returned, 'deal')})` : ''}`
  },
  'agent.update_deal': (c) => {
    const stage = word(c.d, 'stage')
    const moved = word(c.d, 'moved')
    return `set the deal for ${domainLabel(c.d) ?? 'a company'}${stage ? ` to ${stage}` : ''}${moved === 'unchanged' ? ' (it was already there)' : ''}`
  },
  'agent.book_meeting': (c) => {
    const at = when(c.d)
    return `recorded a meeting with ${domainLabel(c.d) ?? 'a company'}${at ? ` for ${at}` : ''}; no invitation was sent`
  },
  'agent.edit_draft': (c) => {
    if (flag(c.d, 'edited') !== true) return 'tried to rewrite an email draft, and nothing was changed'
    return flag(c.d, 'reapprove')
      ? 'rewrote an approved email draft — it went back to /approvals for the new words'
      : 'rewrote the words of an email draft; nothing was sent'
  },
  'agent.queue_touch': (c) =>
    `queued ${aMessage(word(c.d, 'channel'))} about ${domainLabel(c.d) ?? 'a company'}; nothing was sent by queueing it`,
  'agent.check_send': (c) => {
    const code = word(c.d, 'code')
    const answer = !code ? '' : code === 'send_now' ? ': it may' : `: ${refusalWords(code)}`
    return `checked whether a message about ${domainLabel(c.d) ?? 'a company'} may be sent${answer}; nothing was queued`
  },
  'agent.get_consent': (c) => {
    const at = domainLabel(c.d)
    return `read the consent recorded for a contact${at ? ` at ${at}` : ''}`
  },
  // Never `opted_out`: the tool's enum has no such value, and the row check refuses it again.
  'agent.classify_reply': (c) => {
    const kind = word(c.d, 'kind')
    const from = word(c.d, 'from')
    const done = join([
      kind && `recorded a reply as ${spaced(kind)}${from && from !== kind ? ` (it was ${spaced(from)})` : ''}`,
      flag(c.d, 'handled') === true && (kind ? 'marked it handled' : 'marked a reply handled'),
    ])
    return `${done || 'looked at a reply and changed nothing'}; nothing was sent`
  },
  'agent.tool_pre': (c) => `was about to call ${tool(c.d)}${riskNote(c.d)}`,
  'agent.tool_post': (c) => `finished ${tool(c.d)}`,
  // Since 2026-10-06 the agency's own internal writes run at once too, and the
  // row carries their real tier: "it is low risk" would be false of them.
  'agent.tool_allow': (c) => {
    const risk = word(c.d, 'risk')
    // A read-only research server an owner set to run without asking (connector-reads, 2026-10-07).
    if (word(c.d, 'rule') === 'connector_read') {
      return `ran ${tool(c.d)} without asking — a research connector that only searches and reads, which an owner set to run without asking`
    }
    if (risk === null || risk === 'low') return `ran ${tool(c.d)} without asking — it is low risk`
    if (word(c.d, 'rule') === 'writes_internal_state') {
      return `ran ${tool(c.d)} without asking — it changes only the agency's own records, and sends nothing`
    }
    return `ran ${tool(c.d)} without asking${riskNote(c.d)}`
  },
  'agent.tool_refused': (c) => {
    const rule = word(c.d, 'rule')
    return `was refused ${tool(c.d)}${riskNote(c.d)}${rule ? ` by the rule ${rule}` : ''}`
  },
  // Not "an owner turned it off": a catalog server's send tools are off by
  // default until an owner saves a list, and nobody chose that for this row.
  'agent.tool_disabled': (c) =>
    `was refused ${tool(c.d)}: it is turned off in Settings → Connectors, so nobody was asked`,
  // The morning brief (0020) may only read and scan.
  'agent.tool_unattended': (c) =>
    `was declined ${tool(c.d)} in the morning brief: a run nobody is watching may only read and scan, so it was left as a next step for a person`,
  'approval.requested': (c) => `asked a person to approve ${tool(c.d)}${riskNote(c.d)}`,
  'approval.approved': (c) => {
    if (c.row.actor !== 'agent') return `approved ${tool(c.d)}`
    const by = c.person(detailValue(c.d, 'decidedBy'))
    return `received the approval to run ${tool(c.d)}${by ? ` from ${by}` : ''}`
  },
  'approval.denied': (c) => {
    if (c.row.actor !== 'agent') return `denied ${tool(c.d)}`
    const by = c.person(detailValue(c.d, 'decidedBy'))
    return `was denied ${tool(c.d)}${by ? ` by ${by}` : ''}`
  },
  'approval.expired': (c) => `let a request to run ${tool(c.d)} expire; nobody decided in time`,
  'approval.cancelled': (c) => `cancelled a pending approval for ${tool(c.d)}: the turn ended first`,
  'approval.orphaned_by_worker_restart': (c) =>
    `cancelled a pending approval for ${tool(c.d)}: the worker restarted while it waited`,
  'turn.interrupted_by_worker_restart': () => 'marked a chat turn interrupted: the worker restarted mid-turn',
  'agent.created': (c) => `created ${theNamed(c.d, 'subagent', 'slug')}`,
  'agent.updated': (c) => `updated ${theNamed(c.d, 'subagent', 'slug')}`,
  'agent.deleted': (c) => `deleted ${theNamed(c.d, 'subagent', 'slug')}`,
  'agent.enabled': (c) => `enabled ${theNamed(c.d, 'subagent', 'slug')}`,
  'agent.disabled': (c) => `disabled ${theNamed(c.d, 'subagent', 'slug')}`,

  // --- settings -----------------------------------------------------------
  'connector.created': (c) => {
    const kind = word(c.d, 'kind')
    return `added ${theNamed(c.d, 'connector')}${kind ? ` (${kind})` : ''}${flag(c.d, 'hasCredential') ? ' with a stored credential' : ''}`
  },
  'connector.enabled': (c) => `enabled ${theNamed(c.d, 'connector')}`,
  'connector.disabled': (c) => `disabled ${theNamed(c.d, 'connector')}`,
  'connector.deleted': (c) => `deleted ${theNamed(c.d, 'connector')}`,
  'connector.probe_ok': (c) => {
    const tools = words(c.d, 'tools')
    return `tested ${theNamed(c.d, 'connector')}: it answered${tools ? ` and offered ${plural(tools.length, 'tool')}` : ''}`
  },
  'connector.probe_failed': (c) => `tested ${theNamed(c.d, 'connector')}: it could not be reached`,
  'connector.reads_without_card': (c) =>
    flag(c.d, 'on') === true
      ? `let ${theNamed(c.d, 'connector')} run without asking — it only searches and reads, and every call is still recorded here`
      : `set ${theNamed(c.d, 'connector')} to ask a person on every call again`,
  'connector.tools_disabled': (c) => {
    const tools = words(c.d, 'tools')
    return `changed which tools of ${theNamed(c.d, 'connector')} the agent may use${tools ? ` (${plural(tools.length, 'tool')} off)` : ''}`
  },
  'credential.rotated': (c) => `replaced ${theNamed(c.d, 'stored credential', 'label')}; the value is never in this log`,
  'credential.deleted': (c) => `deleted ${theNamed(c.d, 'stored credential', 'label')}`,
  'user.granted': (c) => {
    const role = word(c.d, 'role')
    return `gave ${who(c)} access${role ? ` as ${role}` : ''}`
  },
  'user.revoked': (c) => {
    const ended = num(c.d, 'sessionsEnded')
    return `revoked the access of ${who(c)}${ended !== null && ended > 0 ? ` and ended ${plural(ended, 'session')}` : ''}`
  },
  'user.restored': (c) => `restored the access of ${who(c)}`,
  'user.role_changed': (c) => {
    const to = word(c.d, 'to') ?? word(c.d, 'role')
    return `changed the role of ${who(c)}${to ? ` to ${to}` : ''}`
  },
  'company.updated': (c) => {
    const fields = words(c.d, 'fields')
    return `edited ${c.co}${fields ? ` (${fields.map(spaced).join(', ')})` : ''}`
  },
  // The agent's `add_note` stores the note in the name of the person whose
  // chat it is (the row must name a person); this row, with actor `agent`
  // and that person as `authorUserId`, is the only place that says so.
  'note.added': (c) => {
    if (c.row.actor !== 'agent') return `added a note on ${c.co}`
    const author = c.person(detailValue(c.d, 'authorUserId'))
    return `wrote a note on ${c.co} in the name of ${author ?? 'a teammate'}; it shows as theirs`
  },
  'note.deleted': (c) => `deleted a note on ${c.co}`,
  'task.created': (c) => `created a task${c.hasCo ? ` for ${c.co}` : ''}`,
  'task.completed': (c) => `completed a task${c.hasCo ? ` for ${c.co}` : ''}`,
  'task.reopened': (c) => `reopened a task${c.hasCo ? ` for ${c.co}` : ''}`,
  'task.assigned': (c) => {
    const to = detailValue(c.d, 'assigneeUserId')
    return typeof to === 'string' ? `assigned a task to ${c.person(to) ?? 'a teammate'}` : 'unassigned a task'
  },
  'task.due_set': (c) => {
    const at = text(c.d, 'dueAt', 40)
    return at && !Number.isNaN(Date.parse(at)) ? `set a task due ${at.slice(0, 10)}` : 'cleared the due date of a task'
  },
  'task.template_applied': (c) => {
    const count = num(c.d, 'count')
    const template = word(c.d, 'template')
    return `added ${count !== null ? plural(count, 'task') : 'tasks'}${template ? ` from the ${spaced(template)} checklist` : ''}${c.hasCo ? ` for ${c.co}` : ''}`
  },

  // --- exports: a download is data leaving through a person ---------------
  'export.companies': (c) => exported(c, 'the companies'),
  'export.findings': (c) => exported(c, 'the findings'),
  'export.consents': (c) => exported(c, 'the consent records'),

  // --- voice --------------------------------------------------------------
  'call.opted_out': (c) => {
    const ok = flag(c.d, 'suppressed')
    return ok === false
      ? 'could not record a caller’s opt-out — the number is NOT on the suppression list; follow up by hand'
      : 'recorded a caller’s opt-out on the suppression list'
  },
  'call.handoff': (c) => {
    const to = c.person(detailValue(c.d, 'toUserId'))
    const reason = text(c.d, 'reason', 80)
    return `handed a call to ${to ?? 'a person'}${reason ? `: ${quoted(reason)}` : ''}`
  },
  'call.ended': (c) => {
    const outcome = word(c.d, 'outcome') ?? word(c.d, 'status')
    const secs = num(c.d, 'durationS')
    const length = secs !== null && secs >= 0 ? `, ${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : ''
    return `ended a call${outcome ? `: ${spaced(outcome)}` : ''}${length}${flag(c.d, 'disclosed') === false ? ' — NO AI DISCLOSURE RECORDED' : ''}`
  },

  // --- operations ---------------------------------------------------------
  'notification.sent': (c) => {
    const event = word(c.d, 'event')
    return `posted ${event ? `a ${spaced(event)}` : 'a'} notification to Slack`
  },
  'notification.failed': (c) => {
    const event = word(c.d, 'event')
    const status = num(c.d, 'status')
    return `could not post ${event ? `a ${spaced(event)}` : 'a'} notification to Slack${status ? ` (HTTP ${status})` : ''}`
  },
  // The claim a delivery takes before it selects anything (rescan.ts); the run's own row follows.
  'scan.cron_started': () => 'started the scheduled rescan; a duplicate delivery before it ends is skipped',
  'scan.cron_run': (c) => {
    const n = (k: string): number | null => num(c.d, k)
    return `ran the scheduled rescan${tail([
      n('scanned') !== null && `${n('scanned')} scanned`,
      (n('unreachable') ?? 0) > 0 && `${n('unreachable')} unreachable`,
      n('remaining') !== null && `${n('remaining')} still due`,
    ]).replace(/; /g, ', ')}`
  },
  'cron.digest': (c) => {
    const why = word(c.d, 'why')
    const digest = flag(c.d, 'posted')
      ? 'posted the daily digest to Slack'
      : `built the daily digest and did not post it${why ? `: ${own(DIGEST_NOT_POSTED, why) ?? spaced(why)}` : ''}`
    // The alert that the worker is silent cannot come from the worker; this row says whether it went.
    const alert = ((): string | null => {
      switch (word(c.d, 'workerAlert')) {
        case 'posted':
          return 'the worker was silent, and a separate alert was posted'
        case 'failed':
          return 'the worker was silent, and the alert could NOT be posted'
        case 'no_slack':
          return 'the worker was silent, and nobody was alerted'
        default:
          // A closed session somebody ran by hand: named in the digest, alerted about by nobody, on purpose.
          return word(c.d, 'worker') === 'retired'
            ? 'no worker is configured and the last one reported in more than a week ago, so it counts as retired and nobody was alerted'
            : null
      }
    })()
    // `found > posted`: pauses past the cap, a notice Slack refused, or no Slack — said, not left in the raw detail.
    const pauses = detailValue(c.d, 'campaignPauses')
    const found = num(pauses, 'found')
    const posted = num(pauses, 'posted')
    let unannounced: string | null = null
    if (found !== null && posted !== null && found > posted) {
      const missed = found - Math.max(0, posted)
      unannounced =
        found === 1
          ? 'a campaign paused itself and got no notice of its own — /campaigns lists it'
          : `${found} campaigns paused themselves and ${
              missed === found ? 'none got a notice of its own' : `${missed} got no notice of their own`
            } — /campaigns lists them`
    }
    return join([digest, alert, unannounced])
  },

  // --- ICP profiles (0021): derived, never edited; one active per org ------
  'icp.created': (c) => {
    const basedOn = text(c.d, 'basedOn', 80)
    const geos = words(c.d, 'geos')
    const min = num(c.d, 'headcountMin')
    const max = num(c.d, 'headcountMax')
    const size =
      min !== null && max !== null ? `${min}–${max} staff` : max !== null ? `up to ${max} staff` : min !== null ? `${min}+ staff` : null
    return `created ${theNamed(c.d, 'ICP profile')}${basedOn ? ` from “${basedOn}”` : ''}${tail([
      geos && geos.length > 0 && `markets ${geos.join(', ')}`,
      size,
    ])}; it is inactive until somebody activates it`
  },
  'icp.activated': (c) => {
    const previous = text(c.d, 'previous', 80)
    return `made ${theNamed(c.d, 'ICP profile')} the active one${previous ? ` (it was “${previous}”)` : ''}; every later scan is scored under it`
  },

  // --- Settings → Organisation: the agency's own name --------------------
  'org.profile_updated': (c) => {
    const fields = words(c.d, 'fields')
    return `updated the business profile quotes print${fields && fields.length > 0 ? ` (${fields.join(', ')})` : ''}`
  },

  // --- Quotes and the links a business opens (0023) ------------------------
  'quote.created': (c) => {
    const number = word(c.d, 'number')
    const lines = num(c.d, 'lines')
    return `raised quote ${number ?? ''}${lines !== null ? ` with ${lines} ${lines === 1 ? 'line' : 'lines'}` : ''}`.replace(/\s+/g, ' ').trim()
  },
  'quote.updated': (c) =>
    flag(c.d, 'revisedFromSent') ? 'revised a sent quote — it is a draft again and its links no longer open' : 'edited a draft quote',
  'quote.sent': (c) => `marked quote ${word(c.d, 'number') ?? ''} sent`.replace(/\s+/g, ' ').trim(),
  'quote.accepted': (c) => `recorded quote ${word(c.d, 'number') ?? ''} as accepted — the deal is won`.replace(/\s+/g, ' ').trim(),
  'quote.declined': (c) => `recorded quote ${word(c.d, 'number') ?? ''} as declined`.replace(/\s+/g, ' ').trim(),
  'quote.withdrawn': (c) => `withdrew quote ${word(c.d, 'number') ?? ''} — its links no longer open`.replace(/\s+/g, ' ').trim(),
  'quote.accepted_via_share': (c) =>
    `the buyer accepted quote ${word(c.d, 'number') ?? ''} through its link — the deal is won`.replace(/\s+/g, ' ').trim(),
  'quote.declined_via_share': (c) => `the buyer declined quote ${word(c.d, 'number') ?? ''} through its link`.replace(/\s+/g, ' ').trim(),
  'quote.email_drafted': (c) =>
    `drafted the email carrying quote ${word(c.d, 'number') ?? ''} — it waits on Approvals`.replace(/\s+/g, ' ').trim(),
  'check.requested': (c) => {
    if (flag(c.d, 'recognised') !== true) {
      return 'a business asked for a free website check through the public page — filed as inbound, with the email consent the form asked for'
    }
    const by = matching(c.d, 'by', /^(site|address|site_and_address)$/)
    const what = by === 'site' ? 'a site' : by === 'address' ? 'an address' : by === 'site_and_address' ? 'a site and an address' : 'something'
    const task = matching(c.d, 'task', /^(made|already_open|not_made)$/)
    return `somebody asked for a free website check through the public page naming ${what} already on file — nothing was scanned, changed or sent, and they were only thanked; ${
      task === 'made' ? 'a task was made to confirm who asked'
        : task === 'already_open' ? 'a task to confirm who asked was already open'
          : task === 'not_made' ? 'the task to confirm who asked could not be made — check who it was by hand'
            : 'confirm who asked before replying'
    }`
  },
  'cert.alerted': (c) => {
    const left = num(c.d, 'daysLeft')
    const expires = matching(c.d, 'expires', /^\d{4}-\d{2}-\d{2}$/)
    return `made a task to tell a business its website’s certificate ${
      left !== null && left < 0 ? 'has expired' : `expires${expires ? ` on ${expires}` : ''}`
    } — seen by our scan; nothing was sent`
  },
  'night.updated': (c) => {
    const on = flag(c.d, 'enabled') === true
    const at = word(c.d, 'at')
    const zone = text(c.d, 'timeZone', 64)
    return on
      ? `switched the night shift on${at ? `, at ${at}` : ''}${zone ? ` ${zone}` : ''} — it searches Google Maps, files new businesses and scans their sites overnight`
      : 'switched the night shift off'
  },
  'night.requested': () => 'asked for the night shift to run now, at the worker’s next look',
  'night.search_added': () => 'saved a search for the night shift to run',
  'night.search_removed': () => 'removed a night shift search',
  'night.search_toggled': (c) => (flag(c.d, 'active') === true ? 'resumed a night shift search' : 'paused a night shift search'),
  'night.searched': (c) => {
    if (flag(c.d, 'failed') === true) return 'ran a saved search on Google Maps overnight — Google did not answer, so nothing was filed'
    const returned = num(c.d, 'returned')
    const added = num(c.d, 'added')
    return `ran a saved search on Google Maps overnight${returned !== null ? `: ${plural(returned, 'business', 'businesses')} listed` : ''}${
      added !== null ? `, ${added} new to the CRM` : ''
    }`
  },
  'night.ran': (c) => {
    const why = word(c.d, 'why')
    if (why === 'no_searches') return 'ran the night shift with no saved searches — nothing was looked for'
    if (why === 'cap_reached') return 'ran the night shift after the day’s Google Maps searches were used up — nothing was looked for'
    const added = num(c.d, 'added')
    const scanned = num(c.d, 'scanned')
    const audited = num(c.d, 'audited')
    const top = listLength(c.d, 'top')
    return `ran the night shift: ${join([
      added !== null && `${plural(added, 'new business', 'new businesses')} filed`,
      scanned !== null && `${scanned} scanned`,
      audited !== null && `${audited} measured on a phone`,
      top !== null && top > 0 && `the best ${top} listed for the morning`,
    ]) || 'nothing new'}; it sent nothing and contacted nobody`
  },
  'night.failed': (c) => `the night shift failed${word(c.d, 'error') ? ` (${word(c.d, 'error')})` : ''}; it runs again tomorrow night`,
  'sequence.step_taken': (c) => {
    const kind = word(c.d, 'kind')
    const position = num(c.d, 'position')
    const step = position !== null ? `step ${position}` : 'a step'
    return kind === 'message'
      ? `drafted a campaign's follow-up message (${step}) — it goes only as a campaign's messages go: approved, or auto-sent, and checked at sending`
      : `made a ${kind === 'visit' ? 'visit' : 'call'} task — ${step} of a campaign's follow-ups`
  },
  'sequence.step_skipped': (c) => {
    const kind = word(c.d, 'kind')
    const why = word(c.d, 'why')
    if (why === 'channel') {
      return 'skipped a campaign’s follow-up message — the campaign now sends on a channel whose texts are drafted one person at a time from a registered template — and moved on to the next'
    }
    const reason =
      why === 'invalid' ? 'there is no number on record to call' : why === 'suppressed' ? 'the number is on the suppression list' : 'the task could not be made'
    return `skipped a campaign's ${kind === 'visit' ? 'visit' : 'call'} step — ${reason} — and moved on to the next`
  },
  'sequence.stopped': (c) => {
    const why = word(c.d, 'reason')
    const words: Readonly<Record<string, string>> = {
      replied: 'they replied',
      paused: 'they are paused',
      refused: 'its last message did not go',
      deal_closed: 'their deal is closed',
      campaign_ended: 'the campaign is done',
      finished: 'every step has been taken',
    }
    const back = matching(c.d, 'returnedTouchId', /^[0-9a-f-]{36}$/) !== null
    return `stopped following up a contact — ${(why && own(words, why)) ?? 'it ended'}${
      back ? '; its follow-up email, which was queued or approved, went back to Approvals for a person to decide' : ''
    }`
  },
  'share_link.created': (c) => {
    const kind = word(c.d, 'kind')
    const what = kind === 'quote' ? 'a quote' : kind === 'report' ? 'an audit page' : kind === 'preview' ? 'a website preview' : 'a page'
    return `made a link to ${what} for the business to open`
  },
  'share_link.email_drafted': (c) =>
    `drafted the email carrying ${word(c.d, 'kind') === 'preview' ? 'a website preview' : 'an audit page'} — it waits on Approvals`,
  'share_link.revoked': (c) => {
    const kind = word(c.d, 'kind')
    const what = kind === 'quote' ? 'quote' : kind === 'report' ? 'audit page' : kind === 'preview' ? 'website preview' : 'page'
    return `revoked a ${what} link — it no longer opens`
  },

  'org.renamed': (c) => {
    const from = text(c.d, 'from', 80)
    const to = text(c.d, 'to', 80)
    return from && to ? `renamed the organisation from “${from}” to “${to}”` : 'renamed the organisation'
  },

  // --- Listings and the services catalogue (0022) ---------------------------
  'company.listings_added': (c) => {
    const added = num(c.d, 'added') ?? 0
    const refreshed = num(c.d, 'refreshed') ?? 0
    return `added ${added} ${added === 1 ? 'business' : 'businesses'} from Google Maps listings${
      refreshed > 0 ? ` and refreshed the listing of ${refreshed} already here` : ''
    }`
  },
  'service.created': (c) => {
    const needs = num(c.d, 'needs') ?? 0
    return `added a service to the catalogue, answering ${needs} ${needs === 1 ? 'need' : 'needs'}${flag(c.d, 'priced') ? ', with a price' : ''}`
  },
  'service.updated': (c) => {
    const fields = words(c.d, 'fields')
    return `changed a service in the catalogue${fields && fields.length > 0 ? ` (${fields.join(', ')})` : ''}`
  },
  'service.deleted': () => 'removed a service from the catalogue',
  'service.suggested_added': (c) => {
    const added = num(c.d, 'added') ?? 0
    return `added ${added} suggested ${added === 1 ? 'service' : 'services'} to the catalogue, with no prices yet`
  },

  // --- Settings → Assistant (0020): the playbook and the morning brief -----
  // Counts and settings only: the playbook's words are never in the log.
  'assistant.playbook_updated': (c) => {
    const chars = num(c.d, 'chars')
    const before = num(c.d, 'before')
    if (chars === 0) {
      return `cleared the agency playbook the AI reads${before ? ` (it was ${before.toLocaleString('en')} characters)` : ''}`
    }
    const size = chars === null ? '' : ` — ${chars.toLocaleString('en')} characters`
    const was = before === null ? '' : before === 0 ? ', its first version' : `, was ${before.toLocaleString('en')}`
    return `saved the agency playbook the AI reads with every message${size}${was}`
  },
  'assistant.brief_updated': (c) => {
    if (flag(c.d, 'enabled') !== true) return 'switched the morning brief off'
    const at = matching(c.d, 'at', /^([01][0-9]|2[0-3]):[0-5][0-9]$/)
    const zone = matching(c.d, 'timeZone', /^[A-Za-z0-9_+/-]{1,64}$/)
    return `switched the morning brief on${at ? `, every day at ${at}${zone ? ` (${zone})` : ''}` : ''}, running in their name`
  },
  'assistant.brief_requested': () => 'asked for a morning brief now; the worker starts it at its next look',
  'assistant.brief_started': (c) => {
    const date = matching(c.d, 'date', /^\d{4}-\d{2}-\d{2}$/)
    return `started the morning brief${date ? ` for ${date}` : ''}${flag(c.d, 'requested') === true ? ', as asked' : ''}; it only reads and scans`
  },
  'assistant.brief_failed': (c) => {
    const date = matching(c.d, 'date', /^\d{4}-\d{2}-\d{2}$/)
    const why = word(c.d, 'why')
    const because =
      why === 'chat_disabled'
        ? ' — the worker has chat off, and the brief needs its model'
        : why === 'runtime_halted'
          ? ' — the agent runtime had halted'
          : why === 'no_such_conversation'
            ? ' — its thread could not be found'
            : why
              ? ` (${why})`
              : ''
    return `could not start the morning brief${date ? ` for ${date}` : ''}${because}; that day is spent, and it runs again the next`
  },

  // --- DoveSoft (0019): registered templates and SMS -----------------------
  // A template is a registration copied from the DLT portal; an SMS is drafted
  // from one and goes through the one send path. Ids and counts only.
  'template.created': (c) => {
    const id = text(c.d, 'externalId', 64)
    const category = word(c.d, 'category')
    return `recorded ${aChannel(word(c.d, 'channel'))} template${id ? ` (${id})` : ''}${category ? `, ${spaced(category)}` : ''}`
  },
  'template.activated': (c) => {
    const id = text(c.d, 'externalId', 64)
    return `switched ${aChannel(word(c.d, 'channel'))} template back on${id ? ` (${id})` : ''}; messages can be drafted from it again`
  },
  'template.deactivated': (c) => {
    const id = text(c.d, 'externalId', 64)
    return `switched off ${aChannel(word(c.d, 'channel'))} template${id ? ` (${id})` : ''}; a draft written from it is refused at sending`
  },
  'template.imported': (c) => {
    const n = (k: string): number | null => num(c.d, k)
    return `imported templates from a DLT export${tail([
      n('imported') !== null && `${n('imported')} added`,
      (n('alreadyPresent') ?? 0) > 0 && `${n('alreadyPresent')} already present`,
      (n('skipped') ?? 0) > 0 && `${n('skipped')} skipped`,
      (n('refused') ?? 0) > 0 && `${n('refused')} refused`,
    ])}`
  },
  'sms.drafted': (c) =>
    `drafted an SMS to a contact at ${c.co} from a registered template; it waits for approval and nothing was sent`,
  'sms.delivery_unmatched': (c) =>
    `received a delivery report for an SMS this system did not send${
      word(c.d, 'why') === 'ambiguous' ? ' (it named more than one message)' : ''
    }; nothing was changed`,
  // A suppression is claimed only where the row says one was written:
  // `suppressed: true`. A row with no key — an unreadable number's, before
  // r5 wrote `suppressed: false` there — had none written, and read as if it had.
  //
  // Four writers in sms.ts (review round 6): a text filed under nobody; one
  // filed under a contact, whose OTHER holders were held — `filedUnder`
  // says whether under another contact in this org or a contact in another
  // org; and a redelivery of either that only wrote a missing suppression
  // (`redelivered`) — or, since review round 8, eased holders an earlier
  // delivery had held hard (`released`), in the filed org too.
  'sms.inbound_unmatched': (c) => {
    const optOut = flag(c.d, 'optOut') === true
    const stop = optOut
      ? flag(c.d, 'suppressed') === true
        ? '; it asked to stop, and the number was put on the suppression list'
        : '; it asked to stop, and the number is NOT on the suppression list — follow up by hand'
      : ''
    const contacts = num(c.d, 'contacts')
    const redelivered = flag(c.d, 'redelivered') === true
    const filedUnder = word(c.d, 'filedUnder')
    // The hold REPLACES the pause a holder's own unanswered reply had caused
    // (review round 7), so answering that reply no longer lifts it — named
    // by class and count, never the reason.
    const replacedN = word(c.d, 'replacedPauseFor') === 'replied' ? (num(c.d, 'replacedPauses') ?? 1) : 0
    const replaced =
      replacedN <= 0
        ? ''
        : contacts === 1 && replacedN === 1
          ? '; the hold replaced the pause their reply had caused'
          : `; the hold replaced the pause a reply had caused for ${replacedN} of them`
    // The holders a delivery eased from the hard hold an unrecorded STOP
    // left them in, once the number was suppressed (review round 8).
    const eased = released(c.d)
    if (filedUnder === 'another_org') {
      const here = contacts !== null && contacts > 1 ? `${contacts} contacts here hold` : 'a contact here holds'
      return redelivered
        ? `received again a text from a number ${here}, which it had filed under a contact in another organisation${stop}${eased}`
        : `received a text from a number ${here}, and filed it under a contact in another organisation that this system had texted${held(
            c.d, 'contact here holding it', 'contacts here holding it',
          )}${replaced}${stop}${eased}`
    }
    if (filedUnder === 'another_contact') {
      return redelivered
        ? `received again a text from a number more than one contact here holds, which it had filed under one of them${stop}${eased}`
        : `received a text from a number more than one contact here holds, and filed it under the one this system had texted${held(
            c.d, 'other contact holding it', 'other contacts holding it',
          )}${replaced}${stop}${eased}`
    }
    const why = own(SMS_UNMATCHED, word(c.d, 'why')) ?? 'that could not be placed'
    return redelivered
      ? `received again a text from a number ${why}, which it had filed under nobody; nobody was paused again${stop}${eased}`
      : `received a text from a number ${why}, so it was filed under nobody${held(
          c.d, 'contact holding the number', 'contacts holding the number',
        )}${replaced}${stop}${eased}`
  },
  // The two DoveSoft pushes this deployment could not read (/api/inbound/dovesoft/*).
  // Which field was missing, by name — never a value, a number or the words.
  'sms.dlr_unreadable': (c) =>
    `could not read a delivery report DoveSoft sent${unreadableWhy(c.d)}; it was refused so DoveSoft retries, and nothing was changed`,
  'sms.inbound_unreadable': (c) =>
    `could not read a text DoveSoft passed on${unreadableWhy(c.d)}, so nothing was recorded — it may have asked to stop; ` +
    'it was refused so DoveSoft retries, and the field names it did carry are in the error log',
}

/** " (no message id or status)", " (the body was not a form or a JSON object)", " (it was larger …)", or nothing. */
function unreadableWhy(d: unknown): string {
  if (word(d, 'why') === 'unreadable_body') return ' (the body was not a form or a JSON object)'
  if (word(d, 'why') === 'too_large') return ' (it was larger than the route reads)'
  const missing = (words(d, 'missing') ?? []).map((m) => own(UNREADABLE_FIELD, m)).filter((m): m is string => Boolean(m))
  return missing.length ? ` (no ${missing.join(' or ')})` : ''
}

/** The fields an unreadable DoveSoft push lacked, in words. */
const UNREADABLE_FIELD: Readonly<Record<string, string>> = {
  messageid: 'message id',
  status: 'status',
  from: 'sender number',
  text: 'text',
}

/** "an SMS", "a WhatsApp", "a voice" — a channel's name with its article, for a template. */
function aChannel(channel: string | null): string {
  const name = channelName(channel)
  return /^(SMS|[aeiou])/i.test(name) ? `an ${name}` : `a ${name}`
}

/**
 * What a text from a shared number did to the contacts holding it, from
 * `sms.inbound_unmatched`'s counts: how many were paused, of how many, and
 * how many of their waiting messages were cancelled — or nothing when it
 * did neither. Said whenever EITHER count is above zero (review round 6):
 * a holder already paused is not paused again, and their drafts are still
 * cancelled. `one` and `many` name who, as the row's writer counts them.
 */
function held(d: unknown, one: string, many: string): string {
  const paused = num(d, 'paused') ?? 0
  const cancelled = num(d, 'cancelledQueued') ?? 0
  const of = num(d, 'contacts')
  if (paused <= 0 && cancelled <= 0) return ''
  const were = (n: number): string => (n === 1 ? 'was' : 'were')
  const messages = (n: number): string => `${n} queued message${n === 1 ? '' : 's'}`
  let who: string | null = null
  if (paused > 0) {
    if (of !== null && paused >= of) {
      who = of === 1 ? `the ${one} was paused` : of === 2 ? `both ${many} were paused` : `all ${of} ${many} were paused`
    } else if (of !== null) {
      who = `${paused} of the ${of} ${many} ${were(paused)} paused`
    } else {
      who = `${paused === 1 ? `a ${one}` : `${paused} ${many}`} ${were(paused)} paused`
    }
  }
  if (who === null) {
    const to = of === 1 ? `the ${one}` : `the ${many}`
    return `; ${messages(cancelled)} to ${to} ${were(cancelled)} cancelled (already paused, so not paused again)`
  }
  return `; ${who}${cancelled > 0 ? ` and ${messages(cancelled)} cancelled` : ''}`
}

/**
 * `contact.opt_out_not_recorded` for the contacts holding a number whose
 * STOP could not be recorded, other than the one it was filed under
 * (`sharedNumber`, review round 8). Whose words the text was is not said
 * of them — they may have sent nothing — and what holds them, and what ends
 * it, is: Resume is refused until the number is on the suppression list,
 * and the next text DoveSoft delivers from it after that (its retry of this
 * one included) makes it an ordinary hold Resume lifts — except for a holder
 * whose own pause stood (`kept`, review round 9), which no text changes.
 *
 * Which retry comes depends on why (review round 10, [6]): a recording that
 * failed is answered 500 whatever the push carried, so DoveSoft retries it;
 * a suppression that failed is answered 500 only when the push carried a
 * message id — without one its retry could not be told from a new text, so
 * it is answered 200 and no retry comes.
 */
function sharedNumberOptOut(d: unknown): string {
  const n = num(d, 'contacts') ?? 1
  const p = num(d, 'paused') ?? n
  const holds = n === 1 ? 'a contact here holds' : `${n} contacts here hold`
  const why =
    word(d, 'why') === 'record_failed'
      ? 'recording the text failed, so the number may not be on the suppression list; a retry may record it, but check ' +
        '/suppressions for the number on their record and record it there if it is missing'
      : 'the number is NOT on the suppression list; record it by hand on /suppressions, from their record'
  const unpaused =
    p >= n ? '' : p <= 0 ? '; none of them could be paused — pause them by hand' : `; only ${p} of the ${n} could be paused — pause the rest by hand`
  // A holder already held by a pause of their own keeps it (review round 9):
  // no text eases it, and Resume lifts it — where Resume may — only once the
  // number is recorded. `kept` counts them, and `paused` includes them.
  const k = Math.min(num(d, 'kept') ?? 0, n)
  const kept =
    k <= 0
      ? ''
      : `; ${k === n ? (n === 1 ? 'they were' : 'all of them were') : `${k} of them ${k === 1 ? 'was' : 'were'}`} already held by a ` +
        'pause of their own, which stands — no text changes it, and Resume lifts it, where Resume may, only once the number is recorded'
  const retry = word(d, 'why') === 'record_failed' ? 'its retry of this one included' : 'its retry of this one included, where the push carried a message id'
  return (
    `could not record an opt-out texted from a number ${holds} — ${why}. ` +
    'They are not treated as the one who asked, but are held until it is recorded: Resume is refused until then, ' +
    `and the next text DoveSoft delivers from the number after that — ${retry} — makes it an ` +
    `ordinary hold that Resume lifts${kept}${unpaused}`
  )
}

/**
 * `sms.inbound_unmatched`'s word on the holders a delivery eased (review
 * round 8): held hard while the STOP was not recorded, now held as anyone
 * sharing the number is. A count, never who.
 */
function released(d: unknown): string {
  const n = num(d, 'released') ?? 0
  if (n <= 0) return ''
  return n === 1
    ? '; a contact here held while the opt-out was not recorded is now held as anyone sharing the number is, which Resume lifts'
    : `; ${n} contacts here held while the opt-out was not recorded are now held as anyone sharing the number is, which Resume lifts`
}

/** Why `sms.inbound_unmatched` filed a text under nobody — `sms.ts`'s own reasons. */
const SMS_UNMATCHED: Readonly<Record<string, string>> = {
  no_contact: 'no contact has',
  ambiguous: 'more than one contact has',
  unreadable_number: 'that could not be read',
}

/**
 * Why an SMS STOP nobody could place was not recorded: `sms.ts`'s reasons.
 * Anything else is an error's class name, which says nothing a person can
 * act on, and is left out. The DoveSoft route's `record_failed` has a
 * sentence of its own: that writer never learned whose number it was.
 */
const UNPLACED_OPT_OUT_WHY: Readonly<Record<string, string>> = {
  unparseable_number: 'the number could not be read',
}

/** Every action this page has a sentence for. The test iterates it. */
export const AUDIT_ACTIONS: readonly string[] = Object.freeze(Object.keys(SENTENCES).sort())

/**
 * Rows a person must not scroll past: an opt-out that was not stored (or a
 * text that could not be read, which may have been one), and a call with no
 * AI disclosure — §2.1's failures, highlighted rather than
 * rendered like every other line. And one operational failure nobody else
 * will report: the worker went silent and the daily alert reached nobody,
 * either because Slack refused it or because there is no Slack. The worker
 * cannot say it is silent, so on such a deployment this line is the alarm.
 */
export function isAlarm(row: AuditLine): boolean {
  switch (row.action) {
    case 'contact.opt_out_not_recorded':
    case 'unsubscribe.not_recorded':
    case 'contact.erasure_failed':
    // A text nobody could read may have been a STOP that is recorded nowhere.
    case 'sms.inbound_unreadable':
      return true
    // A STOP from a number nobody could be placed under, and no suppression
    // written for it. Only `suppressed: true` says one was.
    case 'sms.inbound_unmatched':
      return flag(row.detail, 'optOut') === true && flag(row.detail, 'suppressed') !== true
    case 'call.opted_out':
      return flag(row.detail, 'suppressed') === false
    case 'call.ended':
      return flag(row.detail, 'disclosed') === false
    case 'cron.digest': {
      const alert = word(row.detail, 'workerAlert')
      return alert === 'failed' || alert === 'no_slack'
    }
    default:
      return false
  }
}

/** The predicate for one row: "moved rentman.io from replied to meeting". Unknown → the raw name. */
export function sentenceFor(row: AuditLine, lookups: AuditLookups = {}): string {
  const template = own(SENTENCES, row.action)
  if (!template) return row.action
  const person = (id: unknown): string | null =>
    typeof id === 'string' && UUID.test(id) ? (lookups.person?.(id) ?? null) : null
  try {
    return template({
      row,
      d: row.detail,
      co: lookups.company ? companyLabel(lookups.company) : 'an unknown company',
      hasCo: Boolean(lookups.company),
      person,
    })
  } catch {
    // A detail shape nobody expected must not take the page down.
    return row.action
  }
}

// ---------------------------------------------------------------------------
// Around the sentence: who, where, and the raw row
// ---------------------------------------------------------------------------

/** Actors that are not people. `audit_log.actor` is text; these are its literals. */
export const ACTOR_LITERALS: Readonly<Record<string, string>> = {
  agent: 'agent',
  system: 'system',
  voice: 'voice',
  booking_page: 'booking page',
  share_link: 'share link',
}

/** A process rather than a person — `agent`, `system`, `voice`, the booking page, a share link. */
export function isActorLiteral(actor: string): boolean {
  return own(ACTOR_LITERALS, actor) !== undefined
}

export interface ResolvedActor {
  readonly email: string | null
  readonly name: string | null
  readonly revoked: boolean
}

/**
 * Who did it, for display. A uuid that resolves is the person (and whether
 * their access has since been revoked — they did this while they had it); a
 * uuid that does not is "a former teammate", never a raw id or a blank.
 */
export function actorLabel(
  actor: string,
  resolved: ReadonlyMap<string, ResolvedActor>,
): { readonly label: string; readonly note: string | null } {
  const literal = own(ACTOR_LITERALS, actor)
  if (literal) return { label: literal, note: null }
  if (UUID.test(actor)) {
    const u = resolved.get(actor)
    if (!u) return { label: 'a former teammate', note: null }
    return { label: u.name || u.email || 'a teammate', note: u.revoked ? 'access since revoked' : null }
  }
  return { label: actor, note: null }
}

/**
 * Where the row's subject lives in the app, or null. Deals, contacts and
 * messages have no page of their own; they link to their company. A subject
 * that is gone links nowhere rather than to a 404.
 */
export function subjectHref(row: AuditLine, company: AuditCompanyRef | null): string | null {
  const id = row.subjectId && UUID.test(row.subjectId) ? row.subjectId : null
  const companyPage = company ? `/companies/${encodeURIComponent(company.domain)}` : null
  switch (row.subjectType) {
    case 'meeting':
      return id ? `/meetings/${id}` : null
    case 'proposal':
      return id ? `/proposals/${id}` : null
    case 'call':
      return id ? `/calls/${id}` : null
    case 'deal':
      return companyPage ?? '/pipeline'
    case 'campaign':
      return '/campaigns'
    case 'approval':
      return '/approvals'
    case 'chat_session':
      return '/chat'
    case 'connector':
      return '/settings/connectors'
    case 'agent_def':
      return '/settings/agents'
    case 'suppression':
      return '/suppressions'
    case 'task':
      return '/tasks'
    case 'user':
      return '/settings/team'
    case 'secret':
      return '/settings/credentials'
    case 'assistant':
      return '/settings/assistant'
    case 'icp_profile':
      return '/settings/icp'
    case 'service':
      return '/settings/services'
    case 'org':
      return '/settings'
    case 'quote':
      return id ? `/quotes/${id}` : '/quotes'
    default:
      return companyPage
  }
}

/** Filter choices. The families are the first segment of every catalogued action. */
const FAMILY_LABEL: Readonly<Record<string, string>> = {
  deal: 'Deals', meeting: 'Meetings', proposal: 'Proposals', lead: 'Booking page', send: 'Sending',
  draft: 'Drafts', contact: 'Contacts', contacts: 'Contact imports', consent: 'Consent', campaign: 'Campaigns',
  suppression: 'Suppressions', unsubscribe: 'Unsubscribes', reply: 'Replies', agent: 'Agent and subagents',
  approval: 'Approvals', turn: 'Chat turns', connector: 'Connectors', credential: 'Credentials', user: 'Team',
  company: 'Companies', note: 'Notes', task: 'Tasks', call: 'Calls', notification: 'Notifications',
  scan: 'Scheduled rescans', cron: 'Scheduled jobs', export: 'Exports', linkedin: 'LinkedIn steps',
  template: 'Message templates', sms: 'SMS', assistant: 'Assistant', icp: 'ICP profiles', service: 'Services', org: 'Organisation', quote: 'Quotes', share_link: 'Shared links', sequence: 'Follow-up sequences', night: 'Night shift', cert: 'Certificates', check: 'Website checks',
}
export const AUDIT_FAMILIES: readonly { readonly value: string; readonly label: string }[] = Object.freeze(
  [...new Set(AUDIT_ACTIONS.map((a) => a.split('.')[0] ?? a))].map((value) => ({
    value,
    label: own(FAMILY_LABEL, value) ?? value,
  })),
)

export const AUDIT_SUBJECT_TYPES: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: 'deal', label: 'A deal' },
  { value: 'contact', label: 'A contact' },
  { value: 'touch', label: 'A message' },
  { value: 'meeting', label: 'A meeting' },
  { value: 'proposal', label: 'A proposal' },
  { value: 'campaign', label: 'A campaign' },
  { value: 'suppression', label: 'The suppression list' },
  { value: 'approval', label: 'An approval' },
  { value: 'chat_session', label: 'A chat' },
  { value: 'call', label: 'A call' },
  { value: 'connector', label: 'A connector' },
  { value: 'agent_def', label: 'A subagent' },
  { value: 'company', label: 'A company' },
  { value: 'note', label: 'A note' },
  { value: 'task', label: 'A task' },
  { value: 'user', label: 'A teammate' },
  { value: 'secret', label: 'A stored credential' },
  { value: 'message_template', label: 'A message template' },
  { value: 'assistant', label: 'The assistant settings' },
  { value: 'icp_profile', label: 'An ICP profile' },
])

/**
 * The raw detail, for the `<details>` beside the sentence. Through `redact()`
 * — a backstop: the writers already keep credentials out, and this catches
 * the one that forgets.
 */
export function detailForDisplay(detail: unknown): string {
  const shown =
    detail !== null && typeof detail === 'object' && !Array.isArray(detail)
      ? redact(detail as Record<string, unknown>)
      : redact({ detail })
  return JSON.stringify(shown, null, 2)
}

