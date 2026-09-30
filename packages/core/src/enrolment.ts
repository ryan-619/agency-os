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
 *    of the channel, and no zone to evaluate quiet hours in. Each is a message
 *    the sender would refuse on sight, so drafting it only hands a person
 *    something they cannot approve.
 *  - an earlier row for the same (contact, campaign). A live one is
 *    `already_enrolled`; one that went is `already_contacted` — the same cold
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
}

/**
 * Can this person be drafted to on this channel? The same four questions the
 * approvals page asks of a candidate, in the same order, so a draft enrolment
 * writes is one that page will offer to approve.
 *
 * An address that cannot be normalised counts as none: the send path refuses
 * it as `unparseable_recipient`, because no suppression row could ever have
 * matched it. A consent row only matters when it says NO — absence is not a
 * refusal on a cold channel, and there is no LinkedIn consent row at all.
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
  // The contact's zone, or their company's — the sender's own fallback. Never
  // the sender's zone, and never a country (§2.1; 0010).
  if (!(contact.timeZone ?? companyZone)) return { ok: false, why: 'no_timezone' }
  return { ok: true }
}

/**
 * Statuses of an earlier outbound row for the same (contact, campaign) that
 * do NOT stop a new draft.
 *
 * `refused` never does: nothing left, and the send path will refuse again if
 * the reason still holds. `failed` does not when a person approves each
 * message — they read the new draft before anything leaves. It DOES under
 * auto-send: a `failed` row is also what `recoverStuckSends` leaves when the
 * worker died mid-send, which may mean the provider accepted it. Queuing it
 * again with nobody in the loop is the guess that recovery refuses to make.
 */
export function enrolIgnoredStatuses(autoSend: boolean): readonly string[] {
  return autoSend ? ['refused'] : ['refused', 'failed']
}

/** Outbound statuses that mean a message is still on its way, not gone. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'awaiting_approval', 'approved', 'sending'])

/**
 * What the earlier rows for a (contact, campaign) pair say, or null when they
 * say nothing. Anything neither ignored nor live is treated as having gone —
 * `sent`, `delivered`, `replied`, `bounced`, and a status added later — since
 * the safe reading of "we do not know" is "they may have it already".
 */
export function enrolPriorSkip(
  statuses: readonly string[],
  autoSend: boolean,
): 'already_enrolled' | 'already_contacted' | null {
  const ignored = enrolIgnoredStatuses(autoSend)
  const counted = statuses.filter((s) => !ignored.includes(s))
  if (counted.length === 0) return null
  return counted.every((s) => LIVE_STATUSES.has(s)) ? 'already_enrolled' : 'already_contacted'
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
 * Build what `draftOpener` reads from the stored rows, without re-running the
 * scanner (the research's Option B).
 *
 * Evidence is the OBSERVED gaps only — a signal the scanner could not see
 * contributes nothing, not a hedge — ordered as `scoreCompany` orders them:
 * weight descending, ties in `orderedSignals(icp)` order, at most six. The
 * claim is the ICP's `why`; the observation is the finding's own detail.
 * Informational rows (`scored === false`) and signals the ICP does not name
 * are left out: neither was scored, so neither is a gap anyone can claim.
 *
 * `angle` is empty on purpose. It is internal sales guidance and must never
 * reach a prospect; `draftOpener` does not read it, and this does not give it
 * anything to not read. The headline is the first claim — the outdated-library
 * headline needs the scanner's profile, which the rows do not keep, so the
 * subject line falls back to the heaviest observed gap.
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

  const evidence: EvidenceLine[] = sortedGaps.slice(0, 6).map((g) => ({
    claim: g.why,
    observed: g.detail || 'header absent on homepage response',
  }))

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
