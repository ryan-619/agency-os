/**
 * What /audit says about each row (PROMPT.md §2.3, §2.4).
 *
 * Three promises, each pinned here rather than argued in a comment:
 *
 *   * every action a writer in this repo produces has a sentence, and the
 *     sentence is built from the row alone;
 *   * an action nobody wrote a sentence for is shown as its raw name, not a
 *     guess and not a blank;
 *   * nothing stored under a key that looks like a credential — the logger's
 *     own `SENSITIVE_KEY` — ever reaches a sentence, and the raw `<details>`
 *     beside it goes through `redact()`.
 *
 * The third is tested two ways. Once with canaries under credential-shaped
 * keys, merged over each action's real detail shape. And once with a Proxy
 * that answers EVERY key a template asks for, recording what it was asked:
 * that catches a template written next year that reads `detail.token`,
 * which no list of today's keys could.
 */
import { REDACTED, SENSITIVE_KEY, SUPPRESSION_SOURCES } from '@agency/core'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_ACTIONS,
  AUDIT_FAMILIES,
  SUPPRESSION_SOURCE_WORDS,
  UNRECORDED_SOURCE,
  actorLabel,
  companyLabel,
  detailForDisplay,
  detailValue,
  isAlarm,
  sentenceFor,
  subjectHref,
  suppressionSource,
  type AuditLine,
} from '../src/lib/audit-copy'

const ORG_USER = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
const OTHER_USER = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0002'
const GONE_USER = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0003'
const SUBJECT = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'
const COMPANY = { domain: 'rentman.io', name: 'Rentman' }

const line = (action: string, detail: unknown = {}, over: Partial<AuditLine> = {}): AuditLine => ({
  action,
  actor: ORG_USER,
  subjectType: null,
  subjectId: null,
  detail,
  ...over,
})

const people: Record<string, string> = { [ORG_USER]: 'Priya', [OTHER_USER]: 'Sam' }
const lookups = { company: COMPANY, person: (id: string) => people[id] ?? null }

/**
 * Every action a writer in this tree produces today, with the detail shape
 * it writes (research §6.4, and the wave-1 writers since). A new writer is
 * added HERE, and the test fails until audit-copy.ts has its sentence.
 */
const WRITTEN: Readonly<Record<string, Record<string, unknown>>> = {
  'deal.created': { companyId: SUBJECT, stage: 'contacted' },
  'deal.advanced': { companyId: SUBJECT, stage: 'replied' },
  'deal.unchanged': { companyId: SUBJECT, stage: 'meeting' },
  'deal.moved': { companyId: SUBJECT, from: 'replied', to: 'meeting' },
  'deal.updated': { companyId: SUBJECT, from: 'meeting', to: 'meeting', nextAction: 'Send the brief' },
  'meeting.booked': {
    companyId: SUBJECT, contactId: SUBJECT, startsAt: '2026-09-25T14:00:00.000Z', timeZone: 'Europe/London',
    source: 'manual', deal: 'advanced:meeting', needsReview: false,
  },
  'meeting.cancelled': {},
  'proposal.generated': { companyId: SUBJECT, scanId: SUBJECT, workstreams: 2, scopeItems: 8, notAssessed: 1 },
  'proposal.sent': { companyId: SUBJECT },
  'proposal.accepted': { companyId: SUBJECT },
  'proposal.declined': { companyId: SUBJECT },
  'proposal.withdrawn': { companyId: SUBJECT },
  'lead.inbound': {
    companyId: SUBJECT, meetingId: SUBJECT, recognised: false, createdContact: true, createdCompany: true,
    consented: ['email', 'sms'],
  },
  'send.sent': { campaignId: SUBJECT, contactId: SUBJECT, channel: 'email', provider: 'smtp', providerId: '<x@y>', approvedBy: OTHER_USER },
  'send.failed': { campaignId: SUBJECT, provider: 'smtp', error: 'Error' },
  'send.no_such_subject': { contactId: SUBJECT },
  'send.suppressed': { campaignId: SUBJECT, channel: 'email', code: 'suppressed' },
  'send.quiet_hours': { campaignId: SUBJECT, channel: 'email', code: 'quiet_hours' },
  'send.daily_cap': { campaignId: SUBJECT, channel: 'email', code: 'daily_cap' },
  'send.no_consent': { campaignId: SUBJECT, channel: 'sms', code: 'no_consent' },
  'send.consent_revoked': { campaignId: SUBJECT, channel: 'email', code: 'consent_revoked' },
  'send.cold_channel_forbidden': { campaignId: SUBJECT, channel: 'voice', code: 'cold_channel_forbidden' },
  'send.unknown_timezone': { campaignId: SUBJECT, channel: 'email', code: 'unknown_timezone' },
  'send.unparseable_recipient': { campaignId: SUBJECT, channel: 'linkedin', code: 'unparseable_recipient' },
  'send.campaign_inactive': { campaignId: SUBJECT, channel: 'email', code: 'campaign_inactive' },
  'send.needs_approval': { campaignId: SUBJECT, channel: 'email', code: 'needs_approval' },
  'draft.approved': { contactId: SUBJECT, campaignId: SUBJECT, channel: 'email' },
  'draft.denied': { note: 'too pushy' },
  'contact.replied': { channel: 'email', paused: true, cancelledQueued: 2, suppressed: false, deal: 'advanced:replied' },
  'contact.opt_out_not_recorded': { touchId: SUBJECT, channel: 'email', why: 'unparseable' },
  'contact.created': { companyId: SUBJECT, source: 'manual', hasTimeZone: true },
  'contact.paused': { reason: 'asked for Q1', alreadyPaused: false },
  'contact.resumed': { hadReason: 'asked for Q1' },
  'contact.timezone_set': { timeZone: 'Europe/Amsterdam' },
  'consent.granted': { channel: 'sms', source: 'said yes on the call, 12 Sep' },
  'consent.declined': { channel: 'sms', source: 'said no' },
  'consent.refusal_lifted': { channel: 'sms', reason: 'recorded against the wrong contact' },
  'campaign.created': { name: 'Q3 SaaS', channel: 'email', autoSend: false, dailyCap: 40 },
  'campaign.updated': { name: 'Q3 SaaS', channel: 'email', autoSend: false, dailyCap: 30, status: 'active' },
  'campaign.auto_send_on': { name: 'Q3 SaaS', channel: 'email', autoSend: true, dailyCap: 30, status: 'active' },
  'campaign.auto_send_off': { name: 'Q3 SaaS', channel: 'email', autoSend: false, dailyCap: 30, status: 'active' },
  'suppression.added': { kind: 'email', value: 'stop@example.com', reason: 'asked by phone' },
  'suppression.already_present': { kind: 'domain', value: 'example.com', reason: 'again' },
  'suppression.removed': { kind: 'email', value: 'x@example.com', hadReason: 'mistake', hadSource: 'reply', addedAt: '2026-09-01T00:00:00Z' },
  'agent.get_icp': { turnId: SUBJECT },
  'agent.search_companies': { matched: 12, returned: 10, turnId: SUBJECT },
  'agent.get_company': { domain: 'rentman.io', turnId: SUBJECT },
  'agent.scan_company': { domain: 'rentman.io', scanId: SUBJECT, score: 77, turnId: SUBJECT },
  'agent.score_company': { domain: 'rentman.io', rescanned: true, score: 77, turnId: SUBJECT },
  'agent.get_pipeline': { stage: 'replied', returned: 3, turnId: SUBJECT },
  'agent.update_deal': { domain: 'rentman.io', dealId: SUBJECT, stage: 'meeting', moved: 'advanced', turnId: SUBJECT },
  'agent.book_meeting': { domain: 'rentman.io', meetingId: SUBJECT, startsAt: '2026-09-25T14:00:00.000Z', timeZone: 'Europe/London' },
  'agent.queue_touch': { domain: 'rentman.io', channel: 'email', touchId: SUBJECT, turnId: SUBJECT },
  'agent.tool_pre': { toolName: 'queue_touch', toolUseId: 't1', risk: 'high', rule: 'ask', turnId: SUBJECT },
  'agent.tool_post': { toolName: 'queue_touch', toolUseId: 't1', turnId: SUBJECT },
  'agent.tool_allow': { toolName: 'get_icp', toolUseId: 't1', risk: 'low', rule: 'allow', turnId: SUBJECT },
  'agent.tool_refused': { toolName: 'Bash', toolUseId: 't1', risk: 'high', rule: 'unknown_tool', turnId: SUBJECT },
  'approval.requested': { approvalId: SUBJECT, toolName: 'queue_touch', risk: 'high', toolUseId: 't1', turnId: SUBJECT },
  'approval.approved': { toolName: 'queue_touch', risk: 'high' },
  'approval.denied': { toolName: 'queue_touch', risk: 'high' },
  'approval.expired': { approvalId: SUBJECT, toolName: 'queue_touch', turnId: SUBJECT },
  'approval.cancelled': { toolName: 'queue_touch', turnId: SUBJECT, why: 'the turn ended first' },
  'approval.orphaned_by_worker_restart': { toolName: 'queue_touch' },
  'turn.interrupted_by_worker_restart': { turnId: SUBJECT },
  'agent.created': { slug: 'researcher', model: 'claude-haiku-4-5', tools: ['get_icp'] },
  'agent.updated': { slug: 'researcher', model: 'claude-haiku-4-5', tools: ['get_icp'] },
  'agent.deleted': { slug: 'researcher' },
  'agent.enabled': { slug: 'researcher' },
  'agent.disabled': { slug: 'researcher' },
  'connector.created': { name: 'deepwiki', kind: 'http', hasCredential: false },
  'connector.enabled': { name: 'deepwiki', kind: 'http' },
  'connector.disabled': { name: 'deepwiki', kind: 'http' },
  'connector.deleted': { name: 'deepwiki', kind: 'http' },
  'connector.probe_ok': { name: 'deepwiki', kind: 'http', tools: ['ask_wiki_question', 'read_wiki_contents'] },
  'connector.probe_failed': { name: 'deepwiki', kind: 'http', tools: [] },
  'call.opted_out': { suppressed: true },
  'call.handoff': { reason: 'asked for a person', toUserId: OTHER_USER },
  'call.ended': { status: 'completed', outcome: 'qualified', sentiment: 'positive', durationS: 125, disclosed: true },
  'notification.sent': { channel: 'slack', event: 'reply', ids: {}, status: 200 },
  'notification.failed': { channel: 'slack', event: 'reply', ids: {}, status: 500, error: 'http_500' },
}

describe('sentenceFor', () => {
  it('has a sentence for every action a writer in this tree produces', () => {
    const missing = Object.keys(WRITTEN).filter((a) => !AUDIT_ACTIONS.includes(a))
    expect(missing).toEqual([])
  })

  it('builds each catalogued sentence from the row, with nothing unfilled in it', () => {
    for (const action of AUDIT_ACTIONS) {
      for (const detail of [WRITTEN[action] ?? {}, {}]) {
        const s = sentenceFor(line(action, detail, { subjectId: SUBJECT, subjectType: 'deal' }), lookups)
        expect(s, action).not.toBe(action)
        expect(s.length, action).toBeGreaterThan(8)
        expect(s, action).not.toMatch(/undefined|\bnull\b|NaN|\[object |\$\{/)
      }
    }
  })

  it('says what happened in the words the page leads with', () => {
    expect(sentenceFor(line('deal.moved', WRITTEN['deal.moved']), lookups)).toBe(
      'moved rentman.io from replied to meeting',
    )
    expect(sentenceFor(line('deal.moved', { from: 'proposal', to: 'lost', lostReason: 'went with a bigger firm' }), lookups)).toBe(
      'moved rentman.io from proposal to lost: “went with a bigger firm”',
    )
    expect(sentenceFor(line('suppression.added', WRITTEN['suppression.added']), lookups)).toBe(
      'added an email address to the suppression list',
    )
    expect(sentenceFor(line('suppression.removed', WRITTEN['suppression.removed']), lookups)).toBe(
      'removed an email address from the suppression list (source: reply); it may be contacted again',
    )
    expect(sentenceFor(line('send.sent', WRITTEN['send.sent'], { actor: 'system' }), lookups)).toBe(
      'sent an email to a contact at rentman.io via smtp, approved by Sam',
    )
    expect(sentenceFor(line('send.sent', { ...WRITTEN['send.sent'], approvedBy: null }, { actor: 'system' }), lookups)).toBe(
      'sent an email to a contact at rentman.io via smtp under auto-send',
    )
    expect(sentenceFor(line('send.suppressed', WRITTEN['send.suppressed']), lookups)).toBe(
      'refused an email to a contact at rentman.io: on the suppression list; nothing was sent',
    )
    expect(sentenceFor(line('meeting.booked', WRITTEN['meeting.booked']), lookups)).toContain('(Europe/London)')
  })

  it('never writes the removed value into the sentence — the list is the place for the value', () => {
    for (const action of ['suppression.added', 'suppression.already_present', 'suppression.removed']) {
      const s = sentenceFor(line(action, WRITTEN[action]), lookups)
      expect(s, action).not.toContain('example.com')
    }
  })

  it('tells the web approval apart from the worker receiving it — the same decision is written twice', () => {
    const detail = { approvalId: SUBJECT, decidedBy: OTHER_USER, toolName: 'queue_touch', turnId: SUBJECT }
    expect(sentenceFor(line('approval.approved', WRITTEN['approval.approved']), lookups)).toBe('approved queue_touch')
    expect(sentenceFor(line('approval.approved', detail, { actor: 'agent' }), lookups)).toBe(
      'received the approval to run queue_touch from Sam',
    )
  })

  it('falls back to the raw action name for an action it has no sentence for', () => {
    expect(sentenceFor(line('thing.happened', { anything: 'at all' }), lookups)).toBe('thing.happened')
    expect(sentenceFor(line('deal', {}), lookups)).toBe('deal')
  })

  it('falls back to the raw name, not a crash, when a detail shape throws', () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error('boom')
      },
      getOwnPropertyDescriptor() {
        throw new Error('boom')
      },
    })
    expect(sentenceFor(line('deal.moved', hostile), lookups)).toBe('deal.moved')
  })

  it('names an unresolved company and an unknown person honestly, never as an id', () => {
    const s = sentenceFor(line('deal.moved', { from: 'replied', to: 'meeting' }), {})
    expect(s).toBe('moved an unknown company from replied to meeting')
    const handoff = sentenceFor(line('call.handoff', { toUserId: GONE_USER }, { actor: 'voice' }), lookups)
    expect(handoff).toBe('handed a call to a person')
    expect(handoff).not.toContain(GONE_USER)
  })

  it('does not print a free-mail lead’s address-shaped domain', () => {
    const inbound = { domain: 'priya-gmail-com.inbound', name: 'Priya Shah' }
    expect(companyLabel(inbound)).toBe('Priya Shah (inbound lead)')
    const s = sentenceFor(line('lead.inbound', WRITTEN['lead.inbound'], { actor: 'booking_page' }), { company: inbound })
    expect(s).not.toContain('gmail')
    expect(sentenceFor(line('agent.get_company', { domain: 'priya-gmail-com.inbound' }), {})).toBe('read an inbound lead')
  })
})

describe('credentials never reach a sentence', () => {
  const CANARY = 'CANARY-7f3a'
  const SENSITIVE_NAMES = [
    'password', 'token', 'secret', 'apiKey', 'api_key', 'authorization', 'cookie', 'dsn', 'credential',
    'accessToken', 'webhookSecret', 'key', 'auth', 'bearer', 'connectionString',
  ]

  it('detailValue refuses every credential-shaped key, whatever it holds', () => {
    for (const k of SENSITIVE_NAMES) {
      expect(SENSITIVE_KEY.test(k), k).toBe(true)
      expect(detailValue({ [k]: CANARY }, k), k).toBeUndefined()
    }
    expect(detailValue({ name: 'postgres://app:hunter2@db:5432/x' }, 'name')).toBeUndefined()
    expect(detailValue({ name: 'deepwiki' }, 'name')).toBe('deepwiki')
  })

  it('keeps canaries under credential-shaped keys out of every catalogued sentence', () => {
    const planted = Object.fromEntries(SENSITIVE_NAMES.map((k, i) => [k, `${CANARY}-${i}`]))
    for (const action of AUDIT_ACTIONS) {
      for (const actor of [ORG_USER, 'agent', 'system']) {
        const s = sentenceFor(line(action, { ...(WRITTEN[action] ?? {}), ...planted }, { actor }), lookups)
        expect(s, action).not.toContain(CANARY)
      }
    }
  })

  it('never ASKS for a credential-shaped key, for any action — including ones written after this test', () => {
    // A detail that answers every key it is asked for, and records the asking.
    const asked = new Set<string>()
    const answerAll = new Proxy({} as Record<string, unknown>, {
      get(_t, key) {
        if (typeof key === 'string') asked.add(key)
        return typeof key === 'string' ? `v-${key.toLowerCase()}` : undefined
      },
      has() {
        return true
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key === 'string') asked.add(key)
        return { value: typeof key === 'string' ? `v-${key.toLowerCase()}` : undefined, configurable: true, enumerable: true, writable: true }
      },
    })
    for (const action of AUDIT_ACTIONS) {
      for (const actor of [ORG_USER, 'agent']) {
        const s = sentenceFor(line(action, answerAll, { actor }), lookups)
        for (const m of s.matchAll(/v-([a-z_]+)/g)) {
          expect(SENSITIVE_KEY.test(m[1] ?? ''), `${action} printed ${m[0]}`).toBe(false)
        }
      }
    }
    const sensitiveAsked = [...asked].filter((k) => SENSITIVE_KEY.test(k))
    expect(sensitiveAsked).toEqual([])
    // It must have asked for SOMETHING, or the Proxy was never consulted.
    expect(asked.size).toBeGreaterThan(20)
  })

  it('keeps a connection string under an innocuous key out of the sentence that reads that key', () => {
    const dsn = 'postgres://app:hunter2@db.internal:5432/agency'
    expect(sentenceFor(line('draft.denied', { note: dsn }), lookups)).toBe('denied a draft about rentman.io')
    expect(sentenceFor(line('campaign.created', { name: dsn }), lookups)).not.toContain('hunter2')
    expect(sentenceFor(line('contact.paused', { reason: dsn }), lookups)).not.toContain('hunter2')
  })

  it('redacts the raw detail shown beside the sentence, nested keys included', () => {
    const shown = detailForDisplay({
      toolName: 'x', token: CANARY, headers: { authorization: `Bearer ${CANARY}` }, url: 'postgres://u:p@h/db',
    })
    expect(shown).not.toContain(CANARY)
    expect(shown).not.toContain('u:p@')
    expect(shown).toContain(REDACTED)
    expect(shown).toContain('"toolName": "x"')
    expect(detailForDisplay(null)).toBe(JSON.stringify({ detail: null }, null, 2))
  })
})

describe('around the sentence', () => {
  it('names the literal actors, a teammate, a revoked teammate and a former one', () => {
    const resolved = new Map([
      [ORG_USER, { email: 'priya@agency.test', name: 'Priya', revoked: false }],
      [OTHER_USER, { email: 'sam@agency.test', name: null, revoked: true }],
    ])
    expect(actorLabel('booking_page', resolved)).toEqual({ label: 'booking page', note: null })
    expect(actorLabel('agent', resolved)).toEqual({ label: 'agent', note: null })
    expect(actorLabel('system', resolved)).toEqual({ label: 'system', note: null })
    expect(actorLabel('voice', resolved)).toEqual({ label: 'voice', note: null })
    expect(actorLabel(ORG_USER, resolved)).toEqual({ label: 'Priya', note: null })
    expect(actorLabel(OTHER_USER, resolved)).toEqual({ label: 'sam@agency.test', note: 'access since revoked' })
    expect(actorLabel(GONE_USER, resolved)).toEqual({ label: 'a former teammate', note: null })
  })

  it('links each subject to the page that exists for it, and a gone one nowhere', () => {
    const row = (subjectType: string, subjectId: string | null = SUBJECT): AuditLine =>
      line('x', {}, { subjectType, subjectId })
    expect(subjectHref(row('meeting'), null)).toBe(`/meetings/${SUBJECT}`)
    expect(subjectHref(row('proposal'), null)).toBe(`/proposals/${SUBJECT}`)
    expect(subjectHref(row('call'), null)).toBe(`/calls/${SUBJECT}`)
    expect(subjectHref(row('deal'), COMPANY)).toBe('/companies/rentman.io')
    expect(subjectHref(row('deal'), null)).toBe('/pipeline')
    expect(subjectHref(row('contact'), COMPANY)).toBe('/companies/rentman.io')
    expect(subjectHref(row('touch'), COMPANY)).toBe('/companies/rentman.io')
    expect(subjectHref(row('touch'), null)).toBeNull()
    expect(subjectHref(row('suppression', null), null)).toBe('/suppressions')
    expect(subjectHref(row('meeting', 'not-a-uuid'), null)).toBeNull()
  })

  it('raises the §2.1 failures rather than rendering them like every other line', () => {
    expect(isAlarm(line('contact.opt_out_not_recorded'))).toBe(true)
    expect(isAlarm(line('call.opted_out', { suppressed: false }))).toBe(true)
    expect(isAlarm(line('call.opted_out', { suppressed: true }))).toBe(false)
    expect(isAlarm(line('call.ended', { disclosed: false }))).toBe(true)
    expect(isAlarm(line('call.ended', { disclosed: true }))).toBe(false)
    expect(isAlarm(line('deal.moved'))).toBe(false)
  })

  it('offers every catalogued family as a filter', () => {
    const families = AUDIT_FAMILIES.map((f) => f.value)
    for (const a of AUDIT_ACTIONS) expect(families).toContain(a.split('.')[0])
    expect(new Set(families).size).toBe(families.length)
  })
})

describe('suppression sources', () => {
  it('has a tag for every source the database accepts, named as itself', () => {
    for (const s of SUPPRESSION_SOURCES) {
      expect(SUPPRESSION_SOURCE_WORDS[s].tag).toBe(s)
      expect(suppressionSource(s)).toBe(SUPPRESSION_SOURCE_WORDS[s])
    }
  })

  it('shows a row from before sources were tracked as unrecorded, never as manual', () => {
    expect(suppressionSource(null)).toBe(UNRECORDED_SOURCE)
    expect(UNRECORDED_SOURCE).toEqual({ tag: 'unrecorded', explain: 'recorded before sources were tracked' })
    const s = sentenceFor(line('suppression.removed', { kind: 'phone', hadSource: null }), lookups)
    expect(s).toBe('removed a phone number from the suppression list (source: unrecorded); it may be contacted again')
  })
})
