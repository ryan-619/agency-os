/**
 * The one code path that can cause a message to leave the building (§8.4).
 *
 * §8.4, in full, because every word of it is load-bearing:
 *
 * > Send path, in this order, every time, no exceptions: suppression check →
 * > consent check → quiet-hours check → daily-cap check → approval gate →
 * > provider send → write `touches` → write `audit_log`. Put this in one
 * > function in `packages/core`. Every channel calls it. **There must be
 * > exactly one code path that can cause a message to leave the building.**
 *
 * ## Why the decision is pure and the sending is not
 *
 * `packages/core` does no I/O — that is the architectural rule this repo is
 * pedantic about (§3), and it is exactly right here. The first four checks are
 * the ones with legal consequences, and they are the ones that must be
 * testable one edge case at a time, offline, without a database and without a
 * mail server.
 *
 * So `decideSend` is a pure function from FACTS to a DECISION. The caller
 * gathers the facts (three queries) and obeys the decision. It cannot reorder
 * the checks, because it does not perform them; it cannot skip one, because
 * the facts for all of them are required arguments and TypeScript will not let
 * a caller omit one.
 *
 * That last property is the real design. A caller that forgets to look up
 * suppression cannot call this function at all.
 *
 * ## Absence is never permission
 *
 * Every field that could be missing is typed so that missing means NO:
 *
 *  - `consent` is a tri-state, and `null` — no row — is a refusal, not a
 *    default. §2.1: "Every contact row carries a `consent` record… A send
 *    attempt without the matching consent must fail loudly at the service
 *    layer."
 *  - `recipientTimeZone` may be null, and a null does NOT skip quiet hours.
 *    Not knowing when it is where someone lives is a reason to wait, not a
 *    reason to send.
 *  - `suppressionKeys` may be null, meaning the recipient could not be
 *    normalised — so no suppression row could ever have matched them. That is
 *    a refusal that needs a human, not a clear result.
 *
 * ## Three steps §8.4 does not name, and where they sit
 *
 * The order below is §8.4's with three additions, all after consent and
 * before the clock: a PAUSE (the person replied, or a teammate is holding
 * them — §8.4's "pauses the sequence"), STALE EVIDENCE (§2.2: the findings
 * the words quote are past their re-verification deadline) and a permanent
 * BOUNCE (evidence that the address does not work). None of them is a
 * person asking to be left alone, so none may outrank suppression or a
 * recorded refusal — the reason logged for somebody who opted out must be
 * the opt-out. Among themselves, the two nobody may approve past come
 * before the one a person resolves, so the reason reported is never one
 * that reads as fixable while another that is not still stands. And all
 * three come before quiet hours, because the clock DEFERS a message and
 * these do not: a message held until morning would still be to somebody
 * paused, would still quote something no longer known to be true, and
 * would still bounce.
 *
 *   cold channel → unparseable → suppressed → consent → paused →
 *   stale evidence → bounced → timezone / quiet hours → cap → campaign →
 *   approval
 */

import { normalisePhone, suppressionKeysFor, type SuppressionKind } from './normalise.js'

export type Channel = 'email' | 'linkedin' | 'sms' | 'voice' | 'whatsapp'

/**
 * The channels a COLD message may use (§2.1).
 *
 * "The system must make it structurally impossible to place a cold outbound
 * call or send a cold SMS." A set, checked in the send path, so it is
 * impossible rather than merely discouraged.
 */
export const COLD_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['email', 'linkedin'])

/** Channels that require a recorded opt-in before any message at all. */
export const OPT_IN_ONLY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'sms',
  'voice',
  'whatsapp',
])

export type SendRefusalCode =
  | 'unparseable_recipient'
  | 'suppressed'
  | 'bounced'
  | 'cold_channel_forbidden'
  | 'no_consent'
  | 'consent_revoked'
  | 'paused'
  | 'stale_evidence'
  | 'quiet_hours'
  | 'unknown_timezone'
  | 'daily_cap'
  | 'campaign_inactive'
  | 'needs_approval'

export interface SendRefusal {
  readonly allowed: false
  readonly code: SendRefusalCode
  /**
   * One sentence for a person, naming the rule and what to do. Never contains
   * the message body, and never the recipient — a refusal is logged, and §2.3
   * says logs do not carry message bodies.
   */
  readonly reason: string
  /**
   * True when a human could legitimately resolve this by deciding.
   *
   * False for the rules that no human may override: a suppression is someone's
   * opt-out, a cold call is illegal, a paused person is lifted by a person
   * deciding to (never by approving one message past it), and a finding past
   * its re-verification deadline is not known to be true however many people
   * approve the words. Offering those to an approver would turn a policy into
   * a habit of clicking yes.
   */
  readonly humanCanResolve: boolean
}

export interface SendAllowed {
  readonly allowed: true
  /** Every check passed AND the campaign has auto-send. Send it now. */
  readonly code: 'send_now'
}

export type SendDecision = SendAllowed | SendRefusal

/** What the caller must look up before it may ask. */
export interface SendFacts {
  readonly channel: Channel
  /** The address or number as stored. Normalised here, never by the caller. */
  readonly recipient: string
  /**
   * Whether ANY suppression row matched this recipient's keys.
   *
   * Looked up with `suppressionKeysFor()`, which returns every key a recipient
   * matches — an email is suppressed by its address AND by its domain.
   */
  readonly suppressed: boolean
  /**
   * The receiving server said this ADDRESS does not exist — a permanent
   * bounce, read from a delivery-status report that named a message this
   * system sent, and stored on the contact with the report's own status code
   * as the evidence (`contacts.email_bounced_at`, 0018).
   *
   * Evidence about an address, not a person asking to be left alone: that is
   * why it is a fact of its own rather than a suppression, and why a person
   * CAN resolve it — by correcting the address, which clears the mark. Never
   * by approving: the step sits above the approval gate. Absent means false.
   */
  readonly recipientBounced?: boolean
  /**
   * The findings these WORDS were written from are past their
   * re-verification deadline now (§2.2: "must be re-verified before
   * appearing in any outbound draft").
   *
   * Required, not optional: the one thing a message body cannot do is
   * notice that it has aged. A draft quotes the scan that was current when
   * it was written, and a deferral — the cap, quiet hours, a paused
   * campaign — can hold it for weeks; the rescan cron refreshes the scan and
   * never the words. So the caller must say, for every message, whether the
   * evidence behind it is still fresh AT THE MOMENT OF SENDING, judged by
   * `isStale` on the scan's `ran_at` and never by `findings.stale`.
   *
   * False when the words quote no scan — an answer to a reply, or a company
   * with no successful scan at or before the moment they were written.
   */
  readonly evidenceStale: boolean
  /**
   * The consent row for THIS channel, or null when there is none.
   *
   * `null` and `{ granted: false }` are both refusals and are deliberately
   * distinguishable: one is "nobody ever asked" and the other is "they said
   * no", and the second is the one that must never be re-asked.
   */
  readonly consent: { readonly granted: boolean; readonly source: string } | null
  /**
   * The contact is paused (`contacts.paused_at`): they replied, a teammate
   * is holding them, or an opt-out or an erasure could not be completed.
   * Every campaign stops for them until a person lifts it — by answering
   * the reply from /inbox, or resuming them on /contacts.
   *
   * Required, and its own fact rather than a stand-in for a revoked
   * consent. It used to be modelled as one, so a teammate's hold was logged
   * `consent_revoked` — the recipient's own no — and enrolment read it that
   * way for ever after the hold was lifted. Found by review.
   */
  readonly paused: boolean
  /**
   * What paused them, as a CLASS (`pauseReasonClass`), for the refusal's
   * sentence only — the decision does not read it. Never the reason's text:
   * a teammate's reason can carry their address and the contact's words.
   * Absent reads as `other`.
   */
  readonly pausedFor?: PauseReasonClass
  /** The recipient's IANA zone. Null means unknown, which is a refusal. */
  readonly recipientTimeZone: string | null
  /** Local wall-clock times, from the campaign. */
  readonly quietStart: string
  readonly quietEnd: string
  /** How many messages this campaign has already sent today. */
  readonly sentToday: number
  readonly dailyCap: number
  /**
   * The campaign's own status. Only `active` sends. A `paused` campaign is
   * exactly what somebody reaches for when something is wrong, and a
   * campaign builder whose Pause button changed nothing was found by review:
   * the status was offered by the form and honoured nowhere.
   */
  readonly campaignStatus: 'draft' | 'active' | 'paused' | 'done'
  /** §2.4. False means the message goes to the approval queue. */
  readonly autoSend: boolean
  /**
   * A person has already read THIS message and said yes.
   *
   * Satisfies the approval gate exactly as `autoSend` does, and nothing else:
   * every §2.1 rule above still runs. That is the whole point of routing an
   * approved draft back through here rather than straight to the provider —
   * the human decided the message was right, not that the recipient had not
   * opted out in the hour since. Absent means false.
   */
  readonly approvedByHuman?: boolean
  /** Evaluated against the recipient's zone. */
  readonly now: Date
}

const refuse = (code: SendRefusalCode, reason: string, humanCanResolve = false): SendRefusal => ({
  allowed: false,
  code,
  reason,
  humanCanResolve,
})

/**
 * Decide whether this message may leave the building.
 *
 * The order is §8.4's order and the tests assert the ORDER, not just the
 * outcomes — a suppressed recipient must be refused as suppressed even when
 * the campaign is also over its cap, because the reason is what gets logged
 * and what someone reads six months later.
 */
export function decideSend(facts: SendFacts): SendDecision {
  // 0. The channel itself. §2.1: cold voice and SMS must be structurally
  //    impossible, so this is checked before anything that could be read as
  //    conditionally allowing them.
  const optInOnly = OPT_IN_ONLY_CHANNELS.has(facts.channel)
  if (optInOnly && !facts.consent?.granted) {
    return refuse(
      'cold_channel_forbidden',
      `${facts.channel} is for inbound contacts and recorded opt-ins only. Cold outreach is ` +
        'email and LinkedIn. Nothing was sent, and no one can approve this.',
    )
  }

  // 1. Suppression, first and above everything (§2.1). Before consent, because
  //    a suppressed person who also granted consent is still suppressed — the
  //    opt-out is the later, stronger statement.
  const keys = suppressionKeysFor(facts.recipient, facts.channel)
  if (keys === null) {
    // The recipient could not be normalised, so NO suppression row could ever
    // have matched them. This is not "not suppressed" — it is "unknown", and
    // treating it as clear is how an opt-out gets ignored.
    return refuse(
      'unparseable_recipient',
      'This recipient could not be read as a valid address or number, so the suppression list ' +
        'could not be checked against it. Nothing was sent. Fix the contact record.',
      true,
    )
  }
  if (facts.suppressed) {
    return refuse(
      'suppressed',
      'This recipient is on the suppression list. Nothing was sent, and no one can approve ' +
        'sending to them — a suppression is somebody asking to be left alone.',
    )
  }

  // 2. Consent. Absence is NO, and there is no "unknown" state to misread.
  if (facts.consent === null) {
    if (optInOnly) {
      // Unreachable — step 0 caught it. Kept because the rule matters more
      // than the flow: if step 0 is ever loosened, this still refuses.
      return refuse('no_consent', `No recorded opt-in for ${facts.channel}. Nothing was sent.`)
    }
    // Cold email and LinkedIn do not require a prior opt-in; that is what
    // makes them the cold channels. A recorded refusal still stops them.
  } else if (!facts.consent.granted) {
    return refuse(
      'consent_revoked',
      `This contact has declined ${facts.channel} (recorded: ${facts.consent.source}). ` +
        'Nothing was sent, and no one can approve overriding it.',
    )
  }

  // 2a. A paused contact, right after consent. A recorded refusal and a
  //     suppression are the stronger statements and outrank it in the log;
  //     a pause is not the person saying no to the channel, and must not be
  //     logged as if it were — `consent_revoked` is what enrolment reads as
  //     the recipient's own no. Nobody may approve past it: the pause ends
  //     when a person decides it does (answering the reply, or resuming
  //     them), and that decision is audited where it is made.
  if (facts.paused) {
    return refuse('paused', pausedSentence(facts.pausedFor ?? 'other'))
  }

  // 2b. Stale evidence (§2.2). The words quote findings that are past their
  //     re-verification deadline now, however fresh they were when written.
  //     Nobody may approve past it: approving the words does not make them
  //     current, and the send path is where "must be re-verified before
  //     appearing in any outbound draft" is kept for a message nobody reads
  //     again — an auto-send row a deferral held for weeks. Before quiet
  //     hours, so a stale message is refused, never deferred to go stale
  //     further. Before the bounce, which a person CAN resolve: a stale draft
  //     whose address also bounced read as "fix this first" with Approve
  //     enabled, and flipped to a blocked stale_evidence once the address
  //     was corrected. Found by review.
  if (facts.evidenceStale) {
    return refuse(
      'stale_evidence',
      'The findings this message quotes come from a scan past its re-verification deadline (§2.2), ' +
        'so they are no longer known to be true. Nothing was sent, and approving does not make ' +
        'them current. Re-scan the company, then draft the message again.',
    )
  }

  // 2c. A permanent bounce, after every refusal nobody may approve past. A
  //     person who declined, is paused or would be sent stale words, and
  //     whose address ALSO bounced, must be reported as that refusal:
  //     reported as `bounced` it read as resolvable, so /approvals enabled
  //     Approve and the inbox resumed them. Found by review. Before the
  //     clock, because a message held until morning would bounce all the
  //     same.
  if (facts.recipientBounced === true) {
    return refuse(
      'bounced',
      'The last message to this address bounced permanently — the receiving server said it ' +
        'does not accept mail for it. Nothing was sent. Correct the address on the contact; ' +
        'changing it clears the mark. Approving does not.',
      true,
    )
  }

  // 3. Quiet hours, in the RECIPIENT's timezone (§2.1) — never the sender's.
  if (facts.recipientTimeZone === null) {
    return refuse(
      'unknown_timezone',
      'This contact has no timezone, so quiet hours could not be checked in their local time. ' +
        'Nothing was sent. Set a timezone on the contact, or on their company.',
      true,
    )
  }
  const local = localMinutes(facts.now, facts.recipientTimeZone)
  if (local === null) {
    return refuse(
      'unknown_timezone',
      `"${facts.recipientTimeZone}" is not a timezone this system recognises, so quiet hours ` +
        'could not be checked. Nothing was sent.',
      true,
    )
  }
  if (isQuiet(local, facts.quietStart, facts.quietEnd)) {
    return refuse(
      'quiet_hours',
      `It is currently quiet hours for this recipient (${facts.quietStart}–${facts.quietEnd} ` +
        `in ${facts.recipientTimeZone}). Nothing was sent; schedule it for after ${facts.quietEnd}.`,
      true,
    )
  }

  // 4. The daily cap.
  if (facts.sentToday >= facts.dailyCap) {
    return refuse(
      'daily_cap',
      `This campaign has already sent its ${facts.dailyCap} messages for today. Nothing was ` +
        'sent; it will resume tomorrow.',
      true,
    )
  }

  // 5. The campaign itself. After the per-person rules, so a suppressed
  //    recipient in a paused campaign is still logged as suppressed — the
  //    reason that matters — and before the approval gate, because a person
  //    should not be asked to approve a message its campaign will not send.
  if (facts.campaignStatus !== 'active') {
    return refuse(
      'campaign_inactive',
      `This campaign is ${facts.campaignStatus}, so nothing in it is sent. ` +
        (facts.campaignStatus === 'paused'
          ? 'It will resume when the campaign is set active again.'
          : facts.campaignStatus === 'draft'
            ? 'Set it active to start sending.'
            : 'It is finished.'),
      true,
    )
  }

  // 6. The approval gate (§2.4). Everything above passed, so the only question
  //    left is whether a human has to see it — and the default is that they do.
  //    A human who already has seen it counts, and counts for THIS message
  //    only: nothing here remembers a decision.
  if (!facts.autoSend && !facts.approvedByHuman) {
    return refuse(
      'needs_approval',
      'This campaign does not have auto-send, so the message is queued for a person to approve.',
      true,
    )
  }

  return { allowed: true, code: 'send_now' }
}

/**
 * What paused a person, as a CLASS — the reason's text never leaves the
 * contact row (§2.3). Derived from the shape each writer gives the reason:
 *
 *  - `replied`       `recordInboundReply`: exactly `replied <ISO instant>`
 *  - `opt_out_not_recorded`  an opt-out whose suppression could not be
 *                    written: a reply's, or a one-click unsubscribe's
 *  - `manual`        the contacts route: `<why> (by <who>)`
 *  - `erasure`       an erasure that could not finish
 *  - `unsubscribed`  a one-click unsubscribe that was recorded
 *  - `other`         anything else, or no reason at all
 *
 * `replied` is matched in full rather than by prefix, because a teammate's
 * reason can begin with the word too ("replied on the phone (by …)") and
 * only a pause a REPLY caused is one answering the reply may end. Pure, and
 * here rather than beside the inbox, because the send path's own refusal
 * words by it: `packages/db` re-exports it.
 */
export type PauseReasonClass = 'replied' | 'unsubscribed' | 'erasure' | 'manual' | 'opt_out_not_recorded' | 'other'

const REPLY_PAUSE = /^replied \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

export function pauseReasonClass(reason: string | null | undefined): PauseReasonClass {
  if (!reason) return 'other'
  if (REPLY_PAUSE.test(reason)) return 'replied'
  if (reason.startsWith('opt-out not recorded')) return 'opt_out_not_recorded'
  if (/\(by [^()]*\)$/.test(reason)) return 'manual'
  if (reason.startsWith('erasure ')) return 'erasure'
  if (reason.startsWith('unsubscribed ')) return 'unsubscribed'
  return 'other'
}

/**
 * The `paused` refusal's sentence, by what paused them. Each says what lifts
 * it — and an opt-out nobody could record, or an erasure that did not
 * finish, is never "resume them": the fix there is to record the opt-out or
 * finish the erasure, and resuming the person would be contacting somebody
 * who asked not to be.
 */
function pausedSentence(pausedFor: PauseReasonClass): string {
  switch (pausedFor) {
    case 'replied':
      return (
        'This contact replied, and every campaign stops for them until a person answers the reply from /inbox ' +
        '(which resumes them) or resumes them on /contacts. Nothing was sent, and approving does not lift a pause.'
      )
    case 'manual':
      return (
        'A teammate paused this contact; /contacts says why. Every campaign stops for them until a person resumes ' +
        'them there. Nothing was sent, and approving does not lift a pause.'
      )
    case 'unsubscribed':
      return (
        'This contact unsubscribed and is paused. Nothing was sent, and approving does not lift a pause — a person ' +
        'reads why on /contacts, and an unsubscribe is not something to undo.'
      )
    case 'opt_out_not_recorded':
      return (
        'This contact asked to stop and the opt-out could not be recorded, so there is no suppression row yet. ' +
        'Nothing was sent, and approving does not lift a pause. Record the opt-out by hand on /suppressions.'
      )
    case 'erasure':
      return (
        'This contact asked to be erased and the erasure did not complete. Nothing was sent, and approving does ' +
        'not lift a pause. Complete the erasure from their record on /contacts.'
      )
    case 'other':
      return (
        'This contact is paused. Nothing was sent, and approving does not lift a pause — a person reads why on ' +
        '/contacts and resumes them there if that is right.'
      )
  }
}

/**
 * Minutes past local midnight in a zone, or null if the zone is not real.
 *
 * `Intl.DateTimeFormat` is the only timezone database available without a
 * dependency, and it is the right one: it ships with the runtime and tracks
 * IANA updates with it. An invalid zone THROWS here, which is why this returns
 * null rather than letting it escape — a typo in a contact's timezone must
 * refuse a send, not crash the sender.
 */
export function localMinutes(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return hour * 60 + minute
  } catch {
    return null
  }
}

/**
 * Is `local` inside the quiet window?
 *
 * The window WRAPS midnight in the normal case — 21:00 to 08:00 is the default
 * — so a naive `start <= t && t < end` is not just wrong, it is inverted for
 * every sensible configuration: it would treat the entire working day as quiet
 * and every night as sendable.
 */
export function isQuiet(local: number, quietStart: string, quietEnd: string): boolean {
  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  // An unparseable window is treated as always quiet. It is a configuration
  // error, and the safe reading of "I do not know when I may send" is "not
  // now" — the campaign stalls visibly instead of sending at 3am.
  if (start === null || end === null) return true
  if (start === end) return false // A zero-length window is no quiet hours.
  return start < end
    ? local >= start && local < end // Does not wrap: e.g. 01:00–06:00.
    : local >= start || local < end // Wraps midnight: e.g. 21:00–08:00.
}

/** `HH:MM` or `HH:MM:SS` (Postgres `time` renders the latter) to minutes. */
function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * The keys to look up in `suppressions` for one recipient.
 *
 * Re-exported from here so a caller building the facts reaches for the send
 * module rather than assembling its own key list — the failure this guards
 * against is a caller that checks the address but not the domain.
 */
export { suppressionKeysFor, normalisePhone }
export type { SuppressionKind }

/**
 * What a reply was, for triage (§5.5's `classify_reply`).
 *
 * `opted_out` is in this list and is the one a model NEVER decides. §2.1
 * puts the opt-out reader here, in `packages/core`, as a pure function over
 * the person's own words — because a model having a pleasant conversation
 * is exactly the one that misses "take me off your list". Everything below
 * it is triage: useful, and safe to be wrong about, because being wrong
 * means somebody reads a reply in a different order rather than being
 * contacted after asking not to be.
 */
export type ReplyKind = 'opted_out' | 'interested' | 'not_now' | 'wrong_person' | 'auto_reply' | 'other'

export const REPLY_KINDS: readonly ReplyKind[] = [
  'opted_out', 'interested', 'not_now', 'wrong_person', 'auto_reply', 'other',
]

/**
 * The deterministic classifier, and the fallback a model improves on.
 *
 * Deliberately conservative. Every branch below is a phrase people actually
 * write, and anything it cannot place is `other` rather than a guess — the
 * cost of a wrong `interested` is somebody opening a dead thread first, and
 * the cost of a wrong `auto_reply` is a real buyer's answer sorted to the
 * bottom. `other` costs nothing but the reading order it started with.
 *
 * The ORDER is the meaning. Opt-out wins outright; an out-of-office that
 * happens to contain "not interested" boilerplate is still an out-of-office;
 * and "wrong person" is checked before interest because "I've left, talk to
 * Sam" often reads as enthusiastic.
 */
export function classifyReply(
  text: string | null | undefined,
  /**
   * Whether the opt-out reader already said yes — a REQUIRED argument, not a
   * lookup this function does.
   *
   * The detector lives in `packages/db` beside the send path that acts on it,
   * and duplicating it here would create a second opinion about the most
   * consequential question this product asks. Taking it as a fact means a
   * caller that has not run it cannot call this at all, which is the same
   * reason `decideSend` demands its facts rather than gathering them.
   */
  alreadyOptedOut: boolean,
): ReplyKind {
  if (alreadyOptedOut) return 'opted_out'
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return 'other'

  if (/\b(out of (the )?office|on (annual )?leave|automatic reply|auto[- ]?reply|away from my desk|on holiday|parental leave|返信|abwesenheit)\b/.test(t)) {
    return 'auto_reply'
  }
  if (/\b(no longer (with|at)|has left|i(?:'| ha)?ve left|not the right person|wrong person|try|speak to|contact) (my colleague|someone else|[a-z]+ instead)\b/.test(t)
      || /\b(no longer (with|at) (the )?(company|us)|i have left the company|not my (area|remit))\b/.test(t)) {
    return 'wrong_person'
  }
  if (/\b(not (right )?now|next (quarter|year)|circle back|revisit|too early|already have|budget (is )?frozen|maybe later|in a few months)\b/.test(t)) {
    return 'not_now'
  }
  if (/\b(interested|keen|sounds good|happy to|let'?s (talk|chat|book)|book a (call|time)|tell me more|send (me )?(more|details)|what (would|does) (it|this) cost)\b/.test(t)) {
    return 'interested'
  }
  return 'other'
}
