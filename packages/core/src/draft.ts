/**
 * The opener a scan earns (§5.5's `draft_outreach`, §8.4).
 *
 * This is the DETERMINISTIC draft — the one the product writes with no model
 * configured, and the fallback a model improves on. It exists before the
 * model does, deliberately: §5.5's seam requires its callers to have an
 * answer already, and "the templated draft" is this.
 *
 * ## §2.2 governs this harder than anything else here
 *
 * An outreach email is the one artefact a stranger reads, and a finding
 * nobody observed inside one is a false statement about their company made
 * in writing. So:
 *
 *  - only `evidence` lines are quoted, and those are built from signals the
 *    scanner OBSERVED. A signal it could not observe contributes nothing —
 *    not a hedge, not a "we noticed you may not have", nothing.
 *  - an unreachable scan produces NO draft at all, with a reason, the same
 *    way `proposalFromFindings` refuses. A company whose site would not
 *    answer has told us nothing to write about.
 *  - stale evidence is the CALLER's check, not this function's, because
 *    freshness needs the scan's `ran_at` and this module is pure. The
 *    caller passes `stale` and gets a refusal.
 *
 * Nothing here decides to send anything. A draft is `queue_touch` parked on
 * a human (§2.4), and this only produces the words they will read.
 */
import type { ScoreResult } from './scoring.js'

export interface DraftInput {
  readonly score: ScoreResult
  /** The agency writing. Never invented — it comes from the org row. */
  readonly agencyName: string
  /** Who signs it. Null means the draft is unsigned and a human adds it. */
  readonly senderName?: string | null
  /** The caller's freshness verdict — see `isStale`, which needs the scan. */
  readonly stale?: boolean
  /** How many evidence lines to quote. More reads as a report, not a note. */
  readonly maxEvidence?: number
}

export type DraftRefusal = 'unreachable' | 'stale' | 'no_evidence' | 'disqualified'

export interface Draft {
  readonly subject: string
  readonly body: string
  /** Exactly what was quoted, so a reviewer can check it against the scan. */
  readonly quoted: readonly string[]
}

export type DraftResult =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly why: DraftRefusal; readonly reason: string }

const DEFAULT_MAX_EVIDENCE = 3

/**
 * Turn a scan into an opener, or refuse with a reason somebody can act on.
 *
 * The refusal is the useful half. "No draft, because the last scan could not
 * reach the site" tells a person to re-scan; a draft written anyway would
 * tell a stranger something nobody checked.
 */
export function draftOpener(input: DraftInput): DraftResult {
  const { score } = input

  if (!score.reachable) {
    return {
      ok: false,
      why: 'unreachable',
      reason:
        `The last scan of ${score.domain} could not reach the site` +
        `${score.fetchError ? ` (${score.fetchError})` : ''}, so there is nothing observed to write about. Re-scan first.`,
    }
  }
  if (input.stale) {
    return {
      ok: false,
      why: 'stale',
      reason: `The scan of ${score.domain} is old enough that its findings may no longer be true. Re-scan before writing to them.`,
    }
  }
  if (score.disqualified) {
    return {
      ok: false,
      why: 'disqualified',
      reason: `${score.domain} is disqualified (${score.disqualified}), so there is no opener to write.`,
    }
  }

  const quoted = score.evidence.slice(0, input.maxEvidence ?? DEFAULT_MAX_EVIDENCE)
  if (quoted.length === 0) {
    return {
      ok: false,
      why: 'no_evidence',
      reason:
        `The scan of ${score.domain} observed nothing quotable — every signal was either fine or could not be checked. ` +
        'An opener with no evidence in it is a cold pitch, which is what this product exists not to send.',
    }
  }

  const who = score.company || score.domain
  const subject = score.headlineFinding
    ? `${who}: ${firstClause(score.headlineFinding)}`
    : `A note on ${who}'s public security posture`

  const lines: string[] = []
  lines.push(`Hi,`)
  lines.push('')
  lines.push(
    `I had a look at ${who}'s public pages — only what anyone can see from the outside, no testing of any kind — and a few things stood out:`,
  )
  lines.push('')
  for (const line of quoted) {
    // The claim AND what was observed. A claim on its own is an assertion;
    // with the observation attached it is something the reader can check
    // against their own site in about a minute, which is the point.
    lines.push(`• ${line.claim} — ${line.observed}`)
  }
  lines.push('')
  /**
   * `score.angle` is NOT written here, and this comment is load-bearing.
   *
   * It reads like a sentence for the email, and it was in the body until
   * somebody read what `scoreCompany` actually puts in it:
   *
   *   "Security page exists but no SOC 2 / ISO claim — they are mid-journey.
   *    Sell the gap assessment and the DevSecOps pipeline that makes audit
   *    evidence a build artifact instead of a fire drill."
   *
   * That is internal sales guidance, written in the third person ABOUT the
   * prospect, and it went into the message the prospect reads. Two rules at
   * once: the "Sell the …" half is a note to a colleague, and the "Security
   * page exists" half is an assertion §2.2 forbids — that branch is chosen
   * when `trust_page` is not among the gaps, which is also true when the
   * scanner could not check for one. A claim about a page nobody observed.
   *
   * The suite did not catch it because `draft.test.ts` hand-wrote a
   * prospect-safe angle into its fixture while `scoring.test.ts` asserted the
   * real internal wording — each test agreed with itself. The test below now
   * drafts from real `scoreCompany` output for exactly this reason.
   *
   * The angle keeps its place in `ScoreResult`; a human deciding how to pitch
   * and the agent choosing a template both want it. It just never gets
   * copied into an outbound body.
   */
  lines.push('')
  lines.push(
    'If any of that is already handled or looks wrong, say so and I will correct our notes. ' +
      'If it is useful, I can walk through what we saw in fifteen minutes.',
  )
  lines.push('')
  lines.push(input.senderName ? input.senderName : '—')
  if (input.agencyName) lines.push(input.agencyName)

  return { ok: true, draft: { subject, body: lines.join('\n'), quoted: quoted.map((q) => q.claim) } }
}

/** The headline trimmed to something that fits a subject line. */
function firstClause(headline: string): string {
  const cut = headline.split(/[.;]/)[0] ?? headline
  return cut.length > 60 ? `${cut.slice(0, 57).trimEnd()}…` : cut
}
