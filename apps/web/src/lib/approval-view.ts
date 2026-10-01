/**
 * What /approvals shows beside a draft, as pure functions (PROMPT.md §2.1,
 * §2.2, §2.4).
 *
 * A person approves the WORDS, not the moment (CLAUDE.md, "The send path"):
 * the worker re-checks every rule when it sends. So nothing here decides
 * anything. What it does is put the facts the sender will read in front of
 * the person before they click — the same facts, from the same function
 * (`previewSend`), in the same words every other screen uses
 * (`REFUSAL_WORDS`) — and the evidence the draft is allowed to quote, with
 * its date, so the body can be checked against what was actually observed.
 *
 * The one place this changes what a person can do is the rule nobody may
 * approve past (`humanCanResolve: false`). Approve is disabled there and says
 * why, because an approval the sender must refuse is not a decision — it is
 * practice at clicking yes, which is exactly the habit §2.4 guards against.
 *
 * No `server-only` and no `@/` import: `test/approval-view.test.ts` imports
 * this file, and vitest resolves neither.
 */
import { shortDate } from './consent-view'
import { refusalWords } from './refusal-words'

// ---------------------------------------------------------------------------
// The per-candidate decision
// ---------------------------------------------------------------------------

/** One candidate's `previewSend` answer, as the card renders it. */
export interface CandidateDecision {
  /** `send_now`, a `SendRefusalCode`, or `unchecked` when the preview itself could not run. */
  readonly code: string
  /** The words every screen uses for the code (`REFUSAL_WORDS`). */
  readonly words: string
  /** `decideSend`'s own flag: false for the rules no human may override. */
  readonly humanCanResolve: boolean
  /** The rule's own sentence, from `decideSend` — null when nothing stops it. */
  readonly reason: string | null
  /**
   * A `stale_evidence` refusal because a newer successful scan SUPERSEDED
   * the one the words quote, not because it aged (r4, `decideGathered`).
   * Present only when true. The re-scan has happened, so the fix is a new
   * draft from the latest scan, and `approveBlock` says that instead of
   * "re-scan".
   */
  readonly evidenceSuperseded?: true
}

/**
 * `SendDecision`'s shape, restated so this file imports nothing from the
 * server. `SendPreview.decision` is assignable to it.
 */
export type PreviewDecision =
  | { readonly allowed: true; readonly code: 'send_now' }
  | { readonly allowed: false; readonly code: string; readonly reason: string; readonly humanCanResolve: boolean }

const SEND_NOW_WORDS = 'nothing stops it right now'

/**
 * How `decideGathered` (packages/db, outreach.ts) opens the sentence of a
 * `stale_evidence` refusal whose scan was superseded rather than aged. The
 * page hands this file `previewSend`'s decision and nothing else, and the
 * facts beside it cannot tell aged-and-superseded (worded as the deadline)
 * from superseded alone — so the sentence the card already shows is what
 * says which, and the block above it cannot contradict it.
 * `test/approval-view.test.ts` runs the real `decideGathered`, so a
 * rewording there fails that test rather than going quiet here.
 */
const SUPERSEDED_REASON = /^A newer scan of this company has reached the site since the scan these words quote\b/

/** A `previewSend` decision in the words the card shows. */
export function decisionView(d: PreviewDecision): CandidateDecision {
  if (d.allowed) return { code: 'send_now', words: SEND_NOW_WORDS, humanCanResolve: true, reason: null }
  const view = { code: d.code, words: refusalWords(d.code), humanCanResolve: d.humanCanResolve, reason: d.reason }
  return d.code === 'stale_evidence' && SUPERSEDED_REASON.test(d.reason) ? { ...view, evidenceSuperseded: true } : view
}

/**
 * The preview could not run — the contact or the campaign vanished between
 * the page's reads. Resolvable, because it says nothing about the person: the
 * worker checks again at sending, and approving is not blocked by a race.
 */
export function uncheckedDecision(message: string): CandidateDecision {
  return { code: 'unchecked', words: 'could not be checked', humanCanResolve: true, reason: message }
}

/**
 * The codes the worker DEFERS rather than refuses (`apps/agent/src/outreach/
 * sender.ts`): the person said yes and only the clock or the campaign is
 * wrong, so an approved message waits with `scheduled_for` and goes later.
 * Everything else is terminal once the worker reads it.
 */
export const DEFERRED_CODES: ReadonlySet<string> = new Set(['quiet_hours', 'daily_cap', 'campaign_inactive'])

/**
 * One candidate's line under the "To" choice, and in its option label.
 *
 * It says what the WORKER would do, not just which rule: "quiet hours" alone
 * reads like a refusal, and it is not one — the message waits for morning.
 */
export function candidateLine(decision: CandidateDecision | null): string {
  if (decision === null) return 'not checked — no campaign chosen yet'
  if (decision.code === 'send_now') return decision.words
  if (decision.code === 'unchecked') return 'could not be checked here — the worker checks again at sending'
  if (!decision.humanCanResolve) return `${decision.words} — nobody may approve past this`
  if (DEFERRED_CODES.has(decision.code)) return `${decision.words} — the worker would hold it and try again later`
  return `${decision.words} — fix this first, or the worker will refuse it`
}

/**
 * Why Approve is disabled for this candidate, or null when it is not.
 *
 * Only `humanCanResolve: false` blocks — a suppression, a recorded refusal,
 * a paused contact, a cold SMS, and words written from a scan that is past
 * its re-verification deadline now (§2.2). Everything else leaves Approve
 * enabled, because the send path re-checks at sending and a person
 * approving past quiet hours is doing exactly what the design expects.
 *
 * Stale evidence has its own sentence, because "choose someone else" is no
 * fix for it: every person at the company gets the same words, and the
 * words are what aged. Denying such a draft records it as `stale_evidence`
 * (`denyDraft`), which a re-scan resolves, so enrolment can draft them again.
 * Words whose scan a newer one SUPERSEDED (`evidenceSuperseded`) get a
 * sentence of their own: the scan may be days old, so "past its deadline"
 * would be false, and the re-scan is what already happened — the fix is a
 * new draft from the latest scan.
 *
 * A pause has its own too, because "deny the draft" is the wrong advice for
 * it: a pause is lifted by a person (the rule's own sentence says how, by
 * what paused them), after which the draft can simply be approved — and a
 * denial is a person's no, which stops them being drafted on that campaign
 * again.
 *
 * On a template channel (`channel` sms or whatsapp) there is nobody else to
 * choose: the slots were filled for one person, `smsCandidates` offers only
 * them, and `approveDraft` refuses anyone else (`rendered_for_another`). So
 * neither the paused block nor the default one says "choose someone else"
 * there. Round 4, finding [22]. Without a channel the email words stand.
 */
export function approveBlock(decision: CandidateDecision | null, channel?: string): string | null {
  if (decision === null || decision.humanCanResolve) return null
  const onlyThem = channel !== undefined && TEMPLATE_CHANNEL_NAMES.has(channel)
  if (decision.code === 'stale_evidence' && decision.evidenceSuperseded) {
    return (
      `Approving is pointless: ${decision.words} — a newer scan of the company has run since the one it was ` +
      'written from, and only the latest scan is quoted in anything outbound, so nobody may approve past that. ' +
      'Deny it, then draft it again from the latest scan.'
    )
  }
  if (decision.code === 'stale_evidence') {
    return (
      `Approving is pointless: ${decision.words} — the scan it was written from is past its re-verification ` +
      'deadline, and nobody may approve past that. Deny it, re-scan the company, then draft it again.'
    )
  }
  if (decision.code === 'paused') {
    return (
      `Approving is pointless: ${decision.words}, and nobody may approve past a pause — the worker would refuse it. ` +
      (onlyThem
        ? `The rule below says what lifts it; the draft can wait here until then. ${FILLED_FOR_ONE}`
        : 'The rule below says what lifts it; the draft can wait here until then, or choose someone else.')
    )
  }
  // 0019: the WORDS are what the operator would scrub, so another person
  // gets the same refusal. The fix is a new draft from a registered template.
  if (decision.code === 'no_template' || decision.code === 'template_mismatch') {
    return (
      `Approving is pointless: ${decision.words} — the operator would not deliver it, and nobody may approve past ` +
      'that. Deny it, then draft it again from an active registered template.'
    )
  }
  return (
    `Approving is pointless: ${decision.words}, and nobody may approve past that — the worker would refuse it. ` +
    (!onlyThem
      ? 'Deny the draft, or choose someone else.'
      : channel === 'sms'
        ? `Deny the draft. ${FILLED_FOR_ONE} A text to somebody else is drafted from their own row on /contacts (Draft SMS).`
        // Nothing in the product drafts a WhatsApp message, so nothing is pointed at.
        : `Deny the draft. ${FILLED_FOR_ONE}`)
  )
}

/**
 * The channels whose words are a registered template filled in for one
 * person — core's `TEMPLATE_CHANNELS` (`packages/core/src/send.ts`),
 * restated so a client component importing this file does not pull the
 * domain package into the browser bundle. `approval-view.test.ts` holds the
 * two to one set.
 */
export const TEMPLATE_CHANNEL_NAMES: ReadonlySet<string> = new Set(['sms', 'whatsapp'])

const FILLED_FOR_ONE = 'Its template was filled in for this one person, so it cannot go to anyone else.'

// ---------------------------------------------------------------------------
// Which campaign the decisions were computed under
// ---------------------------------------------------------------------------

export interface CampaignLike {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly status: string
}

export interface CheckedUnder {
  readonly id: string
  readonly name: string
  /** True when it is the campaign the draft already carries. */
  readonly own: boolean
}

/**
 * The campaign a draft's candidates are previewed under: the draft's own
 * when it carries one, otherwise the first ACTIVE campaign on its channel,
 * otherwise the first on its channel at all. Null when the channel has none.
 *
 * One campaign, not every campaign, and that loses nothing that blocks: the
 * rules nobody may approve past (cold channel, suppression, consent) come
 * before every campaign-dependent step in `decideSend` and depend only on
 * the person and the CHANNEL — and every campaign offered for a draft is on
 * the draft's channel. What can differ under another campaign is only the
 * clock, the cap and the campaign's own status, and the card says so.
 */
export function campaignToCheck(
  draft: { readonly channel: string; readonly campaignId: string | null },
  campaigns: readonly CampaignLike[],
): CheckedUnder | null {
  if (draft.campaignId) {
    const own = campaigns.find((c) => c.id === draft.campaignId)
    if (own) return { id: own.id, name: own.name, own: true }
  }
  const onChannel = campaigns.filter((c) => c.channel === draft.channel)
  const first = onChannel.find((c) => c.status === 'active') ?? onChannel[0]
  return first ? { id: first.id, name: first.name, own: false } : null
}

/** The label above the candidates, naming the campaign the check ran under. */
export function checkedUnderLabel(checked: CheckedUnder | null, channel: string): string {
  if (checked === null) return `Not checked: there is no ${channel} campaign to check against.`
  return checked.own
    ? `Checked when this page loaded, under this draft's campaign, ${checked.name}.`
    : `Checked when this page loaded, under ${checked.name} — the first ${channel} campaign; the draft has none of its own yet.`
}

/**
 * Said when the person chooses a campaign other than the one checked. Only
 * the clock, the cap and the status can differ (see `campaignToCheck`).
 */
export const OTHER_CAMPAIGN_NOTE =
  'The check above ran under a different campaign. Suppression and consent are the same under any ' +
  'campaign on this channel; quiet hours, the daily cap and the status may not be — the worker checks those at sending.'

// ---------------------------------------------------------------------------
// The registration an SMS or WhatsApp draft names (0019)
// ---------------------------------------------------------------------------

/** The template a draft was rendered from, as the card shows it: the registration's ids, never its body. */
export interface DraftTemplate {
  /** The DLT template id (or a WhatsApp template's name). */
  readonly externalId: string
  /** The DLT header the template is registered with. */
  readonly senderId: string
  readonly category: string
  readonly active: boolean
}

/** The card's title for a draft with no subject of its own — an SMS has none. */
export function draftTitle(subject: string | null, template: DraftTemplate | null | undefined): string {
  if (subject) return subject
  return template ? `From template ${template.externalId}` : '(no subject)'
}

/**
 * The line under an SMS draft's words: what the operator will check them
 * against. A template switched off since is said to be, because the send
 * path refuses a draft from it (`no_template`) — the card's own block says
 * what to do about that.
 */
export function templateLine(t: DraftTemplate): string {
  return (
    `Rendered from DLT template ${t.externalId}, header ${t.senderId}, ${t.category.replace(/_/g, ' ')}` +
    (t.active ? '. The operator delivers it only as these exact words.' : ' — switched off since this was drafted.')
  )
}

/**
 * The people an SMS draft can be approved to: the one it was rendered for.
 * Its `{#var#}` slots were filled for that person — their name, their
 * company — so the same words to somebody else would be the right template
 * with the wrong values. An email draft keeps everyone at its company.
 * WhatsApp is a template channel too, and `approveDraft` refuses anyone else
 * on it (`rendered_for_another`), so it is narrowed the same way.
 */
export function smsCandidates<T extends { readonly id: string }>(
  channel: string,
  contactId: string | null,
  people: readonly T[],
): readonly T[] {
  if (!TEMPLATE_CHANNEL_NAMES.has(channel) || !contactId) return people
  return people.filter((p) => p.id === contactId)
}

// ---------------------------------------------------------------------------
// Who addressed it
// ---------------------------------------------------------------------------

export type AddressedBy = 'enrolment' | 'inbox' | null

/**
 * Who chose the recipient before a person saw the draft.
 *
 * An inbox answer names the reply it answers (`answers_touch_id`, 0018). A
 * row with a contact and a campaign and no such link was written by campaign
 * enrolment — the only other writer of a pre-addressed outbound row. The
 * agent's `queue_touch` writes a draft to nobody.
 */
export function addressedByOf(touch: {
  readonly contactId: string | null
  readonly campaignId: string | null
  readonly answersTouchId: string | null
}): AddressedBy {
  if (touch.answersTouchId) return 'inbox'
  if (touch.contactId && touch.campaignId) return 'enrolment'
  return null
}

/** The line on a pre-addressed card. The choice is a suggestion, and it says so. */
export function addressedByLabel(by: AddressedBy): string | null {
  switch (by) {
    case 'enrolment':
      return 'Addressed by enrolment — change if wrong.'
    case 'inbox':
      return 'Addressed by the inbox — change if wrong.'
    case null:
      return null
  }
}

// ---------------------------------------------------------------------------
// The evidence the draft may quote
// ---------------------------------------------------------------------------

/**
 * The evidence behind ONE draft, judged the way the sender judges its words
 * (`evidenceAsOfFor` in packages/db): by the latest successful scan at or
 * before the moment the words were written, aged at now — or, for an answer
 * to a reply, by no scan at all. It used to be the company's LATEST scan for
 * every card, so the panel and the decision beside it could describe two
 * different scans: after a re-scan it listed the new scan's lines under
 * words written from the old one, and it warned "the send path refuses"
 * over an answer the sender never judges by scan age. Found by review.
 */
export interface DraftEvidence {
  /**
   * When the scan described ran (ISO): the one the words were written from,
   * or — for an answer — the company's latest. Null only for an answer about
   * a company with no successful scan.
   */
  readonly asOf: string | null
  /**
   * Derived from that scan's `ran_at` by `isStale` at now, never read from
   * `findings.stale`. For a draft it is the sender's own `stale_evidence`
   * question; for an answer it is only a caution, which the sender does not
   * ask.
   */
  readonly stale: boolean
  /**
   * One line per quotable finding — `quotableFindings`, the draft
   * generator's own filter, which reads the company's LATEST scan. So there
   * are lines only when that is the scan described, and it is fresh: nothing
   * stale is quotable, and a newer scan's lines are not what these words
   * were written from.
   */
  readonly lines: readonly string[]
  /** An answer to a reply (`answers_touch_id`): the sender judges it by no scan. */
  readonly answersReply?: boolean
  /** A successful scan newer than the one the words were written from, when there is one. */
  readonly newer?: { readonly asOf: string; readonly stale: boolean } | null
}

/**
 * A scan, as the page reads it: its id, when it ran, and whether it is past
 * its re-verification deadline now — judged by the page with `isStale` on
 * `ran_at` (this file imports nothing from the server or from core's
 * runtime, because a client component imports it).
 */
export interface EvidenceScan {
  readonly id: string
  readonly ranAt: Date
  readonly stale: boolean
}

/**
 * The evidence panel for one draft, from what the page read. Pure: the page
 * does the reads — the latest successful scan at or before the draft's
 * `created_at` (`writtenFrom`), the company's latest successful scan
 * (`latest`) and that scan's quotable lines — and this decides which of them
 * describes the draft.
 *
 * Null for a draft written before any successful scan of its company: the
 * sender has no scan to judge its words by, and `evidenceNote` says so.
 */
export function draftEvidenceFrom(input: {
  readonly answersReply: boolean
  readonly writtenFrom: EvidenceScan | null
  readonly latest: EvidenceScan | null
  /** `quotableFindings` over `latest`, as lines — empty when it is stale or there is none. */
  readonly latestLines: readonly string[]
}): DraftEvidence | null {
  const { latest } = input
  if (input.answersReply) {
    if (!latest) return { asOf: null, stale: false, lines: [], answersReply: true }
    return {
      asOf: latest.ranAt.toISOString(),
      stale: latest.stale,
      lines: latest.stale ? [] : input.latestLines,
      answersReply: true,
    }
  }
  const written = input.writtenFrom
  if (!written) return null
  const newer =
    latest && latest.id !== written.id && latest.ranAt.getTime() > written.ranAt.getTime()
      ? { asOf: latest.ranAt.toISOString(), stale: latest.stale }
      : null
  return {
    asOf: written.ranAt.toISOString(),
    stale: written.stale,
    lines: written.stale || newer ? [] : input.latestLines,
    newer,
  }
}

/**
 * §2.2: the sentence a stale card leads with. It used to end "re-scan, then
 * approve", which stopped being true when the send path started refusing
 * stale evidence: a draft is judged by the scan that was current when it was
 * WRITTEN, so a re-scan freshens the company and never this draft's words.
 */
export const STALE_EVIDENCE_NOTE =
  'This draft is about a company whose findings are stale; §2.2 says re-verify before anything outbound — ' +
  're-scan, then draft it again. The send path refuses a draft written from a stale scan, and approving does not change that.'

/**
 * A draft written before any successful scan of its company. Not "never
 * scanned": the company may have been scanned since, and these words were
 * still not written from it.
 */
export const MISSING_EVIDENCE_NOTE =
  'No successful scan of this company had run when this draft was written, so nothing it says about them ' +
  'was observed here; §2.2 says re-verify before anything outbound — check every claim against the company page, ' +
  'or scan and draft it again.'

/**
 * An answer to a reply. The sender does not judge it by the age of a scan
 * (`evidenceAsOfFor` is null for it), so the card must not say the send path
 * refuses it — that steered approvers to deny legitimate answers. What is
 * left is the person's own check. Found by review.
 */
export const ANSWER_EVIDENCE_NOTE =
  'This is an answer to their reply. The send path does not judge an answer by the age of a scan, so the ' +
  'evidence does not stop it — check that it repeats no finding that is no longer known to be true.'

/** How many evidence lines a card shows before pointing at the company page. */
export const EVIDENCE_LINES_SHOWN = 6

/**
 * One quotable finding as a line: the ICP's reason the gap matters, then what
 * the scanner actually saw. A finding with no detail says so rather than
 * inventing one — "header absent" is an inference the card does not make.
 */
export function evidenceLine(f: { readonly signalKey: string; readonly why: string | null; readonly detail: string | null }): string {
  const claim = f.why?.trim() || f.signalKey
  const observed = f.detail?.trim() || 'no detail recorded — see the company page'
  return `${claim}: ${observed}`
}

export type EvidenceNote =
  | { readonly tone: 'warn'; readonly text: string }
  | { readonly tone: 'plain'; readonly text: string }

/**
 * What the card says about the evidence behind the draft.
 *
 * Stale and missing are warnings. This note decides nothing: whether Approve
 * is enabled comes from the candidates' `previewSend` answers, and those ask
 * the sender's own question — is the scan these words were WRITTEN from past
 * its deadline now? — so a draft written from a stale scan is blocked there,
 * as `stale_evidence`, and a draft written before any scan is not (no scan
 * could have been quoted). The panel describes that same scan
 * (`draftEvidenceFrom`), so the two cannot disagree. A fresh scan with no
 * gaps is plain: nothing is wrong, but a draft claiming a gap has nothing
 * behind it. An answer to a reply never gets the stale sentence, because
 * the sender never refuses one as stale.
 */
export function evidenceNote(evidence: DraftEvidence | null, hasCompany: boolean): EvidenceNote | null {
  if (!hasCompany) {
    return { tone: 'plain', text: 'This draft is not about a company, so there is no scan evidence to check it against.' }
  }
  if (evidence?.answersReply) return answerNote(evidence)
  if (evidence === null || evidence.asOf === null) return { tone: 'warn', text: MISSING_EVIDENCE_NOTE }
  const written = shortDate(evidence.asOf)
  if (evidence.stale) {
    // Re-scanned since, and the new scan is fresh: "re-scan" has been done,
    // and only a new draft freshens the words.
    if (evidence.newer && !evidence.newer.stale) {
      return {
        tone: 'warn',
        text:
          `The scan this draft was written from (${written}) is past its re-verification deadline, and the send ` +
          'path refuses words written from it; approving does not change that. The company was re-scanned ' +
          `${shortDate(evidence.newer.asOf)} — deny this draft and draft it again from that scan.`,
      }
    }
    return { tone: 'warn', text: `${STALE_EVIDENCE_NOTE} The scan it was written from ran ${written}.` }
  }
  if (evidence.newer) {
    return {
      tone: 'plain',
      text:
        `Written from the scan of ${written}. A newer scan ran ${shortDate(evidence.newer.asOf)}, so its lines are ` +
        'not listed as what these words may quote — check them against the company page, which shows what changed.',
    }
  }
  if (evidence.lines.length === 0) {
    return {
      tone: 'plain',
      text: `The scan this draft was written from (${written}) observed no gaps, so the draft has none to quote.`,
    }
  }
  return null
}

/** The note on an answer to a reply: the person's own check, and the latest scan's standing. */
function answerNote(evidence: DraftEvidence): EvidenceNote {
  if (evidence.asOf === null) {
    return { tone: 'plain', text: `${ANSWER_EVIDENCE_NOTE} This company has no successful scan.` }
  }
  const latest = shortDate(evidence.asOf)
  if (evidence.stale) {
    return {
      tone: 'warn',
      text:
        `${ANSWER_EVIDENCE_NOTE} The last successful scan ran ${latest} and is past its re-verification deadline, ` +
        'so nothing it observed may be repeated as current.',
    }
  }
  if (evidence.lines.length === 0) {
    return { tone: 'plain', text: `${ANSWER_EVIDENCE_NOTE} The latest successful scan (${latest}) observed no gaps.` }
  }
  return { tone: 'plain', text: ANSWER_EVIDENCE_NOTE }
}

/** The heading over the evidence lines, with the scan's date. */
export function evidenceHeading(evidence: DraftEvidence): string {
  return `What the draft may quote — observed ${evidence.asOf ? shortDate(evidence.asOf) : 'an unknown date'}`
}

// ---------------------------------------------------------------------------
// Approving does not send
// ---------------------------------------------------------------------------

export const APPROVE_DOES_NOT_SEND = 'Approving does not send. The worker re-checks every rule at the moment of sending.'

/**
 * Configuration, never observation (`deployment()` says what this web half
 * is set up to reach): a worker on Fly can be sending against this database
 * while this deployment holds no AGENT_URL, so "nothing will send" is not
 * something this line knows. Review round 3, finding [20].
 */
export const NO_WORKER_FOOTNOTE =
  'Approving does not send. No worker is configured on this deployment — if one runs against this database ' +
  'elsewhere, it checks every rule again at the moment of sending, not now.'

/**
 * LinkedIn is never sent by the worker: its only provider sends email, so an
 * approved LinkedIn row waits for a PERSON, as a step on /tasks — Start
 * checks every rule at that moment and hands them the words, and they send
 * from their own account. With or without a worker. Review round 3, [19].
 */
export const LINKEDIN_APPROVE_FOOTNOTE =
  'Approving does not send. A LinkedIn message becomes a step on /tasks for a person to send from their own ' +
  'account — every rule is checked again when they press Start.'

export const LINKEDIN_APPROVED =
  'Approved. It is now a LinkedIn step on /tasks: a person presses Start there, every rule is checked again at ' +
  'that moment, and they send it from their own LinkedIn account. Nothing was sent, and no worker sends LinkedIn.'

const isLinkedIn = (channel: string): boolean => channel === 'linkedin'

/**
 * An SMS goes through DoveSoft, and only where the WORKER holds
 * DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID — its host, which this web half
 * cannot see. A worker with SMS off reports the row unserved and leaves it
 * alone, so "the worker will send it" was a promise nothing here could
 * keep. The worker writes whether SMS is on into its heartbeat, and the
 * dashboard's worker line reads it; that is where to look.
 */
const SMS_APPROVED =
  'Approved. An SMS goes only through DoveSoft, and only if SMS is switched on where the worker runs ' +
  '(DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID on its host, which this page cannot see) — the dashboard’s worker ' +
  'line says whether it is. Every rule is checked again at sending, the registered template included.'

const SMS_APPROVED_NO_WORKER =
  'Approved, and queued. No worker is configured on this deployment, so it goes only if one runs against this ' +
  'database elsewhere with SMS switched on — through DoveSoft, with DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID on its ' +
  'host — and every rule is checked at that moment, not now, the registered template included.'

/**
 * The line beside Approve. With no worker configured, "the worker re-checks"
 * describes something this deployment does not know is there, so the line
 * says what it does know; the queue shows `nothingWillSendNote()` once, above
 * the cards. A LinkedIn draft is a person's to send whatever the worker is
 * doing, so neither sentence is about it.
 */
export function approveFootnote(noSenderNote: string | null, channel = 'email'): string {
  if (isLinkedIn(channel)) return LINKEDIN_APPROVE_FOOTNOTE
  return noSenderNote ? NO_WORKER_FOOTNOTE : APPROVE_DOES_NOT_SEND
}

/** What the card says once a draft is approved. */
export function approvedMessage(channel: string, noSenderNote: string | null): string {
  if (isLinkedIn(channel)) return LINKEDIN_APPROVED
  if (channel === 'sms') return noSenderNote === null ? SMS_APPROVED : SMS_APPROVED_NO_WORKER
  return noSenderNote === null
    ? 'Approved. The worker will send it on its next pass — after checking the suppression list, ' +
        'consent, quiet hours and the daily cap again. If it lands in quiet hours it waits for morning.'
    : 'Approved, and queued. No worker is configured on this deployment, so it goes only if one runs against ' +
        'this database elsewhere — and every rule is checked at that moment, not now.'
}

/**
 * `nothingWillSendNote()` above the queue — only while a draft on it is one
 * a worker would send. A queue of LinkedIn drafts waits for a person on
 * /tasks, so a sentence about the worker is about none of them.
 */
export function queueNoSenderNote(channels: readonly string[], noSenderNote: string | null): string | null {
  return channels.some((c) => !isLinkedIn(c)) ? noSenderNote : null
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export const KEY_HELP =
  'Keys: j / k move between drafts · a, then Enter, approves the focused draft · d denies it · Esc cancels.'

/**
 * The card after `key` moves focus from `current`. `j` is next and `k` is
 * previous, both wrapping; from no card (or one no longer listed) `j` lands
 * on the first and `k` on the last. Any other key leaves focus where it was.
 */
export function nextFocus(ids: readonly string[], current: string | null, key: string): string | null {
  if (key !== 'j' && key !== 'k') return current
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at === -1) return key === 'j' ? ids[0]! : ids[ids.length - 1]!
  const step = key === 'j' ? 1 : -1
  return ids[(at + step + ids.length) % ids.length]!
}

export type Approvability = { readonly ok: true } | { readonly ok: false; readonly why: string }

export type KeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'arm'; readonly id: string }
  | { readonly kind: 'disarm' }
  | { readonly kind: 'approve'; readonly id: string }
  | { readonly kind: 'deny'; readonly id: string }
  | { readonly kind: 'explain'; readonly id: string; readonly why: string }

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/**
 * What a keypress does on /approvals.
 *
 * Approving is the one action here that ends with a message leaving the
 * building, so it is never ONE key: `a` arms the card the person explicitly
 * focused (the card says "press Enter to approve"), and only Enter on that
 * same card approves. Any other key, or focus moving, disarms — a stray `a`
 * in the wrong tab is a prompt, never an outbound message. `d` denies
 * outright: denying sends nothing, and the draft is kept with the note.
 *
 * `focused` is the card that has DOM focus — clicked, tabbed to, or reached
 * with j/k — and null when nothing is; `a`, Enter and `d` do nothing then.
 * The caller ignores keys typed into a field or on a button, and any key
 * with Ctrl, Alt or Meta, before asking.
 */
export function keyAction(input: {
  readonly key: string
  readonly ids: readonly string[]
  readonly focused: string | null
  readonly armed: string | null
  readonly approvable: (id: string) => Approvability
  readonly deniable: (id: string) => boolean
}): KeyAction {
  const { key, ids, focused, armed } = input
  if (MODIFIER_KEYS.has(key)) return { kind: 'none' }

  if (key === 'j' || key === 'k') {
    const next = nextFocus(ids, focused, key)
    return next === null ? (armed ? { kind: 'disarm' } : { kind: 'none' }) : { kind: 'focus', id: next }
  }

  if (key === 'Enter') {
    if (armed === null) return { kind: 'none' }
    if (armed !== focused) return { kind: 'disarm' }
    return input.approvable(armed).ok ? { kind: 'approve', id: armed } : { kind: 'disarm' }
  }

  if (key === 'a') {
    if (focused === null) return armed ? { kind: 'disarm' } : { kind: 'none' }
    const can = input.approvable(focused)
    return can.ok ? { kind: 'arm', id: focused } : { kind: 'explain', id: focused, why: can.why }
  }

  if (key === 'd') {
    if (focused === null || !input.deniable(focused)) return armed ? { kind: 'disarm' } : { kind: 'none' }
    return { kind: 'deny', id: focused }
  }

  // Escape, and every other key: an armed card is disarmed, nothing else happens.
  return armed ? { kind: 'disarm' } : { kind: 'none' }
}

/**
 * Whether a card can be approved right now, and if not, why — for the `a`
 * key, which has no button to grey out.
 */
export function approvability(card: {
  readonly canDecide: boolean
  readonly settled: boolean
  readonly busy: boolean
  readonly contactId: string
  readonly campaignId: string
  readonly block: string | null
}): Approvability {
  if (!card.canDecide) return { ok: false, why: 'Your role cannot decide approvals.' }
  if (card.settled) return { ok: false, why: 'This draft has already been decided.' }
  if (card.busy) return { ok: false, why: 'A decision on this draft is already on its way.' }
  if (!card.contactId || !card.campaignId) return { ok: false, why: 'Choose a person and a campaign first.' }
  if (card.block) return { ok: false, why: card.block }
  return { ok: true }
}
