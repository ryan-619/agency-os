/**
 * Who gets a draft when a campaign is enrolled, and what it says (§8.4).
 *
 * Enrolment is the first production caller of `draftOpener`: for every
 * qualifying, freshly scanned, reachable company it writes ONE draft per
 * contact who can be written to on the campaign's channel, and parks it where
 * the single send path will find it. It decides nothing the send path decides
 * — the draft still passes every §2.1 rule at the moment it is sent — and it
 * never reads the suppression list. §2.1 puts that check "in the send path,
 * not the campaign builder", and a builder that also checked it would be a
 * second opinion that could be right while the sender was wrong.
 *
 * What it does decide, and why each is a SKIP rather than a draft:
 *
 *  - the company half, in `draftOpener`'s own order: an unreachable scan, a
 *    stale one (or none — `isStale(null)` is true, and the fix is the same:
 *    scan it), a disqualified company, one whose score does not qualify, and
 *    one with nothing observed to quote. A draft written anyway would state
 *    something nobody checked, which is §2.2's one rule.
 *  - the person half, mirroring the approvals page's candidate rule: no
 *    usable address on the channel, paused (they replied), a recorded refusal
 *    of the channel, an email address that bounced, and no zone to evaluate
 *    quiet hours in. Each is a message the sender would refuse on sight, so
 *    drafting it only hands a person something they cannot approve.
 *  - an earlier row for the same person: in this campaign, and — under
 *    auto-send, where nobody reads the words — in any campaign on the same
 *    channel. A draft still waiting is `already_enrolled`; one that went, or
 *    one that somebody said no to, is `already_contacted` — the same cold
 *    opener twice is the failure, and under auto-send nobody would see it.
 *
 * Pure. `packages/db` gathers the rows and calls these; nothing here reads a
 * clock, a table or the environment.
 */
import type { IcpDefinition } from './icp.js'
import { orderedSignals } from './icp.js'
import type { EvidenceLine, ScoredGap, ScoredStrength, ScoreResult } from './scoring.js'
import type { ProposalFinding } from './proposal.js'
import { draftOpener, type Draft } from './draft.js'
import { normaliseEmail, normaliseLinkedIn } from './normalise.js'

/** Every reason a company or a person is left out, in the order they are checked. */
export const ENROL_SKIPS = [
  'unreachable',
  'stale',
  'disqualified',
  'not_qualified',
  'no_evidence',
  'no_contact',
  'no_address',
  'paused',
  'declined',
  'bounced',
  'no_timezone',
  'already_enrolled',
  'already_contacted',
] as const
export type EnrolSkip = (typeof ENROL_SKIPS)[number]

/**
 * How many were skipped for each reason — the only shape a skip list takes
 * in an audit row or on a screen. Counts, never ids or addresses (§2.3).
 */
export function enrolSkipCounts(
  skipped: readonly { readonly why: EnrolSkip }[],
): Partial<Record<EnrolSkip, number>> {
  const counts: Partial<Record<EnrolSkip, number>> = {}
  for (const s of skipped) counts[s.why] = (counts[s.why] ?? 0) + 1
  return counts
}

/** The two cold channels (§2.1). A campaign on any other is refused before this. */
export type EnrolChannel = 'email' | 'linkedin'

/**
 * How many drafts one enrolment may write. A cap on what lands in a person's
 * approval queue in one click, not a sending rate — the campaign's daily cap
 * is that, and it is applied by the sender.
 */
export const ENROL_LIMIT_DEFAULT = 50
export const ENROL_LIMIT_MAX = 200

// ---------------------------------------------------------------------------
// The person half
// ---------------------------------------------------------------------------

export interface EnrolContactFacts {
  readonly email: string | null
  readonly linkedinUrl: string | null
  readonly timeZone: string | null
  readonly pausedAt: Date | string | null
  readonly consents: readonly { readonly channel: string; readonly granted: boolean }[]
  /**
   * `contacts.email_bounced_at`: the last message to the email address came
   * back permanently. Read on the email channel only — a bounce is evidence
   * about an address, not about the person (§1), so it says nothing about
   * their LinkedIn profile.
   */
  readonly emailBouncedAt: Date | string | null
}

/**
 * Can this person be drafted to on this channel? The questions the approvals
 * page asks of a candidate, in the send path's order, so a draft enrolment
 * writes is one that page will offer to approve.
 *
 * An address that cannot be normalised counts as none: the send path refuses
 * it as `unparseable_recipient`, because no suppression row could ever have
 * matched it. A consent row only matters when it says NO — absence is not a
 * refusal on a cold channel, and there is no LinkedIn consent row at all. An
 * address that bounced is one the sender refuses on sight as `bounced`; the
 * fix is a corrected address on /contacts, which clears the mark in the same
 * UPDATE, and the next enrolment then drafts to it.
 */
export function enrollableContact(
  contact: EnrolContactFacts,
  companyZone: string | null,
  channel: EnrolChannel,
): { readonly ok: true } | { readonly ok: false; readonly why: EnrolSkip } {
  const raw = channel === 'email' ? contact.email : contact.linkedinUrl
  const usable = raw && raw.trim() ? (channel === 'email' ? normaliseEmail(raw) : normaliseLinkedIn(raw)) : null
  if (!usable) return { ok: false, why: 'no_address' }
  if (contact.pausedAt !== null && contact.pausedAt !== undefined) return { ok: false, why: 'paused' }
  if (contact.consents.some((c) => c.channel === channel && c.granted === false)) {
    return { ok: false, why: 'declined' }
  }
  // After the consent questions and before the zone, as the send path orders
  // them: somebody who declined is reported as having declined, the reason
  // nobody may approve past, even when their address also bounced.
  if (channel === 'email' && contact.emailBouncedAt !== null && contact.emailBouncedAt !== undefined) {
    return { ok: false, why: 'bounced' }
  }
  // The contact's zone, or their company's — the sender's own fallback. Never
  // the sender's zone, and never a country (§2.1; 0010).
  if (!(contact.timeZone ?? companyZone)) return { ok: false, why: 'no_timezone' }
  return { ok: true }
}

/**
 * An earlier outbound row for the same person, as enrolment reads it.
 * `refusalCode` is `touches.refusal_code`, set exactly when the status is
 * `refused` (0010's `touches_refusal_is_explained`).
 */
export interface EnrolPriorRow {
  readonly status: string
  readonly refusalCode: string | null
}

/**
 * Refusals a corrected contact record or a re-scan resolves. Nobody said no:
 * the address bounced or could not be read, there was no zone to check quiet
 * hours in, or the evidence the words quoted had aged out. The next draft is
 * written from a fresh scan to the record as it is now, and the send path
 * checks it again — so an earlier row refused for one of these does not stop
 * it. (A bounce or a missing zone that still holds is skipped by
 * `enrollableContact` before any row is read.)
 *
 * `stale_evidence` is the send path's refusal of words quoting a scan that
 * has aged out; it is listed by name here as the string the row stores.
 */
export const REFUSALS_A_CORRECTION_RESOLVES: ReadonlySet<string> = new Set([
  'bounced',
  'unparseable_recipient',
  'unknown_timezone',
  'stale_evidence',
])

/**
 * The clock's and the campaign's refusals. The sender DEFERS these — it puts
 * the row back where it was with `scheduled_for` set — so a row still
 * `refused` with one is a deferral that was never restored, a worker that
 * died between the two writes. Nobody said no, and nothing went: a refused
 * row was never sent (0010's `touches_refused_was_not_sent`).
 */
export const REFUSALS_THE_CLOCK_RESOLVES: ReadonlySet<string> = new Set(['quiet_hours', 'daily_cap', 'campaign_inactive'])

/**
 * The refusal codes on an earlier `refused` row that do NOT stop a new draft:
 * the two sets above, as a list the database's NOT EXISTS can name.
 *
 * Every other refusal does, whatever the campaign's mode — each is somebody
 * saying no, and enrolling again must not quietly ask again:
 *
 *  - `needs_approval`: a person denied that draft (`denyDraft`). Under
 *    auto-send nobody would see the same words go.
 *  - `consent_revoked`: the recipient declined the channel, or their reply,
 *    their unsubscribe or their erasure cancelled what was queued.
 *  - `suppressed`: they asked to be left alone.
 *  - `cold_channel_forbidden` and `no_consent`, which only a channel
 *    enrolment never writes on can produce — read as a no if one appears.
 *  - and a code this list does not know, read the safe way — as a no.
 */
export const ENROL_IGNORED_REFUSALS: readonly string[] = Object.freeze([
  ...REFUSALS_A_CORRECTION_RESOLVES,
  ...REFUSALS_THE_CLOCK_RESOLVES,
])

/**
 * Statuses of an earlier outbound row that do NOT stop a new draft, whatever
 * their refusal code — `refused` is decided by code, above.
 *
 * `failed` does not when a person approves each message — they read the new
 * draft before anything leaves. It DOES under auto-send: a `failed` row is
 * also what `recoverStuckSends` leaves when the worker died mid-send, which
 * may mean the provider accepted it. Queuing it again with nobody in the loop
 * is the guess that recovery refuses to make.
 */
export function enrolIgnoredStatuses(autoSend: boolean): readonly string[] {
  return autoSend ? [] : ['failed']
}

/**
 * Which earlier rows are read. A person approving each draft reads the words,
 * so a supervised campaign asks only about its own rows. Under auto-send
 * nobody does, and the words depend only on the company, the ICP, the agency
 * and the sender — so campaign B would mail exactly what campaign A already
 * sent. Auto-send also reads every campaign's rows on the same channel.
 */
export function enrolPriorScope(autoSend: boolean): 'campaign' | 'channel' {
  return autoSend ? 'channel' : 'campaign'
}

/** Whether one earlier row says nothing about a new draft. */
export function enrolIgnoresRow(row: EnrolPriorRow, autoSend: boolean): boolean {
  if (row.status === 'refused') return row.refusalCode !== null && ENROL_IGNORED_REFUSALS.includes(row.refusalCode)
  return enrolIgnoredStatuses(autoSend).includes(row.status)
}

/**
 * Outbound statuses that mean a draft is still waiting, not gone. `sending`
 * is not one: it is the worker's claim on a row it is handing to the
 * provider, and a row left there may already have been delivered.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'awaiting_approval', 'approved'])

/**
 * What the earlier rows for a person say, or null when they say nothing.
 * Anything neither ignored nor waiting is treated as having gone — `sent`,
 * `sending`, `delivered`, `replied`, `bounced`, a refusal somebody made, and
 * a status added later — since the safe reading of "we do not know" is "they
 * may have it already".
 */
export function enrolPriorSkip(
  rows: readonly EnrolPriorRow[],
  autoSend: boolean,
): 'already_enrolled' | 'already_contacted' | null {
  const counted = rows.filter((r) => !enrolIgnoresRow(r, autoSend))
  if (counted.length === 0) return null
  return counted.every((r) => LIVE_STATUSES.has(r.status)) ? 'already_enrolled' : 'already_contacted'
}

// ---------------------------------------------------------------------------
// The company half
// ---------------------------------------------------------------------------

/** A findings row as enrolment reads it: the proposal's shape, plus 0018's `scored`. */
export interface EnrolFinding extends ProposalFinding {
  /** False for an informational signal (0018): observed, recorded, never quoted. */
  readonly scored?: boolean
}

/** The score row computed FROM the scan in hand (0006), or null when there is none. */
export interface EnrolScore {
  readonly score: number
  readonly tier: string | null
  readonly qualified: boolean
  readonly disqualifiedReason: string | null
}

export interface EnrolScanFacts {
  readonly ranAt: Date
  readonly ok: boolean
  readonly error?: string | null
  /** The caller's `isStale(scan.ranAt, …)` — never the `findings.stale` column. */
  readonly stale: boolean
}

/**
 * The company half, from the scan and its score alone — before any finding
 * is read. `draftOpener`'s order, with qualification between disqualified and
 * evidence: a company can be observed, fresh and not disqualified and still
 * score below the ICP's line, and enrolment only writes to companies that
 * qualify. No scan at all is `stale`, as `isStale(null)` says.
 */
export function enrolCompanyGate(
  scan: { readonly ok: boolean; readonly stale: boolean } | null,
  score: EnrolScore | null,
): EnrolSkip | null {
  if (!scan) return 'stale'
  if (!scan.ok) return 'unreachable'
  if (scan.stale) return 'stale'
  if (score?.disqualifiedReason) return 'disqualified'
  if (!score?.qualified) return 'not_qualified'
  return null
}

/**
 * The header signals. Each is one response header on the homepage, and
 * `extractProfile` stores a gap on one with no detail only when that header
 * was not sent — so for these, and only these, "header absent" is what the
 * scanner saw.
 */
const HEADER_SIGNALS: ReadonlySet<string> = new Set([
  'csp',
  'hsts',
  'frame_protection',
  'content_type_options',
  'referrer_policy',
  'permissions_policy',
])

/**
 * What a gap stored with no detail observed, in the words of what the
 * scanner actually did — or null, when nothing on the row says what that was.
 *
 * `recordScan` stores an empty detail as NULL, and the scanner leaves it
 * empty on three gaps that are not headers at all: a security.txt it did not
 * find, a security or trust page it did not find, and a homepage naming no
 * qualifying certification. One fallback used to call all of them "header
 * absent on homepage response" — an observation nobody made, in a body
 * auto-send mails unread (§2.2).
 *
 * The two path signals name the paths FROM THE ROW — `evidence.probed`, which
 * the scanner writes beside every such finding — never from a list kept here,
 * which could drift from the paths the scanner requests. A row without that
 * list says nothing about where anybody looked, so neither does this.
 * `compliance_claim` is read off the homepage alone, and a gap there means
 * none of the qualifying terms appeared in it — SOC 2 and ISO 27001 among
 * them.
 */
export function observedWithoutDetail(signalKey: string, evidence: Readonly<Record<string, unknown>>): string | null {
  if (HEADER_SIGNALS.has(signalKey)) return 'header absent on homepage response'
  if (signalKey === 'security_txt') {
    const paths = probedPaths(evidence)
    return paths ? `no security.txt found at ${orList(paths)}` : null
  }
  if (signalKey === 'trust_page') {
    const paths = probedPaths(evidence)
    return paths ? `no security or trust page found at ${orList(paths)}` : null
  }
  if (signalKey === 'compliance_claim') return 'no SOC 2 or ISO 27001 claim found on the homepage'
  return null
}

/**
 * The paths a finding's evidence says were requested, when it says so in a
 * shape that is safe to put in front of a stranger: short absolute paths and
 * nothing else. Anything odder is treated as not said.
 */
function probedPaths(evidence: Readonly<Record<string, unknown>>): readonly string[] | null {
  const probed = evidence.probed
  if (!Array.isArray(probed) || probed.length === 0) return null
  const paths = probed.filter((p): p is string => typeof p === 'string' && /^\/[A-Za-z0-9._/-]{1,63}$/.test(p))
  return paths.length === probed.length ? paths : null
}

/** `a`, `a or b`, `a, b or c`. */
function orList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]!}`
}

/**
 * Build what `draftOpener` reads from the stored rows, without re-running the
 * scanner (the research's Option B).
 *
 * Evidence is the OBSERVED gaps only — a signal the scanner could not see
 * contributes nothing, not a hedge — ordered as `scoreCompany` orders them:
 * weight descending, ties in `orderedSignals(icp)` order, at most six. The
 * claim is the ICP's `why`; the observation is the finding's own detail, or,
 * where the scanner stored none, `observedWithoutDetail`'s words for what it
 * did. A gap with neither is not quoted: `draftOpener` writes each claim WITH
 * what was observed, and a claim with nothing observed beside it is an
 * assertion the reader cannot check. It stays in `gaps`.
 * Informational rows (`scored === false`) and signals the ICP does not name
 * are left out: neither was scored, so neither is a gap anyone can claim.
 *
 * `angle` is empty on purpose. It is internal sales guidance and must never
 * reach a prospect; `draftOpener` does not read it, and this does not give it
 * anything to not read. The headline is the first claim — the outdated-library
 * headline needs the scanner's profile, which the rows do not keep, so the
 * subject line falls back to the heaviest gap it quotes.
 */
export function draftInputFromFindings(input: {
  readonly company: { readonly domain: string; readonly name: string | null }
  readonly icp: IcpDefinition
  readonly findings: readonly EnrolFinding[]
  readonly scan: EnrolScanFacts
  readonly score: EnrolScore | null
}): ScoreResult {
  const { icp } = input
  const bySignal = new Map(input.findings.map((f) => [f.signalKey, f]))

  const gaps: ScoredGap[] = []
  const strengths: ScoredStrength[] = []
  for (const [key, signal] of orderedSignals(icp)) {
    const f = bySignal.get(key)
    if (!f || !f.observed || f.scored === false) continue
    if (f.gap === true) gaps.push({ key, weight: signal.weight, why: signal.why, detail: f.detail ?? '' })
    else strengths.push({ key, detail: f.detail ?? '' })
  }
  // Stable, so equal weights keep the ICP's order — `scoreCompany`'s tie-break.
  const sortedGaps = [...gaps].sort((a, b) => b.weight - a.weight)

  const evidence: EvidenceLine[] = []
  for (const g of sortedGaps) {
    if (evidence.length === 6) break
    const observed = g.detail || observedWithoutDetail(g.key, bySignal.get(g.key)?.evidence ?? {})
    if (observed) evidence.push({ claim: g.why, observed })
  }

  return {
    domain: input.company.domain,
    company: input.company.name || input.company.domain,
    title: '',
    score: input.score?.score ?? 0,
    tier: input.score?.tier ?? '',
    qualified: input.score?.qualified ?? false,
    disqualified: input.score?.disqualifiedReason ?? '',
    gaps: sortedGaps,
    strengths,
    headlineFinding: evidence[0]?.claim ?? '',
    angle: '',
    evidence,
    reachable: input.scan.ok,
    fetchError: input.scan.error ?? '',
  }
}

/**
 * The whole company-side decision: the gate, then `draftOpener` over the
 * rows. One draft per company — the same words go to each of its contacts,
 * because the words are about the company's site, not about the person.
 */
export function enrolmentDraft(input: {
  readonly company: { readonly domain: string; readonly name: string | null }
  readonly icp: IcpDefinition
  readonly findings: readonly EnrolFinding[]
  readonly scan: EnrolScanFacts | null
  readonly score: EnrolScore | null
  /** From the org row. Never invented. */
  readonly agencyName: string
  readonly senderName?: string | null
}): { readonly ok: true; readonly draft: Draft } | { readonly ok: false; readonly why: EnrolSkip } {
  const gate = enrolCompanyGate(input.scan, input.score)
  if (gate) return { ok: false, why: gate }
  // The gate returned null, so there is a scan; the narrowing is for the compiler.
  const scan = input.scan!
  const opener = draftOpener({
    score: draftInputFromFindings({ ...input, scan }),
    agencyName: input.agencyName,
    senderName: input.senderName ?? null,
    stale: scan.stale,
  })
  // Every `DraftRefusal` is also an `EnrolSkip`, by name.
  if (!opener.ok) return { ok: false, why: opener.why }
  return { ok: true, draft: opener.draft }
}
