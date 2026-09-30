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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENCY_TOOL_NAMES, REDACTED, SENSITIVE_KEY, SUPPRESSION_SOURCES } from '@agency/core'
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
  isActorLiteral,
  isAlarm,
  sentenceFor,
  subjectHref,
  suppressionSource,
  type AuditLine,
} from '../src/lib/audit-copy'
import { REFUSAL_WORDS } from '../src/lib/refusal-words'

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
 * it writes (research §6.4, and the writers since). A new writer is added
 * HERE, and the test fails until audit-copy.ts has its sentence.
 *
 * "Added here" used to be a convention, and the convention failed: features
 * built in parallel wrote seven new actions from files that were not this
 * one, and /audit showed every one of them as a raw name. So the last describe below reads
 * the source tree and fails for an action a writer produces that is missing
 * from this map — and for an entry here that no writer produces, because a
 * test pinned to a name nobody writes proves nothing.
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
  // The inbox's shape; the contacts route writes `{ pausedFor }` alone.
  'contact.resumed': { reason: 'answering their reply from the inbox', inboundTouchId: SUBJECT, pausedFor: 'replied' },
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
  // --- written by the wave-2 features merged beside this one --------------
  'agent.check_send': { domain: 'rentman.io', contactId: SUBJECT, campaignId: SUBJECT, code: 'send_now' },
  'agent.get_consent': { contactId: SUBJECT },
  'contact.updated': { fields: ['name', 'time_zone'] },
  'company.updated': { fields: ['name'] },
  'contacts.imported': { inserted: 12, alreadyPresent: 3, unknownCompany: 1, refused: 0, phoneDropped: 2 },
  'campaign.enrolled': { campaignId: SUBJECT, queued: 14, skipped: {}, status: 'active', limit: 50, truncated: false },
  'deal.next_action_set': { companyId: SUBJECT, from: null, to: '2026-10-02T09:00:00.000Z' },
  'reply.handled': { contactId: SUBJECT, replyKind: 'interested' },
  'reply.reclassified': { from: 'auto_reply', to: 'interested', paused: true, cancelledQueued: 1 },
  'reply.answer_drafted': { inboundTouchId: SUBJECT, touchId: SUBJECT, campaignId: SUBJECT, channel: 'email', resumed: true },
  // `authorUserId` is written only when the writer is not the author — the
  // agent's add_note, with actor `agent`.
  'note.added': { companyId: SUBJECT, noteId: SUBJECT, contactId: SUBJECT, authorUserId: ORG_USER },
  'note.deleted': { companyId: SUBJECT, noteId: SUBJECT, authorUserId: ORG_USER },
  'task.created': { taskId: SUBJECT, kind: 'follow_up', companyId: SUBJECT },
  'task.completed': { taskId: SUBJECT, companyId: SUBJECT },
  'task.reopened': { taskId: SUBJECT, companyId: SUBJECT },
  'task.assigned': { taskId: SUBJECT, assigneeUserId: OTHER_USER },
  'task.due_set': { taskId: SUBJECT, dueAt: '2026-10-02T09:00:00.000Z' },
  'task.template_applied': { template: 'kickoff', companyId: SUBJECT, dealId: SUBJECT, count: 5 },
  'user.granted': { role: 'member' },
  'user.role_changed': { from: 'member', to: 'owner' },
  'user.revoked': { role: 'member', sessionsEnded: 2 },
  'user.restored': { role: 'member' },
  'credential.rotated': { connectorId: SUBJECT, secretId: SUBJECT, label: 'deepwiki token' },
  'credential.deleted': { label: 'old apollo key' },
  'scan.cron_run': { picked: 6, scanned: 5, unreachable: 1, skipped: 0, remaining: 4, schedule: '17 3 * * *' },
  'scan.cron_started': { until: '2026-09-30T03:22:00.000Z', schedule: '17 3 * * *' },
  'meeting.outcome_recorded': { outcome: 'held', companyId: SUBJECT },
  'export.companies': { rows: 42, filters: {} },
  'export.findings': { rows: 310, filters: {} },
  'export.consents': { rows: 18, filters: {} },
  // --- written by the wave-3 features, and the gate's own ------------------
  'agent.tool_disabled': { toolName: 'mcp__zapier__send_email', toolUseId: 't1', agentId: null, agentType: null },
  'agent.get_scan_history': { companyId: SUBJECT, returned: 3, turnId: SUBJECT },
  'agent.get_evidence_changes': {
    companyId: SUBJECT, newerScanId: SUBJECT, olderScanId: SUBJECT, fixed: 1, regressed: 0, notAssessed: 2, nowObserved: 0,
  },
  'agent.get_stale_companies': { matched: 4, returned: 4, turnId: SUBJECT },
  'agent.get_replies': { kind: null, unhandledOnly: true, sinceDays: 14, returned: 2, turnId: SUBJECT },
  'agent.classify_reply': { touchId: SUBJECT, kind: 'interested', from: 'other', handled: true, turnId: SUBJECT },
  'agent.get_pipeline_metrics': { sinceDays: 90, deals: 12, moves: 30, turnId: SUBJECT },
  'agent.get_company_timeline': { companyId: SUBJECT, returned: 20, turnId: SUBJECT },
  'agent.get_compliance_summary': { staleDays: 14, turnId: SUBJECT },
  'agent.search_crm': { sections: ['companies', 'contacts'], returned: 5, truncated: false, turnId: SUBJECT },
  'agent.add_note': { noteId: SUBJECT, companyId: SUBJECT, contactId: null, turnId: SUBJECT },
  'agent.create_task': { taskId: SUBJECT, companyId: SUBJECT, assigneeUserId: OTHER_USER, turnId: SUBJECT },
  'agent.list_tasks': { open: true, assigneeUserId: null, companyId: null, returned: 3, turnId: SUBJECT },
  'proposal.draft': { companyId: SUBJECT },
  'proposal.exported': { companyId: SUBJECT, format: 'markdown' },
  'proposal.accepted_via_share': { proposalId: SUBJECT, shareId: SUBJECT, companyId: SUBJECT },
  'proposal.share_created': { companyId: SUBJECT, shareId: SUBJECT, expiresAt: '2026-10-14T03:17:00.000Z', cappedByEvidence: true },
  'proposal.share_revoked': { shareId: SUBJECT },
  'linkedin.handed': { touchId: SUBJECT, campaignId: SUBJECT, contactId: SUBJECT, userId: ORG_USER },
  'linkedin.sent': { touchId: SUBJECT, taskId: SUBJECT, campaignId: SUBJECT },
  'linkedin.not_sent': { touchId: SUBJECT, taskId: SUBJECT, campaignId: SUBJECT },
  'linkedin.dismissed': { touchId: SUBJECT, taskId: SUBJECT, campaignId: SUBJECT },
  'send.bounced': { campaignId: SUBJECT, channel: 'email', code: 'bounced' },
  'send.stale_evidence': { campaignId: SUBJECT, channel: 'email', code: 'stale_evidence' },
  'contact.bounced': { code: '5.1.1', cancelledQueued: 1, touchId: SUBJECT },
  'contact.bounce_transient': { code: '4.2.2', touchId: SUBJECT },
  'contact.bounce_cleared': { code: '5.1.1' },
  'contact.bounce_unmatched': { why: 'recipient_mismatch', code: '5.1.1', permanent: true, touchId: SUBJECT },
  'campaign.auto_paused': { bouncePct: 12, threshold: 5, sentTo: 25, bounced: 3 },
  'contact.unsubscribed': { contactId: SUBJECT, touchId: SUBJECT, addresses: 1, paused: true, cancelledQueued: 0 },
  'unsubscribe.not_recorded': { touchId: SUBJECT, contactId: SUBJECT, why: 'Error', paused: true, cancelledQueued: 0 },
  'contact.exported': { contactId: SUBJECT },
  'contact.erased': { touchesScrubbed: 4, callsScrubbed: 1, suppressionsAdded: 2, suppressedRecipients: { [SUBJECT]: OTHER_USER } },
  'contact.erasure_failed': { why: 'unreadable_phone', paused: true },
  'connector.tools_disabled': {
    name: 'zapier', tools: ['send_email'], before: { source: 'catalog', tools: [], everyTool: true },
  },
  'cron.digest': {
    posted: false,
    why: 'no_slack',
    counts: {
      pendingApprovals: 2, unhandledReplies: 1, rottingDeals: 0, staleCompanies: 3, neverScanned: 1, dueTasks: 0,
      overdueTasks: 0, refusals24h: 1, refusalsByCode: { quiet_hours: 1 }, optOutsNotRecorded24h: 0, spend24hUsd: '0.12',
    },
    worker: 'live',
    workerAlert: 'not_needed',
    campaignPauses: { found: 1, posted: 0, readThrough: { at: '2026-09-30T06:40:12.123456Z', id: SUBJECT } },
  },
}

describe('sentenceFor', () => {
  it('has a sentence for every action a writer in this tree produces', () => {
    const missing = Object.keys(WRITTEN).filter((a) => !AUDIT_ACTIONS.includes(a))
    expect(missing).toEqual([])
  })

  it('has a sentence for every tool in core’s registry, including the ones added later', () => {
    const missing = AGENCY_TOOL_NAMES.map((n) => `agent.${n}`).filter((a) => !AUDIT_ACTIONS.includes(a))
    expect(missing).toEqual([])
    expect(sentenceFor(line('agent.get_replies', {}, { actor: 'agent' }), lookups)).toBe('ran get_replies, which only reads')
    expect(sentenceFor(line('agent.add_note', {}, { actor: 'agent' }), lookups)).toBe(
      'ran add_note, which writes inside this system; nothing was sent',
    )
    // A tool with its own sentence keeps it.
    expect(sentenceFor(line('agent.check_send', WRITTEN['agent.check_send'], { actor: 'agent' }), lookups)).toBe(
      'checked whether a message about rentman.io may be sent: it may; nothing was queued',
    )
  })

  it('does not invent a company for a row that has none', () => {
    expect(sentenceFor(line('task.created', { kind: 'follow_up', companyId: null }), {})).toBe('created a task')
    expect(sentenceFor(line('task.created', WRITTEN['task.created']), lookups)).toBe('created a task for rentman.io')
    expect(sentenceFor(line('export.companies', WRITTEN['export.companies']), {})).toBe(
      'downloaded the companies as CSV (42 rows)',
    )
    expect(sentenceFor(line('meeting.outcome_recorded', {}), lookups)).toBe(
      'recorded an outcome for the meeting with rentman.io',
    )
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

  /**
   * A pause reason can hold a teammate's address and the contact's words, and
   * this log is append-only. Both writers record the reason's CLASS, and the
   * sentence reads only that — the free-text `hadReason` the contacts route
   * wrote before is never rendered, and that route no longer writes it.
   */
  it('says what paused a resumed contact by its class, and never reads the reason text', () => {
    expect(sentenceFor(line('contact.resumed', WRITTEN['contact.resumed']), lookups)).toBe(
      'resumed a contact at rentman.io who had been paused by their reply, to answer their reply',
    )
    const free = sentenceFor(line('contact.resumed', { hadReason: 'Jane said stop calling (by sam@agency.test)' }), lookups)
    expect(free).toBe('resumed a contact at rentman.io')
    expect(sentenceFor(line('contact.resumed', { pausedFor: 'constructor' }), lookups)).toBe('resumed a contact at rentman.io')
    const route = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/app/api/contacts/[id]/route.ts'), 'utf8')
    expect(route).toContain('pausedFor: pauseReasonClass(contact.pausedReason)')
    expect(route).not.toContain('hadReason')
  })

  it('says when a reclassification paused somebody and cancelled what was queued', () => {
    expect(sentenceFor(line('reply.reclassified', WRITTEN['reply.reclassified']), lookups)).toBe(
      'reclassified a reply from a contact at rentman.io from auto reply to interested: paused them in every campaign; cancelled 1 queued',
    )
    expect(sentenceFor(line('reply.reclassified', { from: 'other', to: 'not_now', paused: false, cancelledQueued: 0 }), lookups)).toBe(
      'reclassified a reply from a contact at rentman.io from other to not now',
    )
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

  it('says the newer writers’ facts, including the ones word() could not read', () => {
    const say = (action: string, detail: unknown = WRITTEN[action], actor = 'system'): string =>
      sentenceFor(line(action, detail, { actor }), lookups)
    // An RFC 3463 status starts with a digit, so the enum reader dropped it from every bounce line.
    expect(say('contact.bounced')).toBe(
      'recorded a hard bounce (5.1.1) for a contact at rentman.io; email to that address stops until it is corrected, and 1 queued was cancelled',
    )
    expect(say('contact.bounce_transient')).toBe(
      'recorded a temporary delivery failure (4.2.2) for a contact at rentman.io; nothing was changed',
    )
    expect(say('contact.bounce_unmatched')).toBe(
      'did not act on a delivery report (5.1.1) about a contact at rentman.io: the address it names is not the one that message went to; no contact was changed',
    )
    expect(say('contact.bounced', { code: 'not-a-status' })).not.toContain('not-a-status')
    expect(say('send.bounced')).toBe('refused an email to a contact at rentman.io: address bounced; nothing was sent')
    expect(say('send.stale_evidence')).toBe(
      'refused an email to a contact at rentman.io: the evidence it quotes is stale; nothing was sent',
    )
    expect(say('campaign.auto_paused')).toBe(
      'paused a campaign automatically: 12% of the addresses it wrote to bounced (3 of 25; the limit is 5%); a person re-activates it',
    )
    // advanceDeal records { from, to }; POST /api/deals records { stage }. Both read.
    expect(say('deal.advanced', { companyId: SUBJECT, from: 'contacted', to: 'replied' })).toBe(
      'moved rentman.io forward from contacted to replied',
    )
    expect(say('deal.advanced', { companyId: SUBJECT, stage: 'replied' })).toBe('moved rentman.io forward to replied')
    expect(say('deal.created', { companyId: SUBJECT, from: null, to: 'contacted' })).toBe('opened a deal for rentman.io at contacted')
    expect(say('proposal.share_created', WRITTEN['proposal.share_created'], ORG_USER)).toBe(
      'created a share link for the proposal for rentman.io, open until 2026-10-14 (when its evidence ages out); nothing was sent',
    )
    expect(say('linkedin.not_sent', WRITTEN['linkedin.not_sent'], ORG_USER)).toBe(
      'said the LinkedIn message for a contact at rentman.io was not sent; it is recorded as failed',
    )
    expect(say('agent.classify_reply', WRITTEN['agent.classify_reply'], 'agent')).toBe(
      'recorded a reply as interested (it was other); marked it handled; nothing was sent',
    )
    expect(say('agent.classify_reply', { touchId: SUBJECT, kind: null, from: null, handled: true }, 'agent')).toBe(
      'marked a reply handled; nothing was sent',
    )
    // A catalog server's send tools are off before any owner chose anything.
    const disabled = say('agent.tool_disabled', WRITTEN['agent.tool_disabled'], 'agent')
    expect(disabled).toBe(
      'was refused mcp__zapier__send_email: it is turned off in Settings → Connectors, so nobody was asked',
    )
    expect(disabled).not.toContain('owner')
    expect(say('cron.digest')).toBe(
      'built the daily digest and did not post it: no Slack webhook is configured; a campaign paused itself and got no notice of its own — /campaigns lists it',
    )
    expect(say('cron.digest', { posted: true, counts: {}, worker: 'silent', workerAlert: 'posted' })).toBe(
      'posted the daily digest to Slack; the worker was silent, and a separate alert was posted',
    )
    expect(say('cron.digest', { posted: false, why: 'slack_failed', worker: 'silent', workerAlert: 'failed' })).toBe(
      'built the daily digest and did not post it: Slack did not accept it; the worker was silent, and the alert could NOT be posted',
    )
  })

  /**
   * `found > posted` is a pause that got no Slack notice of its own — past
   * the cap, a refused post, or no Slack. It lived only in the raw detail
   * behind <details>; the sentence says it, as a count and where to look.
   */
  it('says how many campaign pauses got no notice of their own, and none when every one did', () => {
    const digest = (found: number, posted: number): string =>
      sentenceFor(line('cron.digest', {
        posted: true, worker: 'live', workerAlert: 'not_needed',
        campaignPauses: { found, posted, readThrough: { at: '2026-09-30T06:40:12.123456Z', id: SUBJECT } },
      }, { actor: 'system' }), lookups)
    expect(digest(5, 3)).toBe('posted the daily digest to Slack; 5 campaigns paused themselves and 2 got no notice of their own — /campaigns lists them')
    expect(digest(3, 0)).toBe('posted the daily digest to Slack; 3 campaigns paused themselves and none got a notice of its own — /campaigns lists them')
    expect(digest(2, 2)).toBe('posted the daily digest to Slack')
    expect(digest(0, 0)).toBe('posted the daily digest to Slack')
  })

  /** A session somebody ran by hand and closed a week ago is not a worker that went quiet: no alert, and the row says why. */
  it('says a retired worker was not alerted about, and why', () => {
    const retired = line('cron.digest', { posted: true, counts: {}, worker: 'retired', workerAlert: 'not_needed' }, { actor: 'system' })
    expect(sentenceFor(retired, lookups)).toBe(
      'posted the daily digest to Slack; no worker is configured and the last one reported in more than a week ago, so it counts as retired and nobody was alerted',
    )
    expect(isAlarm(retired)).toBe(false)
  })

  /**
   * A note must name a person, so the agent's add_note stores it in the name
   * of the person whose chat it is; this row is the one place that says the
   * agent wrote it, and the sentence has to say both halves.
   */
  it('says a note the agent wrote is in a person’s name, and a teammate’s note plainly', () => {
    expect(sentenceFor(line('note.added', WRITTEN['note.added'], { actor: 'agent' }), lookups)).toBe(
      'wrote a note on rentman.io in the name of Priya; it shows as theirs',
    )
    expect(sentenceFor(line('note.added', { companyId: SUBJECT, noteId: SUBJECT }), lookups)).toBe(
      'added a note on rentman.io',
    )
    const gone = { companyId: SUBJECT, noteId: SUBJECT, authorUserId: GONE_USER }
    const s = sentenceFor(line('note.added', gone, { actor: 'agent' }), lookups)
    expect(s).toBe('wrote a note on rentman.io in the name of a teammate; it shows as theirs')
    expect(s).not.toContain(GONE_USER)
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

  it('does not mistake Object.prototype for the catalogue', () => {
    // A plain `map[key]` answers `constructor` with a function.
    expect(sentenceFor(line('constructor'), lookups)).toBe('constructor')
    expect(sentenceFor(line('toString'), lookups)).toBe('toString')
    expect(sentenceFor(line('draft.approved', { channel: 'constructor' }), lookups)).toBe(
      'approved a draft message to a contact at rentman.io',
    )
    expect(sentenceFor(line('suppression.added', { kind: 'hasOwnProperty' }), lookups)).toBe(
      'added a value to the suppression list',
    )
    expect(actorLabel('constructor', new Map())).toEqual({ label: 'constructor', note: null })
    expect(isActorLiteral('constructor')).toBe(false)
    expect(isActorLiteral('booking_page')).toBe(true)
    expect(suppressionSource('constructor')).toEqual({ tag: 'constructor', explain: 'constructor' })
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
    expect(isAlarm(line('unsubscribe.not_recorded', WRITTEN['unsubscribe.not_recorded']))).toBe(true)
    expect(isAlarm(line('contact.erasure_failed', WRITTEN['contact.erasure_failed']))).toBe(true)
    expect(isAlarm(line('deal.moved'))).toBe(false)
  })

  it('raises a silent worker that the daily alert reached nobody about — the worker cannot say it', () => {
    const digest = (workerAlert: string): AuditLine => line('cron.digest', { ...WRITTEN['cron.digest'], workerAlert }, { actor: 'system' })
    expect(isAlarm(digest('failed'))).toBe(true)
    expect(isAlarm(digest('no_slack'))).toBe(true)
    expect(isAlarm(digest('posted'))).toBe(false)
    expect(isAlarm(digest('not_needed'))).toBe(false)
    expect(isAlarm(line('cron.digest', {}))).toBe(false)
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

/**
 * The tree, read. Every `action:` a writer sets and every `audit('…')` a
 * tool or a gate ring calls, as a string literal — including one spread
 * over a ternary on the lines after `action:`. An action built from a
 * template is listed in DYNAMIC with every value it can take, so a new
 * template fails here until somebody says what it expands to.
 */
describe('every writer in the tree', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '../../..')

  const DYNAMIC: Readonly<Record<string, readonly string[]>> = {
    // `advanceDeal`'s outcome, as POST /api/deals records it.
    'deal.${moved.outcome}': ['deal.created', 'deal.advanced', 'deal.unchanged'],
    'linkedin.${args.outcome}': ['linkedin.sent', 'linkedin.not_sent', 'linkedin.dismissed'],
    'proposal.${args.status}': ['proposal.draft', 'proposal.sent', 'proposal.accepted', 'proposal.declined', 'proposal.withdrawn'],
    // Every `SendRefusalCode`: refusal-words.test.ts pins that REFUSAL_WORDS names them all.
    'send.${decision.code}': Object.keys(REFUSAL_WORDS).map((code) => `send.${code}`),
  }

  function sources(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
      }
    }
    for (const top of ['apps', 'packages']) {
      for (const d of readdirSync(join(root, top), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const src = join(root, top, d.name, 'src')
        try {
          walk(src)
        } catch {
          // a workspace with no src/ writes nothing
        }
      }
    }
    return out
  }

  function writtenInTree(): { literal: Map<string, string>; template: Map<string, string> } {
    const literal = new Map<string, string>()
    const template = new Map<string, string>()
    for (const file of sources()) {
      if (file.endsWith(join('lib', 'audit-copy.ts'))) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((l, i) => {
        // A doc comment that says "a whole action: `send` matches …" writes nothing.
        if (/^\s*(\*|\/\/|\/\*)/.test(l)) return
        let text: string
        const at = l.search(/\baction:/)
        if (at >= 0) {
          text = l.slice(at)
          // An action chosen by a ternary runs on until the property's comma.
          for (let j = i + 1; j < Math.min(lines.length, i + 6) && !/[,;{}]\s*$/.test(text.trimEnd()); j++) {
            text += ` ${(lines[j] ?? '').trim()}`
          }
        } else if (/\baudit\(/.test(l)) {
          text = l.slice(l.search(/\baudit\(/))
        } else return
        const where = `${relative(root, file)}:${i + 1}`
        for (const m of text.matchAll(/(['"`])([a-z_]+\.[a-z_]+)\1/g)) literal.set(m[2] ?? '', where)
        for (const m of text.matchAll(/`([a-z_]+\.\$\{[^}`]+\})`/g)) template.set(m[1] ?? '', where)
      })
    }
    return { literal, template }
  }

  const { literal, template } = writtenInTree()
  const expanded = Object.values(DYNAMIC).flat()

  it('reads enough of the tree to mean something', () => {
    // Fewer than this and the scan broke, which would pass everything below.
    expect(literal.size).toBeGreaterThan(120)
    expect(literal.get('contact.opt_out_not_recorded')).toMatch(/^packages\/db\/src\//)
    expect(literal.has('campaign.auto_send_on')).toBe(true) // the ternary on the lines after `action:`
    expect(literal.has('agent.tool_disabled')).toBe(true) // a gate ring's `deps.audit(…)`
  })

  it('knows what every templated action expands to', () => {
    expect([...template.keys()].sort()).toEqual(Object.keys(DYNAMIC).sort())
  })

  it('has a sentence and a detail shape for every action a writer produces', () => {
    const produced = [...literal.keys(), ...expanded]
    expect(produced.filter((a) => !AUDIT_ACTIONS.includes(a)).map((a) => `${a} (${literal.get(a) ?? 'template'})`)).toEqual([])
    expect(produced.filter((a) => !(a in WRITTEN)).map((a) => `${a} (${literal.get(a) ?? 'template'})`)).toEqual([])
  })

  it('pins no detail shape for an action nobody writes', () => {
    const produced = new Set([...literal.keys(), ...expanded])
    expect(Object.keys(WRITTEN).filter((a) => !produced.has(a))).toEqual([])
  })
})
