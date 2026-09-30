/**
 * What a Slack notification says — and, more to the point, what it cannot
 * say. A channel is outside every rule about who sees a prospect's words,
 * so the payload is ids, a public domain, a kind and a link, and the tests
 * here are mostly about the fields that must never get through.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayDomain, slackMessage, type NotificationEvent } from '../src/lib/slack-message'

const ORG = '00000000-0000-4000-8000-00000000000a'
const ORIGIN = 'https://app.test'

/** One of every kind, with realistic ids. */
const EVENTS: readonly NotificationEvent[] = [
  {
    kind: 'reply', orgId: ORG, contactId: '00000000-0000-4000-8000-000000000001', touchId: '00000000-0000-4000-8000-000000000002',
    companyDomain: 'acme.example', replyKind: 'interested', paused: true, suppressed: false,
  },
  { kind: 'booking', orgId: ORG, meetingId: '00000000-0000-4000-8000-000000000003', companyDomain: 'acme.example', needsReview: false },
  { kind: 'deal_closed', orgId: ORG, dealId: '00000000-0000-4000-8000-000000000004', companyDomain: 'acme.example', stage: 'won' },
  { kind: 'proposal_accepted', orgId: ORG, proposalId: '00000000-0000-4000-8000-000000000005', companyDomain: 'acme.example', via: 'share_link' },
  { kind: 'opt_out_not_recorded', orgId: ORG, touchId: '00000000-0000-4000-8000-000000000002', contactId: null, path: 'unsubscribe' },
  { kind: 'worker_silent', orgId: ORG, lastTickAt: '2026-09-29T06:00:00.000Z', ageSeconds: 900 },
  {
    kind: 'digest', orgId: ORG, pendingApprovals: 2, unhandledReplies: 3, rottingDeals: 1, staleCompanies: 4, neverScanned: 5,
    dueTasks: 1, overdueTasks: 1, refusals24h: [{ code: 'daily_cap', n: 3 }, { code: 'quiet_hours', n: 1 }],
    optOutsNotRecorded24h: 0, spend24hUsd: '0.12', worker: 'live', topRotting: ['acme.example', 'b.example'],
  },
  { kind: 'campaign_paused', orgId: ORG, campaignId: '00000000-0000-4000-8000-000000000006', bouncePct: 7.5, threshold: 5 },
  // A reply that said stop and could not be suppressed (the inbound routes).
  { kind: 'opt_out_not_recorded', orgId: ORG, touchId: '00000000-0000-4000-8000-000000000007', contactId: '00000000-0000-4000-8000-000000000001', path: 'reply' },
]

/** The lines of a payload that are not the deep link. */
const prose = (text: string): string => text.split('\n').filter((l) => !l.startsWith('http')).join('\n')

describe('slackMessage', () => {
  it.each(EVENTS.map((e) => [e.kind, e] as const))('builds a %s', (_kind, event) => {
    const payload = slackMessage(event, ORIGIN)
    expect(payload.text.length).toBeGreaterThan(0)
    expect(payload.text.length).toBeLessThanOrEqual(4000)
    // Every message links back into the app, from the origin it was given.
    expect(payload.text).toMatch(/https:\/\/app\.test\//)
  })

  /**
   * The union has no field for a body, a name or a number — but the builder
   * is what a later feature calls, and a later feature might pass a row it
   * happens to have. A row's extra fields must never reach the channel.
   */
  it.each(EVENTS.map((e) => [e.kind, e] as const))('drops decoy lead data from a %s', (_kind, event) => {
    const decoys = {
      body: 'DECOY-BODY please call me',
      from: 'DECOY-FROM jane@example.com',
      phone: 'DECOY-PHONE +447700900123',
      name: 'DECOY-NAME Jane Doe',
      note: 'DECOY-NOTE budget approved',
      startsAt: 'DECOY-TIME 2026-10-01T10:00',
    }
    const payload = slackMessage({ ...event, ...decoys } as NotificationEvent, ORIGIN)
    const wire = JSON.stringify(payload)
    for (const value of Object.values(decoys)) expect(wire).not.toContain(value)
    expect(wire).not.toContain('DECOY')
  })

  it('never spreads its input (read from the source)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../src/lib/slack-message.ts'), 'utf8')
    expect(source).not.toMatch(/\.\.\.event\b/)
  })

  /**
   * A free-mail lead's row is named after the person — the address with its
   * punctuation swapped — so the row name is the address, and Slack unfurls
   * and logs every URL it is handed. It may appear in NO field, the link
   * included; the message links somewhere reached by an id or to the list
   * page instead.
   */
  const PERSONAL = 'priya-sharma-gmail-com.inbound'
  const personal: readonly NotificationEvent[] = [
    { kind: 'reply', orgId: ORG, contactId: 'c', touchId: 't', companyDomain: PERSONAL, replyKind: 'other', paused: false, suppressed: false },
    { kind: 'booking', orgId: ORG, meetingId: 'm', companyDomain: PERSONAL, needsReview: true },
    { kind: 'deal_closed', orgId: ORG, dealId: 'd', companyDomain: PERSONAL, stage: 'won' },
    { kind: 'proposal_accepted', orgId: ORG, proposalId: 'p', companyDomain: PERSONAL, via: 'team' },
    { ...EVENTS[6]!, topRotting: [PERSONAL, 'acme.example'] } as NotificationEvent,
  ]

  it.each(personal.map((e) => [e.kind, e] as const))('never lets a free-mail lead’s row name out of a %s, link included', (_kind, event) => {
    const wire = JSON.stringify(slackMessage(event, ORIGIN))
    expect(wire).toContain('a personal address')
    expect(wire).not.toContain('.inbound')
    expect(wire).not.toContain('priya')
    expect(wire).not.toContain('sharma')
    expect(wire).not.toContain('gmail')
  })

  it('links a free-mail lead’s reply to the inbox and their deal to the board, never to a company page', () => {
    expect(slackMessage(personal[0]!, ORIGIN).text).toContain(`${ORIGIN}/inbox`)
    expect(slackMessage(personal[2]!, ORIGIN).text).toContain(`${ORIGIN}/pipeline`)
    for (const event of personal) expect(slackMessage(event, ORIGIN).text).not.toContain('/companies/')
  })

  it('still links a real company to its page, and says its domain', () => {
    const payload = slackMessage(EVENTS[2]!, ORIGIN)
    expect(payload.text).toContain('acme.example')
    expect(payload.text).toContain(`${ORIGIN}/companies/acme.example`)
  })

  it('says a suppressed reply is not to be answered', () => {
    const payload = slackMessage(
      { kind: 'reply', orgId: ORG, contactId: 'c', touchId: 't', companyDomain: 'acme.example', replyKind: 'opted_out', paused: true, suppressed: true },
      ORIGIN,
    )
    expect(payload.text).toContain('asked to stop — do not answer')
    // The pause is implied by the suppression; saying both would bury the
    // instruction that matters.
    expect(payload.text).not.toContain('sequence is paused')
  })

  it('says a paused reply is waiting on a person', () => {
    const payload = slackMessage(
      { kind: 'reply', orgId: ORG, contactId: 'c', touchId: 't', companyDomain: 'acme.example', replyKind: 'not_now', paused: true, suppressed: false },
      ORIGIN,
    )
    expect(payload.text).toContain('sequence is paused')
  })

  it('links a reply with no company to the inbox', () => {
    const payload = slackMessage(
      { kind: 'reply', orgId: ORG, contactId: 'c', touchId: 't', companyDomain: null, replyKind: 'other', paused: false, suppressed: false },
      ORIGIN,
    )
    expect(payload.text).toContain(`${ORIGIN}/inbox`)
    expect(prose(payload.text)).toContain('a personal address')
  })

  it('normalises an origin with a trailing slash', () => {
    const payload = slackMessage(EVENTS[3]!, 'https://app.test/')
    expect(payload.text).toContain('https://app.test/proposals/')
    expect(payload.text).not.toContain('https://app.test//')
  })

  it('escapes a domain into the link path', () => {
    const payload = slackMessage(
      { kind: 'deal_closed', orgId: ORG, dealId: 'd', companyDomain: 'münchen.example', stage: 'lost' },
      ORIGIN,
    )
    expect(payload.text).toContain(`${ORIGIN}/companies/${encodeURIComponent('münchen.example')}`)
  })

  it('puts the refusal words, not the codes, in a digest', () => {
    const payload = slackMessage(EVENTS[6]!, ORIGIN)
    expect(payload.text).toContain('3 daily cap')
    expect(payload.text).toContain('1 quiet hours')
    expect(payload.text).not.toContain('daily_cap')
  })

  it('leads a digest with an opt-out that was not recorded, when there is one', () => {
    const digest = { ...EVENTS[6]!, optOutsNotRecorded24h: 2 } as NotificationEvent
    expect(slackMessage(digest, ORIGIN).text).toContain('NEEDS A PERSON: 2 opt-out(s)')
    expect(slackMessage(EVENTS[6]!, ORIGIN).text).not.toContain('NEEDS A PERSON')
  })

  it('keeps a digest with a long tail under Slack’s limit', () => {
    const digest = {
      ...EVENTS[6]!,
      topRotting: Array.from({ length: 400 }, (_, i) => `company-${i}.example`),
    } as NotificationEvent
    const payload = slackMessage(digest, ORIGIN)
    expect(payload.text.length).toBeLessThanOrEqual(4000)
    expect(payload.text.endsWith('…')).toBe(true)
  })

  it('says what a silent worker means for the queue', () => {
    const payload = slackMessage(EVENTS[5]!, ORIGIN)
    expect(payload.text).toContain('not being sent')
    expect(payload.text).toContain('900s ago')
    expect(slackMessage({ kind: 'worker_silent', orgId: ORG, lastTickAt: null, ageSeconds: null }, ORIGIN).text).toContain('never ticked')
  })

  it('says which way an unrecorded opt-out arrived — the link, an erasure, or a reply — and that a person must act', () => {
    const words = (path: 'unsubscribe' | 'erasure' | 'reply') =>
      slackMessage({ kind: 'opt_out_not_recorded', orgId: ORG, touchId: '00000000-0000-4000-8000-000000000007', contactId: null, path }, ORIGIN).text
    expect(words('unsubscribe')).toContain('through the unsubscribe link')
    expect(words('erasure')).toContain('through an erasure request')
    expect(words('reply')).toContain('through a reply')
    for (const path of ['unsubscribe', 'erasure', 'reply'] as const) {
      expect(words(path)).toMatch(/^OPT-OUT NOT RECORDED\./)
      expect(words(path)).toContain('A person has to record it now.')
    }
  })

  it('says why a campaign paused itself', () => {
    const payload = slackMessage(EVENTS[7]!, ORIGIN)
    expect(payload.text).toContain('7.5%')
    expect(payload.text).toContain('5%')
    expect(payload.text).toContain(`${ORIGIN}/campaigns`)
  })
})

describe('displayDomain', () => {
  it('says a company domain as it is', () => {
    expect(displayDomain('acme.example')).toBe('acme.example')
  })

  it('never says a free-mail lead’s row name, which is the person’s address', () => {
    expect(displayDomain('jane-doe-gmail-com.inbound')).toBe('a personal address')
    expect(displayDomain(null)).toBe('a personal address')
  })
})
