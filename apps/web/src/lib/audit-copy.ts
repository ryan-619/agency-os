import { SENSITIVE_KEY, SENSITIVE_VALUE, redact, type SuppressionSource } from '@agency/core'
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

function num(d: unknown, key: string): number | null {
  const v = detailValue(d, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function flag(d: unknown, key: string): boolean | null {
  const v = detailValue(d, key)
  return typeof v === 'boolean' ? v : null
}

function words(d: unknown, key: string): string[] | null {
  const v = detailValue(d, key)
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9_.:-]{0,80}$/i.test(x))
  return out.length ? out : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const noun = channel ? CHANNEL_NOUN[channel] : undefined
  if (!noun) return 'a message'
  return /^[aeiou]/i.test(noun) || noun === 'SMS' ? `an ${noun}` : `a ${noun}`
}
const channelName = (channel: string | null): string =>
  channel ? CHANNEL_NAME[channel] ?? spaced(channel) : 'a channel'

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
  return (SUPPRESSION_SOURCE_WORDS as Readonly<Record<string, SourceWords>>)[source] ?? { tag: source, explain: source }
}

const REPLY_KIND: Readonly<Record<string, string>> = {
  interested: 'an interested reply',
  not_now: 'a “not now” reply',
  wrong_person: 'a wrong-person reply',
  auto_reply: 'an auto-reply',
  opted_out: 'a reply asking to stop',
  other: 'a reply',
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

const SENTENCES: Readonly<Record<string, Template>> = {
  // --- the pipeline -------------------------------------------------------
  'deal.created': (c) => {
    const stage = word(c.d, 'stage')
    return `opened a deal for ${c.co}${stage ? ` at ${stage}` : ''}`
  },
  'deal.advanced': (c) => {
    const stage = word(c.d, 'stage')
    return stage ? `moved ${c.co} forward to ${stage}` : `moved the deal for ${c.co} forward`
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
  'deal.next_action_set': (c) => `set when the next action on the deal for ${c.co} is due`,
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
    return `recorded the meeting with ${c.co} as ${outcome ? spaced(outcome) : 'done'}`
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
  'draft.approved': (c) => `approved a draft ${CHANNEL_NOUN[word(c.d, 'channel') ?? ''] ?? 'message'} to a contact at ${c.co}`,
  'draft.denied': (c) => {
    const note = text(c.d, 'note', 80)
    return `denied a draft about ${c.co}${note ? `: ${quoted(note)}` : ''}`
  },
  'contact.replied': (c) => {
    const kind = word(c.d, 'replyKind')
    const channel = word(c.d, 'channel')
    const cancelled = num(c.d, 'cancelledQueued')
    return `recorded ${(kind && REPLY_KIND[kind]) || 'a reply'}${channel ? ` by ${channelName(channel)}` : ''} from a contact at ${c.co}${tail([
      flag(c.d, 'suppressed') && 'the address went on the suppression list',
      flag(c.d, 'paused') && 'paused them in every campaign',
      cancelled !== null && cancelled > 0 && `cancelled ${cancelled} queued`,
      dealMove(text(c.d, 'deal', 40)),
    ])}`
  },
  'contact.opt_out_not_recorded': (c) =>
    `could not record an opt-out from a contact at ${c.co} — it is NOT on the suppression list; follow up by hand`,
  'contact.created': (c) => `added a contact at ${c.co}`,
  'contact.paused': (c) => {
    const reason = text(c.d, 'reason', 80)
    return `paused a contact at ${c.co}${reason ? `: ${quoted(reason)}` : ''}${flag(c.d, 'alreadyPaused') ? ' (already paused)' : ''}`
  },
  'contact.resumed': (c) => `resumed a contact at ${c.co}`,
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
  'contact.erasure_failed': () => 'could not erase a contact: an opt-out could not be recorded first; follow up by hand',
  'contact.unsubscribed': (c) => `recorded a one-click unsubscribe from a contact at ${c.co}`,
  'contact.bounced': (c) => {
    const code = word(c.d, 'code')
    return `recorded a hard bounce${code ? ` (${code})` : ''} for a contact at ${c.co}`
  },
  'contact.bounce_transient': (c) => `recorded a temporary bounce for a contact at ${c.co}`,
  'contact.bounce_cleared': (c) => `cleared the bounce on a contact at ${c.co}`,
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
  'campaign.enrolled': () => 'enrolled contacts into a campaign; enrolling queues messages, it sends nothing itself',
  'campaign.auto_paused': (c) => {
    const pct = num(c.d, 'bouncePct')
    const limit = num(c.d, 'threshold')
    return `paused a campaign automatically${pct !== null ? `: ${pct}% of recent messages bounced` : ''}${limit !== null ? ` (the limit is ${limit}%)` : ''}`
  },
  'suppression.added': (c) => `added ${SUPPRESSION_KIND[word(c.d, 'kind') ?? ''] ?? 'a value'} to the suppression list`,
  'suppression.already_present': (c) =>
    `tried to add ${SUPPRESSION_KIND[word(c.d, 'kind') ?? ''] ?? 'a value'} that was already on the suppression list; nothing changed`,
  'suppression.removed': (c) => {
    // Only a removal recorded after 0018 carries `hadSource`; its null means
    // the ROW predated sources, which the tag says in the same word as the list.
    const source = has(c.d, 'hadSource') ? ` (source: ${suppressionSource(word(c.d, 'hadSource')).tag})` : ''
    return `removed ${SUPPRESSION_KIND[word(c.d, 'kind') ?? ''] ?? 'a value'} from the suppression list${source}; it may be contacted again`
  },
  'unsubscribe.not_recorded': () =>
    'could not record a one-click unsubscribe — the address is NOT on the suppression list; follow up by hand',
  'reply.handled': (c) => `marked a reply from a contact at ${c.co} handled`,
  'reply.reclassified': (c) => {
    const from = word(c.d, 'from')
    const to = word(c.d, 'to') ?? word(c.d, 'kind')
    return `reclassified a reply from a contact at ${c.co}${from && to ? ` from ${spaced(from)} to ${spaced(to)}` : to ? ` as ${spaced(to)}` : ''}`
  },
  'reply.answer_drafted': (c) =>
    `drafted an answer to a reply from a contact at ${c.co}; it waits for approval and nothing was sent`,

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
  'agent.queue_touch': (c) =>
    `queued ${aMessage(word(c.d, 'channel'))} about ${domainLabel(c.d) ?? 'a company'}; nothing was sent by queueing it`,
  'agent.check_send': (c) => `checked whether a message about ${domainLabel(c.d) ?? 'a company'} may be sent; nothing was sent`,
  'agent.get_consent': (c) => `read the consent recorded for a contact at ${domainLabel(c.d) ?? 'a company'}`,
  'agent.tool_pre': (c) => `was about to call ${tool(c.d)}${riskNote(c.d)}`,
  'agent.tool_post': (c) => `finished ${tool(c.d)}`,
  'agent.tool_allow': (c) => `ran ${tool(c.d)} without asking — it is low risk`,
  'agent.tool_refused': (c) => {
    const rule = word(c.d, 'rule')
    return `was refused ${tool(c.d)}${riskNote(c.d)}${rule ? ` by the rule ${rule}` : ''}`
  },
  'agent.tool_disabled': (c) => `was refused ${tool(c.d)}: an owner turned that tool off`,
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
  'connector.tools_disabled': (c) => {
    const tools = words(c.d, 'tools')
    return `changed which tools of ${theNamed(c.d, 'connector')} the agent may use${tools ? ` (${plural(tools.length, 'tool')} off)` : ''}`
  },
  'credential.rotated': () => 'replaced a stored credential',
  'user.granted': (c) => {
    const role = word(c.d, 'role')
    return `gave ${who(c)} access${role ? ` as ${role}` : ''}`
  },
  'user.revoked': (c) => `revoked the access of ${who(c)}`,
  'user.restored': (c) => `restored the access of ${who(c)}`,
  'user.role_changed': (c) => {
    const to = word(c.d, 'to') ?? word(c.d, 'role')
    return `changed the role of ${who(c)}${to ? ` to ${to}` : ''}`
  },
  'company.updated': (c) => {
    const fields = words(c.d, 'fields')
    return `edited ${c.co}${fields ? ` (${fields.map(spaced).join(', ')})` : ''}`
  },
  'note.added': (c) => `added a note on ${c.co}`,
  'note.deleted': (c) => `deleted a note on ${c.co}`,
  'task.created': (c) => `created a task for ${c.co}`,
  'task.completed': () => 'completed a task',
  'task.reopened': () => 'reopened a task',
  'task.assigned': () => 'assigned a task',
  'task.template_applied': (c) => `added a checklist of tasks for ${c.co}`,

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
    return flag(c.d, 'posted')
      ? 'posted the daily digest to Slack'
      : `built the daily digest and did not post it${why ? ` (${spaced(why)})` : ''}`
  },
}

/** Every action this page has a sentence for. The test iterates it. */
export const AUDIT_ACTIONS: readonly string[] = Object.freeze(Object.keys(SENTENCES).sort())

/**
 * Rows a person must not scroll past: an opt-out that was not stored, and a
 * call with no AI disclosure. §2.1's failures, highlighted rather than
 * rendered like every other line.
 */
export function isAlarm(row: AuditLine): boolean {
  switch (row.action) {
    case 'contact.opt_out_not_recorded':
    case 'unsubscribe.not_recorded':
    case 'contact.erasure_failed':
      return true
    case 'call.opted_out':
      return flag(row.detail, 'suppressed') === false
    case 'call.ended':
      return flag(row.detail, 'disclosed') === false
    default:
      return false
  }
}

/** The predicate for one row: "moved rentman.io from replied to meeting". Unknown → the raw name. */
export function sentenceFor(row: AuditLine, lookups: AuditLookups = {}): string {
  const template = SENTENCES[row.action]
  if (!template) return row.action
  const person = (id: unknown): string | null =>
    typeof id === 'string' && UUID.test(id) ? (lookups.person?.(id) ?? null) : null
  try {
    return template({
      row,
      d: row.detail,
      co: lookups.company ? companyLabel(lookups.company) : 'an unknown company',
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
  const literal = ACTOR_LITERALS[actor]
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
  scan: 'Scheduled rescans', cron: 'Scheduled jobs',
}
export const AUDIT_FAMILIES: readonly { readonly value: string; readonly label: string }[] = Object.freeze(
  [...new Set(AUDIT_ACTIONS.map((a) => a.split('.')[0] ?? a))].map((value) => ({
    value,
    label: FAMILY_LABEL[value] ?? value,
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

