/**
 * The company page's evidence panels, without a database (PROMPT.md §2.2).
 *
 * What is pinned here, each a way the obvious version goes wrong:
 *
 *   * the timeline is newest first, and events at one instant come out in
 *     the same order every time — by kind, then by id;
 *   * a deal move recorded only INSIDE another row (`contact.replied`'s
 *     `deal: 'advanced:replied'`) is read, and the same move recorded twice
 *     since `advanceDeal` audits itself is shown once;
 *   * a scan that never reached the site is "unreachable", never a number;
 *   * a note is labelled with whose words it is and is never framed as an
 *     observation;
 *   * staleness comes from when the scan RAN, and only the scan the page's
 *     evidence comes from can be stale;
 *   * "not assessed this time" is never worded as a fix.
 */
import { describe, expect, it } from 'vitest'
import { diffFindings, type DiffInput } from '@agency/core'
import {
  CHANGE_WORDS, SAME_MOVE_WINDOW_MS, compareTimeline, completeSince, dealMovesFrom, extractEmbeddedDealMove,
  mergeTimeline, newestOkScanId, readDealRowMove, readingWords, scanScoreWords, unreachableBetween,
  type TimelineAuditRow, type TimelineEvent, type TimelineInputs, type TimelineNote, type TimelineScan,
  type TimelineTouch,
} from '../src/lib/timeline'

const COMPANY = { domain: 'rentman.io', name: 'Rentman' }
const NOW = new Date('2026-09-30T12:00:00.000Z')
const PROFILE = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const PRIYA = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
const DEAL = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

const base: TimelineInputs = { company: COMPANY, now: NOW, staleAfterDays: 14 }

const at = (iso: string): Date => new Date(iso)
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000)

function okScan(id: string, ranAt: Date, score = 77, tier: string | null = 'A'): TimelineScan {
  return {
    scan: { id, ranAt, ok: true, error: null },
    score: {
      score, tier, qualified: true, disqualifiedReason: null, icpProfileId: PROFILE, computedAt: ranAt,
    },
  }
}

function failedScan(id: string, ranAt: Date): TimelineScan {
  return { scan: { id, ranAt, ok: false, error: 'timeout after 15s' }, score: null }
}

function audit(over: Partial<TimelineAuditRow> & Pick<TimelineAuditRow, 'id' | 'action'>): TimelineAuditRow {
  return {
    actor: 'system',
    subjectType: null,
    subjectId: null,
    detail: {},
    createdAt: at('2026-09-20T10:00:00.000Z'),
    ...over,
  }
}

function touch(over: Partial<TimelineTouch> & Pick<TimelineTouch, 'id'>): TimelineTouch {
  return {
    channel: 'email',
    direction: 'out',
    status: 'sent',
    subject: 'Your security page',
    refusalCode: null,
    replyKind: null,
    approvedBy: null,
    scheduledFor: null,
    sentAt: null,
    createdAt: at('2026-09-20T10:00:00.000Z'),
    ...over,
  }
}

function note(over: Partial<TimelineNote> = {}): TimelineNote {
  return {
    id: 'note-1',
    body: 'Spoke to their CTO; they are moving hosting next quarter.',
    author: 'Priya',
    contactName: null,
    pinned: false,
    createdAt: at('2026-09-21T09:00:00.000Z'),
    ...over,
  }
}

const bare = (e: TimelineEvent) => ({ kind: e.kind, id: e.id })

describe('the order', () => {
  it('is newest first across every source', () => {
    const events = mergeTimeline({
      ...base,
      scans: [okScan('scan-1', at('2026-09-18T08:00:00.000Z'))],
      touches: [touch({ id: 'touch-1', sentAt: at('2026-09-22T08:00:00.000Z') })],
      notes: [note({ createdAt: at('2026-09-20T08:00:00.000Z') })],
    })
    expect(events.map(bare)).toEqual([
      { kind: 'touch', id: 'touch-1' },
      { kind: 'note', id: 'note-1' },
      { kind: 'scan', id: 'scan-1' },
    ])
  })

  it('breaks a tie at one instant by kind and then by id, whatever order the rows arrived in', () => {
    const same = at('2026-09-20T10:00:00.000Z')
    const inputs: TimelineInputs = {
      ...base,
      scans: [okScan('scan-b', same), okScan('scan-a', same)],
      touches: [touch({ id: 'touch-z', sentAt: same }), touch({ id: 'touch-a', sentAt: same })],
      notes: [note({ id: 'note-m', createdAt: same })],
    }
    const expected = [
      { kind: 'note', id: 'note-m' },
      { kind: 'scan', id: 'scan-a' },
      { kind: 'scan', id: 'scan-b' },
      { kind: 'touch', id: 'touch-a' },
      { kind: 'touch', id: 'touch-z' },
    ]
    expect(mergeTimeline(inputs).map(bare)).toEqual(expected)
    const reversed: TimelineInputs = {
      ...inputs,
      scans: [...(inputs.scans ?? [])].reverse(),
      touches: [...(inputs.touches ?? [])].reverse(),
    }
    expect(mergeTimeline(reversed).map(bare)).toEqual(expected)
  })

  it('compares by code unit, not by locale', () => {
    const e = (id: string): TimelineEvent => ({
      kind: 'note', id, at: NOW, label: '', text: '', facts: [], by: null, href: null, tone: 'plain', stale: false,
    })
    expect([e('b'), e('B'), e('a')].sort(compareTimeline).map((x) => x.id)).toEqual(['B', 'a', 'b'])
  })

  it('drops an event with no usable time rather than sorting it to one end', () => {
    const events = mergeTimeline({ ...base, notes: [note({ createdAt: new Date('not a date') }), note({ id: 'ok' })] })
    expect(events.map((e) => e.id)).toEqual(['ok'])
  })

  it('returns nothing older than `since`', () => {
    const events = mergeTimeline({
      ...base,
      since: at('2026-09-20T00:00:00.000Z'),
      scans: [okScan('old', at('2026-09-10T00:00:00.000Z')), okScan('new', at('2026-09-25T00:00:00.000Z'))],
    })
    expect(events.map((e) => e.id)).toEqual(['new'])
  })
})

describe('completeSince — where a merged history stops being whole', () => {
  it('is null when nothing was cut', () => {
    expect(completeSince([{ truncated: false, oldest: daysAgo(90) }, { truncated: false, oldest: null }])).toBeNull()
  })

  it('is the LATEST oldest row among the sources that hit their limit', () => {
    expect(
      completeSince([
        { truncated: true, oldest: daysAgo(40) },
        { truncated: true, oldest: daysAgo(10) },
        { truncated: false, oldest: daysAgo(2) },
      ]),
    ).toEqual(daysAgo(10))
  })
})

describe('deal moves', () => {
  it('extracts an embedded move from contact.replied.detail.deal', () => {
    const row = audit({
      id: 'a-reply',
      action: 'contact.replied',
      subjectType: 'contact',
      detail: { channel: 'email', paused: true, cancelledQueued: 0, suppressed: false, deal: 'advanced:replied' },
    })
    const move = extractEmbeddedDealMove(row)
    expect(move).toMatchObject({ to: 'replied', from: null, firstClass: false, cause: 'reply' })
  })

  it('extracts one from meeting.booked, and the won that accepting a proposal closes', () => {
    expect(
      extractEmbeddedDealMove(audit({ id: 'm', action: 'meeting.booked', detail: { deal: 'created:meeting' } })),
    ).toMatchObject({ to: 'meeting', cause: 'meeting' })
    expect(extractEmbeddedDealMove(audit({ id: 'p', action: 'proposal.accepted' }))).toMatchObject({
      to: 'won',
      cause: 'proposal_accepted',
    })
    expect(extractEmbeddedDealMove(audit({ id: 's', action: 'proposal.accepted_via_share' }))).toMatchObject({
      to: 'won',
    })
  })

  it('reads no move where none was made or none was written down', () => {
    for (const deal of ['unchanged:meeting', 'not moved', 'advanced:nowhere', 'advanced', '', null]) {
      expect(extractEmbeddedDealMove(audit({ id: 'x', action: 'contact.replied', detail: { deal } }))).toBeNull()
    }
    // A send and a generated proposal move the deal through advanceDeal, but
    // their rows do not say so; nothing is invented for them.
    expect(extractEmbeddedDealMove(audit({ id: 'y', action: 'send.sent', detail: { deal: 'advanced:contacted' } }))).toBeNull()
    expect(extractEmbeddedDealMove(audit({ id: 'z', action: 'proposal.generated' }))).toBeNull()
    expect(extractEmbeddedDealMove(audit({ id: 'w', action: 'meeting.booked', detail: ['advanced:meeting'] }))).toBeNull()
  })

  it('reads the deal rows that are moves, and none that are not', () => {
    const row = (action: string, detail: unknown) =>
      readDealRowMove(audit({ id: action, action, subjectType: 'deal', subjectId: DEAL, detail }))
    expect(row('deal.moved', { companyId: 'c', from: 'replied', to: 'meeting' })).toMatchObject({
      from: 'replied', to: 'meeting', firstClass: true,
    })
    expect(row('deal.advanced', { companyId: 'c', from: 'contacted', to: 'replied' })).toMatchObject({
      from: 'contacted', to: 'replied', firstClass: true,
    })
    expect(row('deal.created', { companyId: 'c', from: null, to: 'contacted' })).toMatchObject({
      from: null, to: 'contacted', firstClass: true,
    })
    // POST /api/deals' companion row: it repeats advanceDeal's move.
    expect(row('deal.created', { companyId: 'c', stage: 'contacted' })).toMatchObject({ to: 'contacted', firstClass: false })
    expect(row('deal.updated', { from: 'meeting', to: 'meeting', nextAction: 'x' })).toBeNull()
    expect(row('deal.unchanged', { stage: 'meeting' })).toBeNull()
    expect(row('deal.moved', { from: 'replied', to: 'somewhere' })).toBeNull()
    expect(readDealRowMove(audit({ id: 'n', action: 'deal.moved', detail: { from: 'new', to: 'contacted' } }))).toBeNull()
  })

  it("shows one move once when advanceDeal's own row and the reply's label both recorded it", () => {
    const moved = audit({
      id: 'b-advance',
      action: 'deal.advanced',
      subjectType: 'deal',
      subjectId: DEAL,
      detail: { companyId: 'c', from: 'contacted', to: 'replied' },
      createdAt: at('2026-09-20T10:00:00.000Z'),
    })
    const reply = audit({
      id: 'a-reply',
      action: 'contact.replied',
      subjectType: 'contact',
      detail: { deal: 'advanced:replied' },
      createdAt: at('2026-09-20T10:00:00.040Z'),
    })
    for (const rows of [[moved, reply], [reply, moved]]) {
      const moves = dealMovesFrom(rows)
      expect(moves).toHaveLength(1)
      // The first-class row survives — it says the stage the deal LEFT — and
      // keeps what caused it.
      expect(moves[0]).toMatchObject({ from: 'contacted', to: 'replied', firstClass: true, cause: 'reply' })
      expect(moves[0]?.row.id).toBe('b-advance')
    }

    const events = mergeTimeline({ ...base, audit: [moved, reply] }).filter((e) => e.kind === 'deal_move')
    expect(events).toHaveLength(1)
    expect(events[0]?.facts).toEqual(['contacted → replied', 'after a reply'])
  })

  it('still shows a move recorded ONLY inside the reply — every row before advanceDeal audited itself', () => {
    const reply = audit({ id: 'a-reply', action: 'contact.replied', subjectType: 'contact', detail: { deal: 'created:replied' } })
    const [event] = mergeTimeline({ ...base, audit: [reply] })
    expect(event).toMatchObject({ kind: 'deal_move', id: 'a-reply', label: 'deal' })
    // The reply's own sentence says what caused it; the fact is the move.
    expect(event?.text).toBe('Recorded a reply from a contact at rentman.io: opened a deal at replied')
    expect(event?.facts).toEqual(['→ replied'])
  })

  it('folds the two rows one acceptance writes into one won', () => {
    const accepted = audit({ id: 'p1', action: 'proposal.accepted', subjectType: 'proposal', detail: { companyId: 'c' } })
    const via = audit({ id: 'p2', action: 'proposal.accepted_via_share', subjectType: 'proposal', detail: { companyId: 'c' } })
    expect(dealMovesFrom([accepted, via])).toHaveLength(1)
  })

  it("folds POST /api/deals' { stage } row into advanceDeal's { from, to } row", () => {
    const own = audit({ id: 'own', action: 'deal.advanced', subjectType: 'deal', detail: { from: 'new', to: 'contacted' } })
    const post = audit({ id: 'post', action: 'deal.advanced', subjectType: 'deal', detail: { stage: 'contacted' } })
    expect(dealMovesFrom([post, own]).map((m) => m.row.id)).toEqual(['own'])
  })

  it('never folds two first-class rows: each is a move somebody made', () => {
    const t = (ms: number) => new Date(at('2026-09-20T10:00:00.000Z').getTime() + ms)
    const rows = [
      audit({ id: 'm1', action: 'deal.moved', subjectType: 'deal', detail: { from: 'replied', to: 'meeting' }, createdAt: t(0) }),
      audit({ id: 'm2', action: 'deal.moved', subjectType: 'deal', detail: { from: 'meeting', to: 'replied' }, createdAt: t(5_000) }),
      audit({ id: 'm3', action: 'deal.moved', subjectType: 'deal', detail: { from: 'replied', to: 'meeting' }, createdAt: t(9_000) }),
    ]
    expect(dealMovesFrom(rows).map((m) => m.row.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('does not fold a companion into a move to the same stage outside the window', () => {
    const own = audit({ id: 'own', action: 'deal.advanced', subjectType: 'deal', detail: { from: 'contacted', to: 'replied' } })
    const later = audit({
      id: 'later',
      action: 'contact.replied',
      detail: { deal: 'created:replied' },
      createdAt: new Date(own.createdAt.getTime() + SAME_MOVE_WINDOW_MS + 1),
    })
    expect(dealMovesFrom([own, later])).toHaveLength(2)
  })

  it("says the move in audit-copy's sentence, and names who did it", () => {
    const row = audit({
      id: 'board',
      action: 'deal.moved',
      actor: PRIYA,
      subjectType: 'deal',
      subjectId: DEAL,
      detail: { companyId: 'c', from: 'meeting', to: 'lost', lostReason: 'Went with an incumbent' },
    })
    const actors = new Map([[PRIYA, { email: 'priya@agency.test', name: 'Priya', revoked: false }]])
    const [event] = mergeTimeline({ ...base, audit: [row], actors })
    expect(event?.text).toBe('Moved rentman.io from meeting to lost: “Went with an incumbent”')
    expect(event?.by).toBe('by Priya')
  })

  it('ignores audit rows that are not moves', () => {
    const rows = [
      audit({ id: 'n', action: 'note.added', subjectType: 'note' }),
      audit({ id: 'u', action: 'deal.updated', subjectType: 'deal', detail: { from: 'meeting', to: 'meeting' } }),
    ]
    expect(mergeTimeline({ ...base, audit: rows })).toEqual([])
  })
})

describe('scans', () => {
  it('a failed scan renders "unreachable", never a score', () => {
    expect(scanScoreWords(failedScan('s', daysAgo(1)))).toEqual({ text: 'unreachable', unreachable: true })
    // Even handed the 0 that recordScan writes for it: there is no path to a number.
    const withRow: TimelineScan = {
      scan: { id: 's', ranAt: daysAgo(1), ok: false, error: 'timeout' },
      score: {
        score: 0, tier: null, qualified: false, disqualifiedReason: 'unreachable (timeout)',
        icpProfileId: PROFILE, computedAt: daysAgo(1),
      },
    }
    expect(scanScoreWords(withRow).text).toBe('unreachable')

    const [event] = mergeTimeline({ ...base, scans: [withRow] })
    expect(event?.text).toContain('unreachable')
    expect(event?.tone).toBe('warn')
    expect(JSON.stringify(event)).not.toMatch(/\b0\/100\b|score 0\b/)
  })

  it('a reached scan says the score computed from IT, and the profile it was scored against', () => {
    expect(scanScoreWords(okScan('s', daysAgo(1), 77, 'A')).text).toBe('77/100 · A')
    expect(scanScoreWords(okScan('s', daysAgo(1), 30, null)).text).toBe('30/100 · below threshold')
    expect(scanScoreWords({ scan: { id: 's', ranAt: daysAgo(1), ok: true, error: null }, score: null }).text).toBe('not scored')

    const [event] = mergeTimeline({
      ...base,
      scans: [okScan('s', daysAgo(1))],
      profiles: new Map([[PROFILE, 'EU SaaS, 20–200']]),
    })
    expect(event?.text).toContain('77/100 · A')
    expect(event?.facts).toContain('scored against EU SaaS, 20–200')
  })

  it('marks only the newest scan that reached the site stale, and derives it from when it ran', () => {
    const scans = [
      failedScan('failed-newest', daysAgo(1)),
      okScan('ok-newest', daysAgo(20)),
      okScan('ok-older', daysAgo(40)),
    ]
    expect(newestOkScanId(scans)).toBe('ok-newest')
    const byId = new Map(mergeTimeline({ ...base, scans }).map((e) => [e.id, e]))
    expect(byId.get('ok-newest')?.stale).toBe(true)
    expect(byId.get('ok-older')?.stale).toBe(false)
    expect(byId.get('failed-newest')?.stale).toBe(false)

    const fresh = mergeTimeline({ ...base, scans: [okScan('recent', daysAgo(3))] })
    expect(fresh[0]?.stale).toBe(false)
  })

  it('counts the scans between two compared ones that never reached the site', () => {
    const scans = [okScan('n', daysAgo(1)), failedScan('f1', daysAgo(5)), failedScan('f2', daysAgo(8)), okScan('o', daysAgo(10))]
    expect(unreachableBetween(scans, daysAgo(10), daysAgo(1))).toBe(2)
    expect(unreachableBetween(scans, daysAgo(6), daysAgo(1))).toBe(1)
  })
})

describe('notes', () => {
  it('carry the author label and are never framed as an observation', () => {
    const [event] = mergeTimeline({ ...base, notes: [note({ contactName: 'Sam Lee', pinned: true })] })
    expect(event?.label).toBe('note by Priya')
    expect(event?.text).toBe('“Spoke to their CTO; they are moving hosting next quarter.”')
    expect(event?.facts).toEqual(['about Sam Lee', 'pinned'])
    expect(JSON.stringify(event)).not.toMatch(/observ/i)
    expect(event?.stale).toBe(false)
  })

  it('a note by somebody no longer on the team still says whose words they were', () => {
    const [event] = mergeTimeline({ ...base, notes: [note({ author: 'a former teammate' })] })
    expect(event?.label).toBe('note by a former teammate')
  })
})

describe('messages, meetings, proposals and calls', () => {
  it('a refused message names the refusal and says nothing was sent', () => {
    const [event] = mergeTimeline({ ...base, touches: [touch({ id: 't', status: 'refused', refusalCode: 'suppressed' })] })
    expect(event?.text).toBe('Refused an email: on the suppression list; nothing was sent')
    expect(event?.tone).toBe('warn')
  })

  it('a message that is not sent yet never reads as sent', () => {
    for (const status of ['queued', 'awaiting_approval', 'approved', 'sending']) {
      const [event] = mergeTimeline({ ...base, touches: [touch({ id: 't', status })] })
      expect(event?.text).not.toMatch(/^Sent/)
    }
  })

  it('a reply says what kind it is, and an opt-out is not rendered like the rest', () => {
    const [event] = mergeTimeline({
      ...base,
      touches: [touch({ id: 'r', direction: 'in', status: 'replied', replyKind: 'opted_out' })],
    })
    expect(event?.label).toBe('reply')
    expect(event?.facts[0]).toBe('asked to stop')
    expect(event?.tone).toBe('warn')
  })

  it('a meeting still ahead sits at its booking; a past one at its time, with its outcome or the lack of one', () => {
    const meeting = {
      id: 'm', title: 'Intro', timeZone: 'Europe/London', source: 'manual', cancelledAt: null,
      outcome: null, needsReview: false, createdAt: daysAgo(5),
    }
    const [ahead] = mergeTimeline({ ...base, meetings: [{ ...meeting, startsAt: new Date(NOW.getTime() + 86_400_000) }] })
    expect(ahead?.at).toEqual(daysAgo(5))
    expect(ahead?.text).toMatch(/^Booked a meeting for/)

    const [past] = mergeTimeline({ ...base, meetings: [{ ...meeting, startsAt: daysAgo(1) }] })
    expect(past?.at).toEqual(daysAgo(1))
    expect(past?.text).toMatch(/has no outcome recorded$/)

    const [held] = mergeTimeline({ ...base, meetings: [{ ...meeting, startsAt: daysAgo(1), outcome: 'held' }] })
    expect(held?.text).toMatch(/^Held the meeting of/)
    expect(held?.href).toBe('/meetings/m')
  })

  it('an answered call with no disclosure recorded is flagged', () => {
    const call = {
      id: 'c', direction: 'in', status: 'completed', outcome: 'qualified', startedAt: daysAgo(1),
      answeredAt: daysAgo(1), durationS: 125, disclosedAiAt: null, optedOutAt: null, handoffToUserId: null,
      createdAt: daysAgo(1),
    }
    const [event] = mergeTimeline({ ...base, calls: [call] })
    expect(event?.facts).toEqual(['2m 5s', 'NO AI DISCLOSURE RECORDED'])
    expect(event?.tone).toBe('warn')
    const [ok] = mergeTimeline({ ...base, calls: [{ ...call, disclosedAiAt: daysAgo(1) }] })
    expect(ok?.facts).toEqual(['2m 5s'])
  })

  it('a proposal links to itself and says where it stands', () => {
    const [event] = mergeTimeline({
      ...base,
      proposals: [{
        id: 'p', title: 'Posture review', status: 'accepted', currency: 'USD', totalLow: 9600, totalHigh: 15600,
        generatedAt: daysAgo(4), decidedAt: at('2026-09-29T09:00:00.000Z'),
      }],
    })
    expect(event?.href).toBe('/proposals/p')
    expect(event?.facts).toEqual(['accepted on 2026-09-29', 'USD 9,600–15,600'])
  })
})

describe("the diff's words", () => {
  const input = (over: Partial<DiffInput>): DiffInput => ({
    signalKey: 'csp', observed: true, gap: true, detail: null, evidence: { header: 'absent' }, weight: 12, ...over,
  })

  it('never words "not assessed this time" as a fix', () => {
    const { rows } = diffFindings([input({})], [input({ observed: false, gap: null, evidence: {} })])
    expect(rows[0]?.change).toBe('not_assessed_this_time')
    const words = CHANGE_WORDS.not_assessed_this_time
    expect(words.label).not.toMatch(/fix/i)
    expect(words.className).not.toBe(CHANGE_WORDS.fixed.className)
    expect(words.explain).toMatch(/not a fix/)
  })

  it('reads each side as a gap, in place, not observed, or not recorded', () => {
    expect(readingWords(input({}))).toBe('gap')
    expect(readingWords(input({ gap: false }))).toBe('in place')
    expect(readingWords(input({ observed: false, gap: null }))).toBe('not observed')
    expect(readingWords(null)).toBe('not recorded')
  })

  it('has words for every change the diff can produce', () => {
    for (const change of ['fixed', 'regressed', 'not_assessed_this_time', 'now_observed', 'new_signal', 'unchanged'] as const) {
      expect(CHANGE_WORDS[change].label).toBeTruthy()
    }
  })
})
