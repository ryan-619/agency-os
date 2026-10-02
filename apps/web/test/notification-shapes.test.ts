/**
 * What the four route hooks hand to Slack — built by the routes' own
 * builders, from fixtures shaped like the rows the routes hold.
 *
 * `slack-message.test.ts` proves the message builder drops what it is not
 * given. This file proves the step before it: that a route, holding a row
 * full of a prospect's words, gives the builder only ids, a domain and a
 * kind. Every fixture below carries decoys in the places a real row carries
 * lead data — the lost reason, the proposal's document, the fields a
 * booking request came with — and none of them may reach the wire.
 *
 * The routes themselves cannot be imported here (they reach `server-only`
 * through `@/lib/db`), which is why each one builds its event through a
 * pure module beside it. The last block reads the routes' source to pin
 * that they do — and that each hook sits after the write, inside a
 * try/catch, where a failure cannot change the answer.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BookingOutcome, DealRow, InboundOutcome, ProposalRow } from '@agency/db/queries'
import { slackMessage, type NotificationEvent } from '../src/lib/slack-message'
import { optOutNotRecordedNotification, replyNotification } from '../src/app/api/inbound/email/notification'
import { bookingNotification } from '../src/app/api/book/[slug]/notification'
import { closedStage, dealClosedNotification } from '../src/app/api/deals/[id]/notification'
import { proposalAcceptedNotification } from '../src/app/api/proposals/[id]/notification'

const ORIGIN = 'https://x.test'
const ORG = '00000000-0000-4000-8000-00000000000a'
const COMPANY = '00000000-0000-4000-8000-00000000000c'

/** Lead data, as the rows a route holds would carry it. */
const DECOYS = {
  email: 'DECOY-EMAIL jane.doe@acme.example',
  name: 'DECOY-NAME Jane Doe',
  notes: 'DECOY-NOTES budget approved, call her mobile',
} as const

/** The wire form of what a route would post. */
const wire = (event: NotificationEvent): string => JSON.stringify(slackMessage(event, ORIGIN))

function expectNoLeadData(event: NotificationEvent): void {
  const posted = wire(event)
  for (const decoy of Object.values(DECOYS)) expect(posted).not.toContain(decoy)
  expect(posted).not.toContain('DECOY')
  expect(posted).not.toContain('jane')
}

/** What the deal and proposal routes' one select reads: the domain, and only it. */
const DOMAIN = 'acme.example'

describe('the reply hook (POST /api/inbound/email)', () => {
  const recorded: InboundOutcome & typeof DECOYS = {
    matched: 'message',
    contactId: '00000000-0000-4000-8000-000000000001',
    orgId: ORG,
    touchId: '00000000-0000-4000-8000-000000000002',
    paused: true,
    suppressed: false,
    replyKind: 'interested',
    duplicate: false,
    companyId: COMPANY,
    companyDomain: 'acme.example',
    optOutNotRecorded: false,
    ...DECOYS,
  }

  it('names ids, the domain and the flags — and nothing else', () => {
    const event: NotificationEvent | null = replyNotification(recorded)
    expect(event).toEqual({
      kind: 'reply',
      orgId: ORG,
      contactId: recorded.contactId,
      touchId: recorded.touchId,
      companyDomain: 'acme.example',
      replyKind: 'interested',
      paused: true,
      suppressed: false,
    })
    expectNoLeadData(event!)
  })

  it('announces a retried delivery NOTHING — one reply is one message, however often the provider sends it', () => {
    expect(replyNotification({ ...recorded, duplicate: true })).toBeNull()
  })

  it('announces nothing when nothing was recorded', () => {
    expect(replyNotification({ matched: 'none', why: 'no contact has this address' })).toBeNull()
  })

  it('carries the suppression through, so the channel is told not to answer', () => {
    const event = replyNotification({ ...recorded, replyKind: 'opted_out', suppressed: true })
    expect(event?.suppressed).toBe(true)
    expect(slackMessage(event!, ORIGIN).text).toContain('do not answer')
  })

  /**
   * Found by review: a "stop" whose suppression could not be written was
   * announced as an ordinary reply — "asked to stop … paused" — which reads
   * as handled. It raises the alarm instead, and ONLY the alarm.
   */
  describe('a reply that said stop and could not be suppressed', () => {
    const notRecorded = { ...recorded, replyKind: 'opted_out' as const, suppressed: false, optOutNotRecorded: true }

    it('raises opt_out_not_recorded on the reply path, with ids only', () => {
      const alarm: NotificationEvent | null = optOutNotRecordedNotification(notRecorded)
      expect(alarm).toEqual({
        kind: 'opt_out_not_recorded',
        orgId: ORG,
        touchId: recorded.touchId,
        contactId: recorded.contactId,
        path: 'reply',
      })
      expectNoLeadData(alarm!)
      const text = slackMessage(alarm!, ORIGIN).text
      expect(text).toMatch(/^OPT-OUT NOT RECORDED\. Somebody asked to be left alone through a reply/)
      expect(text).not.toContain('paused')
    })

    /**
     * Review round 7: a colleague answered our mail and asked to stop. The
     * opt-out is theirs, so the alarm names their reply, never the contact
     * it was filed under — whose address is the wrong one to record.
     */
    it('names the reply and not the contact for a stop sent by somebody else', () => {
      const alarm = optOutNotRecordedNotification({ ...notRecorded, fromIsContact: false })
      expect(alarm).toEqual({
        kind: 'opt_out_not_recorded',
        orgId: ORG,
        touchId: recorded.touchId,
        contactId: null,
        path: 'reply',
        fromIsContact: false,
      })
      const text = slackMessage(alarm!, ORIGIN).text
      expect(text).toContain('sent by somebody other than the contact')
      expect(text).not.toContain(recorded.contactId)
    })

    it('is not ALSO announced as an ordinary reply', () => {
      expect(replyNotification(notRecorded)).toBeNull()
    })

    it('raises nothing for a recorded reply, a redelivery, or nothing matched', () => {
      expect(optOutNotRecordedNotification(recorded)).toBeNull()
      expect(optOutNotRecordedNotification({ ...notRecorded, duplicate: true })).toBeNull()
      expect(optOutNotRecordedNotification({ matched: 'none', why: 'no contact has this address' })).toBeNull()
    })
  })
})

describe('the booking hook (POST /api/book/[slug])', () => {
  const accepted: BookingOutcome & typeof DECOYS = {
    ok: true,
    orgId: ORG,
    meetingId: '00000000-0000-4000-8000-000000000003',
    companyDomain: 'acme.example',
    needsReview: false,
    ...DECOYS,
  }

  it('names the meeting and the domain — never what the visitor typed', () => {
    const event: NotificationEvent | null = bookingNotification(accepted)
    expect(event).toEqual({
      kind: 'booking',
      orgId: ORG,
      meetingId: accepted.meetingId,
      companyDomain: 'acme.example',
      needsReview: false,
    })
    expectNoLeadData(event!)
  })

  it('announces nothing for a refused booking, which wrote nothing', () => {
    expect(bookingNotification({ ok: false, status: 404, message: 'This booking link is not active.' })).toBeNull()
  })

  /** The one route that MAKES `.inbound` rows: a free-mail visitor. */
  it('never posts a free-mail visitor’s row name, which is their address', () => {
    const event = bookingNotification({ ...accepted, companyDomain: 'jane-doe-gmail-com.inbound', needsReview: true })
    const posted = wire(event!)
    expect(posted).not.toContain('.inbound')
    expect(posted).not.toContain('gmail')
    expectNoLeadData(event!)
  })
})

describe('the deal hook (PATCH /api/deals/:id)', () => {
  const deal = (stage: string, over: Partial<DealRow> = {}): DealRow => ({
    id: '00000000-0000-4000-8000-000000000004',
    orgId: ORG,
    companyId: COMPANY,
    stage,
    valueCents: 960_000,
    currency: 'USD',
    ownerUserId: null,
    nextAction: DECOYS.notes,
    nextActionAt: null,
    closedAt: null,
    lostReason: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: null,
    ...over,
  })

  it.each([
    ['proposal', 'won', 'won'],
    ['meeting', 'lost', 'lost'],
    ['lost', 'won', 'won'],
  ] as const)('a move from %s to %s closes the deal %s', (from, to, closed) => {
    expect(closedStage(deal(from), deal(to))).toBe(closed)
  })

  it.each([
    ['won', 'won', 'a re-drop on the column it is already in re-stamps closed_at and changes nothing'],
    ['lost', 'meeting', 'reopening is a move, not a close'],
    ['replied', 'meeting', 'an open move'],
    ['proposal', 'proposal', 'a PATCH that only edits nextAction or the owner'],
  ] as const)('%s → %s announces nothing (%s)', (from, to, _why) => {
    expect(closedStage(deal(from), deal(to))).toBeNull()
  })

  it('names the deal, the stage and the domain — never the lost reason or the next action', () => {
    const before = deal('meeting')
    const after = deal('lost', { lostReason: DECOYS.notes, closedAt: new Date() })
    const stage = closedStage(before, after)
    expect(stage).toBe('lost')
    const event: NotificationEvent = dealClosedNotification({
      orgId: ORG,
      dealId: before.id,
      stage: stage!,
      companyDomain: DOMAIN,
    })
    expect(event).toEqual({ kind: 'deal_closed', orgId: ORG, dealId: before.id, companyDomain: 'acme.example', stage: 'lost' })
    expectNoLeadData(event)
  })
})

describe('the proposal hook (PATCH /api/proposals/:id)', () => {
  const proposal = (status: string): ProposalRow => ({
    id: '00000000-0000-4000-8000-000000000005',
    orgId: ORG,
    companyId: COMPANY,
    dealId: '00000000-0000-4000-8000-000000000004',
    scanId: '00000000-0000-4000-8000-000000000006',
    status,
    title: `Proposal for ${DECOYS.name}`,
    document: { preparedFor: DECOYS.name, contact: DECOYS.email, notes: DECOYS.notes },
    currency: 'USD',
    totalLow: 9_600,
    totalHigh: 15_600,
    generatedAt: new Date('2026-09-01T00:00:00Z'),
    createdBy: null,
    decidedAt: status === 'accepted' ? new Date() : null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: null,
  })

  it('names the proposal and the domain, as the team’s own decision — never the document', () => {
    const row = proposal('accepted')
    const event: NotificationEvent | null = proposalAcceptedNotification({ orgId: ORG, row, companyDomain: DOMAIN })
    expect(event).toEqual({ kind: 'proposal_accepted', orgId: ORG, proposalId: row.id, companyDomain: 'acme.example', via: 'team' })
    expectNoLeadData(event!)
    expect(wire(event!)).toContain('recorded by the team')
  })

  it.each(['sent', 'declined', 'withdrawn'])('announces nothing for %s', (status) => {
    expect(proposalAcceptedNotification({ orgId: ORG, row: proposal(status), companyDomain: DOMAIN })).toBeNull()
  })
})

describe('the hooks, as the routes wire them (read from the source)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (path: string): string => readFileSync(resolve(here, '../src/app/api', path), 'utf8')
  /** The code, without the comments — which talk about `after()` too. */
  const code = (path: string): string =>
    read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  /** route, its builder, and the statement the hook must come after. */
  const ROUTES = [
    ['inbound/email', 'replyNotification', 'await handleInboundEmail('],
    ['book/[slug]', 'bookingNotification', 'if (!r.ok) return'],
    ['deals/[id]', 'dealClosedNotification', 'await appendAudit('],
    ['proposals/[id]', 'proposalAcceptedNotification', 'if (!row) return'],
  ] as const

  it.each(ROUTES)('%s builds its event with %s, the module this file tests', (dir, builder) => {
    const route = read(`${dir}/route.ts`)
    expect(route).toMatch(/import \{[^}]*\bafter\b[^}]*\} from 'next\/server'/)
    expect(route).toContain(`from './notification'`)
    expect(route).toContain(`${builder}(`)
    expect(route).toContain(`from '@/lib/slack'`)
  })

  it.each(ROUTES)('%s schedules the post after the write, never before it', (dir, _builder, write) => {
    const route = code(`${dir}/route.ts`)
    expect(route.indexOf(write)).toBeGreaterThan(-1)
    expect(route.indexOf('after(')).toBeGreaterThan(route.indexOf(write))
  })

  /**
   * `after()` throws synchronously on a host with no `waitUntil`. Outside a
   * try, that turns a committed write into a 500 — and for the webhook, a
   * provider retry of a reply that is already recorded.
   */
  it.each(ROUTES)('%s calls after() only inside a try', (dir) => {
    const route = code(`${dir}/route.ts`)
    const calls = route.match(/\bafter\(/g) ?? []
    const guarded = route.match(/try \{\s*after\(/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(guarded.length).toBe(calls.length)
  })

  it.each(ROUTES)('%s/notification.ts imports types only, and spreads nothing', (dir) => {
    const source = code(`${dir}/notification.ts`)
    const imports = source.split('\n').filter((l) => l.startsWith('import '))
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toMatch(/^import type /)
    expect(source).not.toContain('server-only')
    expect(source).not.toContain(`from '@/`)
    expect(source).not.toMatch(/\.\.\.[a-z]/i)
  })

  /**
   * The alarm is the one post that must not be lost to a host without
   * `waitUntil`, so it is AWAITED, never scheduled — like the unsubscribe
   * and erasure routes' — and it comes after the write it reports on.
   */
  it.each(['inbound/email/route.ts', 'inbound/resend/route.ts'])(
    '%s awaits the unrecorded-opt-out alarm after the delivery is handled, never inside after()',
    (path) => {
      const route = code(path)
      expect(route).toContain('optOutNotRecordedNotification(')
      const awaited = route.indexOf('if (alarm) await notify(alarm)')
      expect(awaited).toBeGreaterThan(-1)
      const handled = Math.max(route.indexOf('await handleInboundEmail('), route.indexOf('await receiveResendWebhook('))
      expect(awaited).toBeGreaterThan(handled)
      expect(route).not.toMatch(/after\(\(\) => notify\(alarm\)\)/)
    },
  )

  it('the webhook compares its secret with the shared helper, not a private copy', () => {
    const route = read('inbound/email/route.ts')
    expect(route).toContain(`import { secretMatches } from '@/lib/secret'`)
    expect(route).not.toMatch(/function secretMatches/)
    expect(route).not.toContain('timingSafeEqual')
  })
})
