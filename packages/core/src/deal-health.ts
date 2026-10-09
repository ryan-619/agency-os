/**
 * Why a deal needs a look (2026-10-09), in words on its card.
 *
 * The board said "untouched for 12 days" and nothing else; the reasons a
 * deal actually stalls — a reply nobody answered, a quote about to lapse,
 * a draft nobody approved, nothing sent yet — were on four other pages. This
 * reads the facts the database gathers (`dealHealthFacts`) into a short,
 * ordered list of reasons and a level: `act` when something is waiting on a
 * person today, `watch` when it is only drifting, `ok` otherwise. Pure; the
 * dates are judged against `now`, and nothing here is a promise about what
 * will happen — a reason is a fact with a date on it.
 */
export type DealHealthLevel = 'ok' | 'watch' | 'act'

export interface DealHealthFacts {
  readonly stage: string
  readonly closed: boolean
  /** Days since the card last changed, and whether that is past the stage's threshold; null when the stage has none. */
  readonly untouched: { readonly days: number; readonly rotten: boolean } | null
  readonly nextActionAt: Date | null
  readonly nextAction: string | null
  /** Inbound messages from the company nobody has handled. */
  readonly unhandledReplies: number
  /** Outbound drafts to the company waiting on /approvals. */
  readonly awaitingDrafts: number
  /** When our last message to the company went, if any. */
  readonly lastSentAt: Date | null
  /** The company's newest SENT quote, if any, unanswered. */
  readonly sentQuote: { readonly sentAt: Date | null; readonly validUntil: string } | null
  /** The next meeting with the company that has not been cancelled, if any. */
  readonly nextMeetingAt: Date | null
}

export interface DealHealth {
  readonly level: DealHealthLevel
  /** Ordered, most pressing first. Empty when `ok`. */
  readonly reasons: readonly string[]
}

const DAY = 86_400_000
const QUOTE_LAPSING_DAYS = 2
const QUOTE_FOLLOW_UP_DAYS = 3

/** Days from `now` to the end of a YYYY-MM-DD day in UTC; null when unreadable. */
function daysUntil(day: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const end = Date.parse(`${day}T23:59:59Z`)
  return Number.isNaN(end) ? null : Math.floor((end - now.getTime()) / DAY)
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function dealHealth(f: DealHealthFacts, now: Date): DealHealth {
  if (f.closed) return { level: 'ok', reasons: [] }
  const act: string[] = []
  const watch: string[] = []

  if (f.unhandledReplies > 0) act.push(f.unhandledReplies === 1 ? 'a reply is waiting unanswered' : `${f.unhandledReplies} replies are waiting unanswered`)
  if (f.nextActionAt && f.nextActionAt.getTime() <= now.getTime()) {
    const late = Math.floor((now.getTime() - f.nextActionAt.getTime()) / DAY)
    act.push(late >= 1 ? `next action overdue by ${plural(late, 'day')}` : 'next action due today')
  }
  if (f.sentQuote) {
    const left = daysUntil(f.sentQuote.validUntil, now)
    if (left !== null && left < 0) act.push(`quote lapsed ${plural(-left, 'day')} ago, unanswered`)
    else if (left !== null && left <= QUOTE_LAPSING_DAYS) act.push(left === 0 ? 'quote lapses today, unanswered' : `quote lapses in ${plural(left, 'day')}, unanswered`)
    else if (f.sentQuote.sentAt && now.getTime() - f.sentQuote.sentAt.getTime() >= QUOTE_FOLLOW_UP_DAYS * DAY) {
      watch.push(`quote sent ${plural(Math.floor((now.getTime() - f.sentQuote.sentAt.getTime()) / DAY), 'day')} ago, unanswered`)
    }
  }
  if (f.awaitingDrafts > 0) act.push(f.awaitingDrafts === 1 ? 'a draft is waiting for approval' : `${f.awaitingDrafts} drafts are waiting for approval`)

  if (f.untouched?.rotten) watch.push(`untouched for ${plural(f.untouched.days, 'day')}`)
  if (!f.nextMeetingAt && !f.nextAction && !f.nextActionAt && f.stage !== 'won' && f.stage !== 'lost') watch.push('no next action set')
  if (f.lastSentAt === null && f.awaitingDrafts === 0 && (f.stage === 'new' || f.stage === 'qualified' || f.stage === 'contacted')) {
    watch.push('nothing sent to them yet')
  }

  if (f.nextMeetingAt && f.nextMeetingAt.getTime() > now.getTime()) {
    // A meeting on the books answers most of the drift; it is said so the card does not nag past it.
    const inDays = Math.floor((f.nextMeetingAt.getTime() - now.getTime()) / DAY)
    const line = inDays === 0 ? 'meeting today' : `meeting in ${plural(inDays, 'day')}`
    if (act.length === 0) return { level: 'ok', reasons: [line] }
    return { level: 'act', reasons: [...act, line] }
  }
  if (act.length > 0) return { level: 'act', reasons: [...act, ...watch] }
  if (watch.length > 0) return { level: 'watch', reasons: watch }
  return { level: 'ok', reasons: [] }
}
