import { isStale, type DiffInput, type SignalChange } from '@agency/core'
import type { DealStage, ScanHistoryRow } from '@agency/db/queries'
import { actorLabel, sentenceFor, type AuditCompanyRef, type ResolvedActor } from './audit-copy'
import { inZone } from './format'
import { refusalWords } from './refusal-words'

/**
 * The company page's evidence panels — score history, the diff between two
 * scans, and one timeline of everything that happened — as pure data
 * (PROMPT.md §2.2).
 *
 * The three panels are server components (`components/evidence/*`); what they
 * SAY is decided here, where it can be tested without a database. Four rules,
 * each a way the obvious version goes wrong:
 *
 *   * **A scan that never reached the site is "unreachable", never 0.**
 *     `recordScan` writes a 0 score row for it (disqualified as
 *     `unreachable (…)`) and `scanHistory` already withholds it; the words
 *     here are the second half — there is no branch that can print a number
 *     for a scan with `ok = false`.
 *   * **"Not assessed this time" is not "fixed".** The diff's labels come
 *     from `diffFindings`' state machine, and the words for a signal the
 *     newer scan could not see say so, rather than anything a reader could
 *     take for a fix.
 *   * **A note is somebody's words.** It is labelled "note by <name>" and is
 *     never framed as something the scanner saw (`packages/db/src/notes.ts`).
 *   * **Freshness comes from `scans.ran_at`** through `isStale`, never from
 *     the `findings.stale` column, which is a cache (CLAUDE.md §1, §2.2).
 *
 * Deal moves are the subtle part. There is no stage-history table — the
 * pipeline's history is the audit log — and a move can be recorded in three
 * shapes: a `deal` row from `advanceDeal` or the board (`{ from, to }`), a
 * `deal` row from `POST /api/deals` (`{ stage }`, beside advanceDeal's own row
 * for the same move), and a label EMBEDDED in whatever caused it
 * (`contact.replied` and `meeting.booked` carry `deal: 'advanced:replied'`;
 * `proposal.accepted` closes the deal as won and `setDealStage` writes no row
 * of its own). Rows written before `advanceDeal` audited itself exist only in
 * the embedded shape, so both have to be read — and rows written since say
 * the same move twice, so a companion is folded into the first-class row it
 * repeats (`dealMovesFrom`). Two first-class rows are never folded together:
 * each is a move somebody made.
 *
 * Every audit-derived line is `sentenceFor` from `audit-copy.ts`, so the
 * timeline and /audit call the same row the same thing.
 *
 * Pure: no `env()`, no database, no `server-only`, no `@/` import — `test/
 * timeline.test.ts` imports this file, and vitest resolves neither.
 */

// ---------------------------------------------------------------------------
// Inputs — the columns each source row contributes, so a db row fits as is
// ---------------------------------------------------------------------------

/** A scan with THE score computed from it — `scanHistory`'s row. */
export type TimelineScan = ScanHistoryRow

export interface TimelineTouch {
  readonly id: string
  readonly channel: string
  readonly direction: string
  readonly status: string
  readonly subject: string | null
  readonly refusalCode: string | null
  readonly replyKind: string | null
  readonly approvedBy: string | null
  readonly scheduledFor: Date | null
  readonly sentAt: Date | null
  readonly createdAt: Date
}

export interface TimelineAuditRow {
  readonly id: string
  readonly action: string
  readonly actor: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly detail: unknown
  readonly createdAt: Date
}

export interface TimelineMeeting {
  readonly id: string
  readonly title: string | null
  readonly startsAt: Date
  readonly timeZone: string
  readonly source: string
  readonly cancelledAt: Date | null
  readonly outcome: string | null
  readonly needsReview: boolean
  readonly createdAt: Date
}

export interface TimelineProposal {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly currency: string
  readonly totalLow: number | null
  readonly totalHigh: number | null
  readonly generatedAt: Date
  readonly decidedAt: Date | null
}

export interface TimelineCall {
  readonly id: string
  readonly direction: string
  readonly status: string
  readonly outcome: string | null
  readonly startedAt: Date | null
  readonly answeredAt: Date | null
  readonly durationS: number | null
  readonly disclosedAiAt: Date | null
  readonly optedOutAt: Date | null
  readonly handoffToUserId: string | null
  readonly createdAt: Date
}

export interface TimelineNote {
  readonly id: string
  readonly body: string
  /** `notesAuthorLabel(note)` — a name, an address, or "a former teammate". */
  readonly author: string
  readonly contactName: string | null
  readonly pinned: boolean
  readonly createdAt: Date
}

export interface TimelineInputs {
  readonly company: AuditCompanyRef
  readonly now: Date
  /** The ICP's `freshness.stale_after_days` — the page's own threshold. */
  readonly staleAfterDays: number
  readonly scans?: readonly TimelineScan[]
  readonly touches?: readonly TimelineTouch[]
  /** Deal rows (`auditForSubject('deal', …)`) and the rows that embed a move. Anything else is ignored. */
  readonly audit?: readonly TimelineAuditRow[]
  readonly meetings?: readonly TimelineMeeting[]
  readonly proposals?: readonly TimelineProposal[]
  readonly calls?: readonly TimelineCall[]
  readonly notes?: readonly TimelineNote[]
  /** Who each uuid-shaped actor or approver is — `auditResolveActors`. */
  readonly actors?: ReadonlyMap<string, ResolvedActor>
  /** ICP profile names by id, for the scan lines. */
  readonly profiles?: ReadonlyMap<string, string>
  /**
   * Nothing older than this is returned: one of the sources was cut at its
   * limit here, and history merged past that point would have holes in it
   * that look like quiet weeks. `completeSince` computes it.
   */
  readonly since?: Date | null
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/** Code-unit order is the tie-break's order; it does not depend on a locale. */
export type TimelineKind = 'call' | 'deal_move' | 'meeting' | 'note' | 'proposal' | 'scan' | 'touch'

export type TimelineTone = 'plain' | 'good' | 'warn' | 'muted'

export interface TimelineEvent {
  readonly kind: TimelineKind
  /** The source row's id — a scan, a touch, an audit row, a meeting… */
  readonly id: string
  readonly at: Date
  /** The short word before the line: "scan", "reply", "deal", "note by Priya". */
  readonly label: string
  /** What happened, as a sentence. */
  readonly text: string
  /** Secondary facts, each already words. */
  readonly facts: readonly string[]
  /** Who did it, when that is not already the label. */
  readonly by: string | null
  readonly href: string | null
  readonly tone: TimelineTone
  /** The scan the page's evidence comes from, past its re-verification deadline. */
  readonly stale: boolean
}

// ---------------------------------------------------------------------------
// Small words
// ---------------------------------------------------------------------------

/** Cut by code point, so an emoji is never split in half. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

const quoted = (s: string): string => `“${s}”`
const spaced = (s: string): string => s.replace(/_/g, ' ')
const capital = (s: string): string => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s)
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A lookup by a string that came out of a row. A plain `map[key]` answers
 * `Object.prototype`'s members too.
 */
function own<T>(map: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

const CHANNEL_NOUN: Readonly<Record<string, string>> = {
  email: 'an email',
  linkedin: 'a LinkedIn message',
  sms: 'an SMS',
  voice: 'a voice message',
  whatsapp: 'a WhatsApp message',
}
const CHANNEL_NAME: Readonly<Record<string, string>> = {
  email: 'email', linkedin: 'LinkedIn', sms: 'SMS', voice: 'voice', whatsapp: 'WhatsApp',
}
const aMessage = (channel: string): string => own(CHANNEL_NOUN, channel) ?? 'a message'

const REPLY_KIND: Readonly<Record<string, string>> = {
  interested: 'interested',
  not_now: 'not now',
  wrong_person: 'wrong person',
  auto_reply: 'an automatic reply',
  opted_out: 'asked to stop',
  other: 'other',
}

// ---------------------------------------------------------------------------
// Scans — shared with the score-history table
// ---------------------------------------------------------------------------

/**
 * What one scan's row says about its score. A scan that did not reach the
 * site is `unreachable`, and there is no path through this function that
 * turns it into a number — whatever `scores` holds for it.
 */
export function scanScoreWords(row: TimelineScan): { readonly text: string; readonly unreachable: boolean } {
  if (!row.scan.ok) return { text: 'unreachable', unreachable: true }
  const s = row.score
  if (!s) return { text: 'not scored', unreachable: false }
  if (s.disqualifiedReason) return { text: `disqualified — ${s.disqualifiedReason}`, unreachable: false }
  return { text: `${s.score}/100 · ${s.tier || 'below threshold'}`, unreachable: false }
}

/**
 * The scan the page's evidence comes from: the newest one that reached the
 * site. Only it can be "stale" in the sense §2.2 means — an older scan is
 * superseded, which is a different thing.
 */
export function newestOkScanId(scans: readonly TimelineScan[]): string | null {
  let best: TimelineScan | null = null
  for (const r of scans) {
    if (!r.scan.ok) continue
    if (!best || compareDesc(r.scan.ranAt, r.scan.id, best.scan.ranAt, best.scan.id) < 0) best = r
  }
  return best?.scan.id ?? null
}

function compareDesc(a: Date, aId: string, b: Date, bId: string): number {
  return b.getTime() - a.getTime() || byCode(aId, bId)
}

function scanEvent(row: TimelineScan, input: TimelineInputs, newestOk: string | null): TimelineEvent {
  const words = scanScoreWords(row)
  if (words.unreachable) {
    return {
      kind: 'scan',
      id: row.scan.id,
      at: row.scan.ranAt,
      label: 'scan',
      text: 'A scan could not reach the site — unreachable. Nothing was observed, so nothing is claimed.',
      facts: row.scan.error ? [clip(row.scan.error, 160)] : [],
      by: null,
      href: null,
      tone: 'warn',
      stale: false,
    }
  }
  const profile = row.score
    ? input.profiles?.get(row.score.icpProfileId) ?? `ICP ${row.score.icpProfileId.slice(0, 8)}`
    : null
  const stale = row.scan.id === newestOk && isStale(row.scan.ranAt, input.staleAfterDays, input.now)
  return {
    kind: 'scan',
    id: row.scan.id,
    at: row.scan.ranAt,
    label: 'scan',
    text: `Scanned the public pages from the outside — ${words.text}`,
    facts: [
      ...(profile ? [`scored against ${profile}`] : []),
      ...(stale ? [`older than ${input.staleAfterDays} days — re-scan before quoting it`] : []),
    ],
    by: null,
    href: null,
    tone: 'plain',
    stale,
  }
}

// ---------------------------------------------------------------------------
// Messages, meetings, proposals, calls, notes
// ---------------------------------------------------------------------------

function person(input: TimelineInputs, id: string | null): string | null {
  if (!id || !UUID.test(id)) return null
  const u = input.actors?.get(id)
  return u ? u.name || u.email || 'a teammate' : 'a former teammate'
}

function touchEvent(t: TimelineTouch, input: TimelineInputs): TimelineEvent {
  const subject = t.subject?.trim() ? [quoted(clip(t.subject, 80))] : []
  if (t.direction === 'in') {
    const kind = own(REPLY_KIND, t.replyKind)
    return {
      kind: 'touch',
      id: t.id,
      at: t.sentAt ?? t.createdAt,
      label: 'reply',
      text: `A reply came in by ${own(CHANNEL_NAME, t.channel) ?? spaced(t.channel)}`,
      facts: [kind ?? 'not classified yet', ...subject],
      by: null,
      href: null,
      tone: t.replyKind === 'opted_out' ? 'warn' : 'plain',
      stale: false,
    }
  }

  const noun = aMessage(t.channel)
  let text: string
  let tone: TimelineTone = 'plain'
  switch (t.status) {
    case 'sent':
    case 'delivered':
      text = `Sent ${noun}`
      break
    case 'replied':
      text = `Sent ${noun}; it was answered`
      break
    case 'bounced':
      text = `Sent ${noun}; it bounced`
      tone = 'warn'
      break
    case 'refused':
      text = `Refused ${noun}: ${t.refusalCode ? refusalWords(t.refusalCode) : 'no reason recorded'}; nothing was sent`
      tone = 'warn'
      break
    case 'failed':
      text = `Tried to send ${noun}; it failed, and nothing is known to have arrived`
      tone = 'warn'
      break
    case 'awaiting_approval':
      text = `Drafted ${noun}; it waits for a person to approve it`
      tone = 'muted'
      break
    case 'approved':
      text = `Approved ${noun}; it has not been sent yet`
      tone = 'muted'
      break
    case 'queued':
      text =
        t.scheduledFor && t.scheduledFor.getTime() > input.now.getTime()
          ? `Queued ${noun}, held until ${isoDay(t.scheduledFor)}; it has not been sent yet`
          : `Queued ${noun}; it has not been sent yet`
      tone = 'muted'
      break
    case 'sending':
      text = `Began sending ${noun}; the send has not been confirmed`
      tone = 'muted'
      break
    default:
      text = `${capital(noun)} — ${spaced(t.status)}`
  }
  const approver = person(input, t.approvedBy)
  return {
    kind: 'touch',
    id: t.id,
    at: t.sentAt ?? t.createdAt,
    label: own(CHANNEL_NAME, t.channel) ?? spaced(t.channel),
    text,
    facts: subject,
    by: approver ? `approved by ${approver}` : null,
    href: null,
    tone,
    stale: false,
  }
}

const MEETING_SOURCE: Readonly<Record<string, string>> = {
  manual: 'recorded by a person',
  agent: 'recorded by the agent',
  booking_page: 'booked on the public booking page',
}

/**
 * A meeting sits at the time it was FOR once that has passed, and at the time
 * it was booked while it is still ahead — "everything that happened" does not
 * include next Tuesday. Whatever the outcome column says is reported, and a
 * past meeting without one says so rather than implying it was held.
 */
function meetingEvent(m: TimelineMeeting, input: TimelineInputs): TimelineEvent {
  const when = inZone(m.startsAt, m.timeZone)
  const past = m.startsAt.getTime() <= input.now.getTime()
  let text: string
  let tone: TimelineTone = 'plain'
  if (m.cancelledAt) {
    text = `The meeting for ${when} was cancelled`
    tone = 'muted'
  } else if (!past) {
    text = `Booked a meeting for ${when}`
  } else {
    switch (m.outcome) {
      case 'held':
        text = `Held the meeting of ${when}`
        tone = 'good'
        break
      case 'no_show':
        text = `The meeting of ${when} was a no-show`
        tone = 'warn'
        break
      case 'rescheduled':
        text = `The meeting of ${when} was rescheduled`
        tone = 'muted'
        break
      default:
        text = `The meeting of ${when} has no outcome recorded`
    }
  }
  return {
    kind: 'meeting',
    id: m.id,
    at: past ? m.startsAt : m.createdAt,
    label: 'meeting',
    text,
    facts: [
      ...(m.title?.trim() ? [quoted(clip(m.title, 80))] : []),
      own(MEETING_SOURCE, m.source) ?? spaced(m.source),
      ...(m.needsReview ? ['needs review — a person confirms who booked'] : []),
    ],
    by: null,
    href: `/meetings/${m.id}`,
    tone,
    stale: false,
  }
}

function proposalEvent(p: TimelineProposal): TimelineEvent {
  const estimate =
    p.totalLow != null && p.totalHigh != null
      ? `${p.currency} ${p.totalLow.toLocaleString('en-US')}–${p.totalHigh.toLocaleString('en-US')}`
      : 'effort only'
  return {
    kind: 'proposal',
    id: p.id,
    at: p.generatedAt,
    label: 'proposal',
    text: `Generated the proposal ${quoted(clip(p.title, 100))} from a scan`,
    facts: [
      p.decidedAt ? `${spaced(p.status)} on ${isoDay(p.decidedAt)}` : `now ${spaced(p.status)}`,
      estimate,
    ],
    by: null,
    href: `/proposals/${p.id}`,
    tone: p.status === 'accepted' ? 'good' : p.status === 'declined' || p.status === 'withdrawn' ? 'muted' : 'plain',
    stale: false,
  }
}

const CALL_OUTCOME: Readonly<Record<string, string>> = {
  qualified: 'qualified',
  not_qualified: 'not qualified',
  handoff: 'handed to a person',
  opted_out: 'the caller asked to stop',
  incomplete: 'incomplete',
  no_answer: 'no answer',
  failed: 'failed',
}

function callEvent(c: TimelineCall, input: TimelineInputs): TimelineEvent {
  // §2.1: an answered inbound call with no disclosure recorded did not
  // disclose. It is the one fact on a call line nobody may scroll past.
  const undisclosed = c.direction === 'in' && c.answeredAt !== null && c.disclosedAiAt === null
  const outcome = own(CALL_OUTCOME, c.outcome) ?? (c.outcome ? spaced(c.outcome) : spaced(c.status))
  const handoff = person(input, c.handoffToUserId)
  const secs = c.durationS
  return {
    kind: 'call',
    id: c.id,
    at: c.startedAt ?? c.createdAt,
    label: 'call',
    text: `${c.direction === 'in' ? 'A call came in' : 'An outbound call'} — ${outcome}`,
    facts: [
      ...(secs !== null && secs >= 0 ? [`${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`] : []),
      ...(undisclosed ? ['NO AI DISCLOSURE RECORDED'] : []),
      ...(c.optedOutAt ? ['opted out'] : []),
      ...(handoff ? [`handed to ${handoff}`] : []),
    ],
    by: null,
    href: `/calls/${c.id}`,
    tone: undisclosed || c.optedOutAt ? 'warn' : 'plain',
    stale: false,
  }
}

/**
 * A note is a teammate's words: labelled with whose, quoted, and never
 * framed as an observation. Nothing here reads it as evidence and nothing
 * that writes a proposal or a brief reads this module.
 */
function noteEvent(n: TimelineNote): TimelineEvent {
  return {
    kind: 'note',
    id: n.id,
    at: n.createdAt,
    label: `note by ${n.author}`,
    text: quoted(clip(n.body, 200)),
    facts: [
      ...(n.contactName ? [`about ${n.contactName}`] : []),
      ...(n.pinned ? ['pinned'] : []),
    ],
    by: null,
    href: null,
    tone: 'plain',
    stale: false,
  }
}

// ---------------------------------------------------------------------------
// Deal moves
// ---------------------------------------------------------------------------

const DEAL_STAGES: readonly DealStage[] = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost']

function isStage(v: unknown): v is DealStage {
  return typeof v === 'string' && (DEAL_STAGES as readonly string[]).includes(v)
}

function field(detail: unknown, key: string): unknown {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return undefined
  return Object.prototype.hasOwnProperty.call(detail, key) ? (detail as Record<string, unknown>)[key] : undefined
}

/** What caused a move recorded inside another row. */
export type DealMoveCause = 'reply' | 'meeting' | 'proposal_accepted'

const CAUSE_WORDS: Readonly<Record<DealMoveCause, string>> = {
  reply: 'after a reply',
  meeting: 'after a meeting was booked',
  proposal_accepted: 'the proposal was accepted',
}

export interface DealMove {
  readonly row: TimelineAuditRow
  readonly at: Date
  /** The stage it left; null for a new deal, or when the row does not say. */
  readonly from: DealStage | null
  readonly to: DealStage
  /**
   * Whether this row is a first-class record of the move — `advanceDeal`'s
   * own row or the board's, each of which says the stage the deal left. A
   * row that does not is a COMPANION: an embedded label, or the POST route's
   * `{ stage }` row beside advanceDeal's.
   */
  readonly firstClass: boolean
  readonly cause: DealMoveCause | null
}

/**
 * The move a row records IN ITS DETAIL on behalf of something else, or null.
 *
 *   `contact.replied` / `meeting.booked` — `deal: '<outcome>:<stage>'`, where
 *     outcome is `created`, `advanced` or `unchanged`. Unchanged is not a
 *     move and answers null; so does `'not moved'` and anything unreadable.
 *   `proposal.accepted` / `proposal.accepted_via_share` — acceptance closes
 *     the deal as won through `setDealStage`, which writes no row of its own,
 *     so this is the only record of that move.
 *
 * Everything else answers null: `send.sent` and `proposal.generated` say
 * nothing about the deal, and a move nobody wrote down is not invented.
 */
export function extractEmbeddedDealMove(row: TimelineAuditRow): DealMove | null {
  switch (row.action) {
    case 'contact.replied':
    case 'meeting.booked': {
      const label = field(row.detail, 'deal')
      if (typeof label !== 'string') return null
      const [outcome, stage] = label.split(':')
      if ((outcome !== 'created' && outcome !== 'advanced') || !isStage(stage)) return null
      return {
        row,
        at: row.createdAt,
        from: null,
        to: stage,
        firstClass: false,
        cause: row.action === 'contact.replied' ? 'reply' : 'meeting',
      }
    }
    case 'proposal.accepted':
    case 'proposal.accepted_via_share':
      return { row, at: row.createdAt, from: null, to: 'won', firstClass: false, cause: 'proposal_accepted' }
    default:
      return null
  }
}

/**
 * The move a `deal` row records, or null. `deal.updated`, `deal.unchanged`
 * and `deal.next_action_set` are not moves; a row whose stages are not
 * stages is skipped rather than guessed at.
 */
export function readDealRowMove(row: TimelineAuditRow): DealMove | null {
  if (row.subjectType !== 'deal') return null
  const from = field(row.detail, 'from')
  const to = field(row.detail, 'to')
  switch (row.action) {
    case 'deal.moved':
      return isStage(from) && isStage(to)
        ? { row, at: row.createdAt, from, to, firstClass: true, cause: null }
        : null
    case 'deal.created':
    case 'deal.advanced': {
      if (isStage(to)) {
        return { row, at: row.createdAt, from: isStage(from) ? from : null, to, firstClass: true, cause: null }
      }
      const stage = field(row.detail, 'stage')
      return isStage(stage) ? { row, at: row.createdAt, from: null, to: stage, firstClass: false, cause: null } : null
    }
    default:
      return null
  }
}

/** How close two records of ONE move are: the same request writes both, milliseconds apart. */
export const SAME_MOVE_WINDOW_MS = 60_000

/**
 * Every move the rows record, each once, oldest first.
 *
 * A companion (embedded label, POST's `{ stage }` row) is folded into a
 * record of the same destination within `SAME_MOVE_WINDOW_MS`: the
 * first-class row survives, since it says the stage the deal left, and
 * inherits the companion's cause. Two first-class rows are never folded —
 * the board moving a deal to `meeting`, away and back inside a minute is
 * three moves, and each has its own row because somebody made it.
 */
export function dealMovesFrom(rows: readonly TimelineAuditRow[]): DealMove[] {
  const moves = rows
    .map((r) => readDealRowMove(r) ?? extractEmbeddedDealMove(r))
    .filter((m): m is DealMove => m !== null)
    // Oldest first, first-class before companion at one instant, then id —
    // so which row survives never depends on the order the rows arrived in.
    .sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        Number(b.firstClass) - Number(a.firstClass) ||
        byCode(a.row.id, b.row.id),
    )

  const kept: DealMove[] = []
  for (const m of moves) {
    const i = kept.findIndex(
      (k) =>
        k.to === m.to &&
        !(k.firstClass && m.firstClass) &&
        Math.abs(k.at.getTime() - m.at.getTime()) <= SAME_MOVE_WINDOW_MS,
    )
    const twin = i >= 0 ? kept[i] : undefined
    if (!twin) {
      kept.push(m)
      continue
    }
    const survivor = m.firstClass && !twin.firstClass ? m : twin
    const other = survivor === m ? twin : m
    kept[i] = { ...survivor, cause: survivor.cause ?? other.cause }
  }
  return kept
}

function dealEvent(m: DealMove, input: TimelineInputs): TimelineEvent {
  const sentence = sentenceFor(m.row, {
    company: input.company,
    person: (id) => person(input, id),
  })
  return {
    kind: 'deal_move',
    id: m.row.id,
    at: m.at,
    label: 'deal',
    text: capital(sentence),
    facts: [
      m.from ? `${m.from} → ${m.to}` : `→ ${m.to}`,
      // A companion's cause, inherited by the first-class row it repeated.
      // When the embedded row IS the record, its own sentence names the cause.
      ...(m.cause && m.firstClass ? [CAUSE_WORDS[m.cause]] : []),
    ],
    by: `by ${actorLabel(m.row.actor, input.actors ?? new Map()).label}`,
    href: null,
    tone: m.to === 'won' ? 'good' : 'plain',
    stale: false,
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Code-unit order, so the result does not depend on the runtime's locale. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Newest first; at one instant, by kind and then by id — deterministic. */
export function compareTimeline(a: TimelineEvent, b: TimelineEvent): number {
  return b.at.getTime() - a.at.getTime() || byCode(a.kind, b.kind) || byCode(a.id, b.id)
}

/**
 * Everything that happened to a company, newest first, as one list.
 *
 * Each source is turned into events by its own reader above; deal moves are
 * read from the audit rows and folded (`dealMovesFrom`). An event with an
 * unusable time is dropped rather than sorted to one end, where it would
 * claim to be the newest or the oldest thing that happened. With `since`,
 * nothing older is returned (`completeSince`).
 */
export function mergeTimeline(input: TimelineInputs): TimelineEvent[] {
  const scans = input.scans ?? []
  const newestOk = newestOkScanId(scans)
  const events: TimelineEvent[] = [
    ...scans.map((s) => scanEvent(s, input, newestOk)),
    ...(input.touches ?? []).map((t) => touchEvent(t, input)),
    ...dealMovesFrom(input.audit ?? []).map((m) => dealEvent(m, input)),
    ...(input.meetings ?? []).map((m) => meetingEvent(m, input)),
    ...(input.proposals ?? []).map(proposalEvent),
    ...(input.calls ?? []).map((c) => callEvent(c, input)),
    ...(input.notes ?? []).map(noteEvent),
  ]
  const since = input.since?.getTime()
  return events
    .filter((e) => Number.isFinite(e.at.getTime()) && (since === undefined || e.at.getTime() >= since))
    .sort(compareTimeline)
}

/**
 * The instant from which a merged history is complete, or null when it is
 * complete all the way back.
 *
 * Every source is read newest first up to a limit. Merged, a source that hit
 * its limit stops at its oldest row while the others carry on — and the
 * stretch below that row looks like a quiet period rather than a cut. So the
 * history is only whole from the LATEST of the truncated sources' oldest
 * rows, and the page shows nothing older than that and says where the rest is.
 */
export function completeSince(
  sources: readonly { readonly truncated: boolean; readonly oldest: Date | null }[],
): Date | null {
  let since: Date | null = null
  for (const s of sources) {
    if (!s.truncated || !s.oldest || !Number.isFinite(s.oldest.getTime())) continue
    if (!since || s.oldest.getTime() > since.getTime()) since = s.oldest
  }
  return since
}

// ---------------------------------------------------------------------------
// The diff's words
// ---------------------------------------------------------------------------

export interface ChangeWords {
  readonly label: string
  readonly explain: string
  /** A `globals.css` class, or ''. */
  readonly className: string
}

/**
 * What each change is called. The labels are `diffFindings`' state machine
 * read aloud, and the one that matters is `not_assessed_this_time`: a newer
 * scan that could not see a signal says nothing about it, and the words say
 * that instead of anything a reader could take for a fix.
 */
export const CHANGE_WORDS: Readonly<Record<SignalChange, ChangeWords>> = {
  fixed: {
    label: 'fixed',
    explain: 'a gap on the older scan, observed in place on the newer one',
    className: 'diff-fixed',
  },
  regressed: {
    label: 'regressed',
    explain: 'in place on the older scan, observed as a gap on the newer one',
    className: 'diff-regressed',
  },
  not_assessed_this_time: {
    label: 'not assessed this time',
    explain: 'the newer scan could not observe it, so nothing is claimed about it — this is not a fix',
    className: 'diff-not-assessed',
  },
  now_observed: {
    label: 'observed this time',
    explain: 'the older scan could not observe it, so there is nothing to compare against',
    className: '',
  },
  new_signal: {
    label: 'new signal',
    explain: 'the older scan did not record this signal at all',
    className: '',
  },
  unchanged: {
    label: 'unchanged',
    explain: 'observed the same way on both scans',
    className: '',
  },
}

/** One side of a diff row: what that scan recorded, in words. */
export function readingWords(d: DiffInput | null): string {
  if (!d) return 'not recorded'
  if (!d.observed || d.gap === null) return 'not observed'
  return d.gap ? 'gap' : 'in place'
}

/**
 * How many scans between the two compared ones never reached the site —
 * `latestTwoOkScans` skips them, and the panel says so rather than letting
 * two scans a month apart read as consecutive.
 */
export function unreachableBetween(scans: readonly TimelineScan[], older: Date, newer: Date): number {
  return scans.filter(
    (r) => !r.scan.ok && r.scan.ranAt.getTime() > older.getTime() && r.scan.ranAt.getTime() < newer.getTime(),
  ).length
}

