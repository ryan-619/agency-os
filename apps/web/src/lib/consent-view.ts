/**
 * How §2.1's record about a person is worded in front of a person.
 *
 * The /contacts ledger shows three facts per channel — granted, refused,
 * never asked — and a suppression answer per key. The words matter more than
 * usual, because the product's failure here is not a crash but a sentence
 * that reads as permission: a never-asked SMS channel shown as blank looks
 * like "fine", and an unreadable LinkedIn URL shown as "clear" looks like
 * somebody checked. So the wording lives here, once, pure and tested
 * (`test/consent-view.test.ts`), and the page only renders it.
 *
 * Pure: no `server-only`, no `@/` import, no environment. A test imports it
 * directly, and vitest has neither.
 */
import { refusalWords } from './refusal-words'

export type ConsentStateName = 'granted' | 'refused' | 'never_asked'
/** `send-preview.ts`'s `SuppressionStanding`, restated so this file imports nothing from the server. */
export type SuppressionStandingName = 'clear' | 'suppressed' | 'unparseable' | 'none'

export interface ConsentStateView {
  readonly state: ConsentStateName
  readonly source: string | null
  readonly recordedAt: Date | string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "12 Sep 2026", in UTC. Not `Intl`: its short month for September is
 * "Sep" or "Sept" depending on the ICU build, and a server and a browser
 * that disagree are a hydration error.
 */
export function shortDate(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(d.getTime())) return 'an unknown date'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** The source as recorded, less a trailing date that repeats `recordedAt`, bounded. */
function sourceText(source: string | null, recordedAt: Date | string | null): string {
  let s = source?.trim() || 'no source recorded'
  if (recordedAt) {
    const d = typeof recordedAt === 'string' ? new Date(recordedAt) : recordedAt
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString().slice(0, 10)
      if (s.endsWith(iso)) s = s.slice(0, -iso.length).replace(/[,\s]+$/, '') || s
    }
  }
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}

/**
 * One channel's consent, in words.
 *
 * Never-asked is worded BY CHANNEL, because it means two different things:
 * on email it is a cold channel §2.1 permits, and on SMS, voice and WhatsApp
 * it is a refusal — absence is no. A label that said "never asked" for both
 * would leave the reader to know which.
 */
export function consentStateLabel(s: ConsentStateView, channel: string): string {
  if (s.state === 'granted') {
    const when = s.recordedAt ? `, ${shortDate(s.recordedAt)}` : ''
    return `granted (${sourceText(s.source, s.recordedAt)}${when})`
  }
  if (s.state === 'refused') return 'refused — will not be asked again'
  return channel === 'email' ? 'never asked — cold email allowed' : 'never asked — cannot be used'
}

/** The `.ledger-state` modifier: green for a yes, amber for anything that stops a send. */
export function consentStateClass(s: Pick<ConsentStateView, 'state'>, channel: string): 'yes' | 'no' | 'none' | 'unknown' {
  if (s.state === 'granted') return 'yes'
  if (s.state === 'refused') return 'no'
  return channel === 'email' ? 'unknown' : 'none'
}

/**
 * One suppression key's answer, in words. `unparseable` says what the send
 * path does with it — treats it as suppressed — because "could not be
 * parsed" on its own reads like a formatting note rather than a refusal.
 */
export function suppressionLabel(state: SuppressionStandingName): string {
  switch (state) {
    case 'suppressed':
      return 'on the suppression list'
    case 'clear':
      return 'clear'
    case 'unparseable':
      return 'could not be parsed — treated as suppressed'
    case 'none':
      return 'nothing on file'
  }
}

export function suppressionClass(state: SuppressionStandingName): 'yes' | 'no' | 'unknown' {
  if (state === 'clear') return 'yes'
  if (state === 'none') return 'unknown'
  return 'no'
}

/**
 * Where quiet hours are evaluated for this person — the rule `sendFactsFor`
 * applies: their own zone, else their company's, else nobody's (a refusal).
 * The fallback is NAMED, because a company's zone is a guess about a person
 * and whoever reads the page should know it is one.
 */
export function zoneLabel(contactZone: string | null, companyZone: string | null): string {
  if (contactZone) return contactZone
  if (companyZone) return `falls back to ${companyZone} from the company`
  return 'no timezone — nothing can be sent until one is set'
}

/**
 * A recipient with everything but its domain removed, for a response that
 * leaves the server: `…@rentman.io`. A number or a profile has no domain
 * part, so it becomes null — the page already shows the person's addresses
 * from its own read; the check's answer does not need to carry them again.
 */
export function maskRecipient(recipient: string | null): string | null {
  if (!recipient) return null
  const at = recipient.lastIndexOf('@')
  return at > 0 && at < recipient.length - 1 ? `…@${recipient.slice(at + 1)}` : null
}

/** A suppression key with its value masked the same way. A domain is not a person, so it stays. */
export function maskSuppressionKey(k: { kind: string; value: string }): { kind: string; value: string | null } {
  if (k.kind === 'domain') return { kind: k.kind, value: k.value }
  if (k.kind === 'email') return { kind: k.kind, value: maskRecipient(k.value) }
  return { kind: k.kind, value: null }
}

export interface SendCheckView {
  readonly decision:
    | { readonly allowed: true; readonly code: 'send_now' }
    | { readonly allowed: false; readonly code: string; readonly reason: string; readonly humanCanResolve: boolean }
  readonly wouldNeedApproval: boolean
}

/**
 * The answer to "Why can't I reach them?", in one sentence: the code in the
 * words every other screen uses (`REFUSAL_WORDS`), then the rule's own
 * reason, then whether a person can do anything about it.
 */
export function sendCheckSentence(v: SendCheckView): string {
  if (v.decision.allowed) {
    return v.wouldNeedApproval
      ? 'Nothing stops a message to them under this campaign right now. It would still wait for a person to approve it.'
      : 'Nothing stops a message to them under this campaign right now, and this campaign sends without a per-message approval.'
  }
  const reason = v.decision.reason.trim().replace(/\.+$/, '')
  return (
    `${capitalise(refusalWords(v.decision.code))} — ${reason}. ` +
    (v.decision.humanCanResolve ? 'A person can resolve this.' : 'Nobody may approve past this.')
  )
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
