/**
 * Why a deal needs a look (2026-10-09): the reasons, their order and the
 * level, from facts with dates on them.
 */
import { describe, expect, it } from 'vitest'
import { dealHealth, type DealHealthFacts } from '../src/deal-health.js'

const NOW = new Date('2026-10-09T12:00:00.000Z')
const DAY = 86_400_000
const base: DealHealthFacts = {
  stage: 'contacted', closed: false, untouched: { days: 2, rotten: false }, nextActionAt: null, nextAction: 'Call Ravi',
  unhandledReplies: 0, awaitingDrafts: 0, lastSentAt: new Date(NOW.getTime() - 3 * DAY), sentQuote: null, nextMeetingAt: null,
}

describe('dealHealth', () => {
  it('is ok for a deal that is moving', () => {
    expect(dealHealth(base, NOW)).toEqual({ level: 'ok', reasons: [] })
    expect(dealHealth({ ...base, closed: true, unhandledReplies: 3 }, NOW)).toEqual({ level: 'ok', reasons: [] })
  })

  it('acts on a reply, an overdue action, a lapsing quote and a waiting draft, in that order', () => {
    const r = dealHealth(
      {
        ...base, unhandledReplies: 2, nextActionAt: new Date(NOW.getTime() - 3 * DAY), awaitingDrafts: 1,
        sentQuote: { sentAt: new Date(NOW.getTime() - 5 * DAY), validUntil: '2026-10-10' },
      },
      NOW,
    )
    expect(r.level).toBe('act')
    expect(r.reasons).toEqual([
      '2 replies are waiting unanswered', 'next action overdue by 3 days', 'quote lapses in 1 day, unanswered', 'a draft is waiting for approval',
    ])
    expect(dealHealth({ ...base, nextActionAt: new Date(NOW.getTime() - 3600_000) }, NOW).reasons).toEqual(['next action due today'])
    expect(dealHealth({ ...base, sentQuote: { sentAt: null, validUntil: '2026-10-01' } }, NOW).reasons).toEqual(['quote lapsed 8 days ago, unanswered'])
  })

  it('watches drift: untouched past the threshold, no next action, nothing sent yet, a quote sent days ago', () => {
    expect(dealHealth({ ...base, untouched: { days: 12, rotten: true } }, NOW)).toEqual({ level: 'watch', reasons: ['untouched for 12 days'] })
    expect(dealHealth({ ...base, nextAction: null }, NOW).reasons).toEqual(['no next action set'])
    expect(dealHealth({ ...base, stage: 'new', lastSentAt: null }, NOW).reasons).toEqual(['nothing sent to them yet'])
    expect(dealHealth({ ...base, stage: 'proposal', lastSentAt: null }, NOW).reasons).toEqual([])
    expect(dealHealth({ ...base, sentQuote: { sentAt: new Date(NOW.getTime() - 4 * DAY), validUntil: '2026-10-30' } }, NOW)).toEqual({
      level: 'watch', reasons: ['quote sent 4 days ago, unanswered'],
    })
  })

  it('a meeting on the books answers the drift, but not something waiting on a person', () => {
    const meeting = new Date(NOW.getTime() + 2 * DAY)
    expect(dealHealth({ ...base, untouched: { days: 20, rotten: true }, nextAction: null, nextMeetingAt: meeting }, NOW)).toEqual({
      level: 'ok', reasons: ['meeting in 2 days'],
    })
    expect(dealHealth({ ...base, unhandledReplies: 1, nextMeetingAt: new Date(NOW.getTime() + 3600_000) }, NOW)).toEqual({
      level: 'act', reasons: ['a reply is waiting unanswered', 'meeting today'],
    })
  })
})
