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

/** What `denyDraft` writes when it puts back the pause a reply caused (`repauseForUnansweredReply`). */
const DENIED_ANSWER_PAUSE: Record<string, unknown> = {
  reason: 'their reply is unanswered again: the answer to it was denied',
  alreadyPaused: false,
  inboundTouchId: SUBJECT,
}

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
  'draft.denied': { note: 'too pushy', refusalCode: 'needs_approval' },
  'draft.edited': { channel: 'email', status: 'approved', subjectChanged: true, bodyChars: { before: 412, after: 380 }, reapprove: true },
  'contact.replied': { channel: 'email', paused: true, cancelledQueued: 2, suppressed: false, deal: 'advanced:replied' },
  // A colleague's stop filed under the contact (review round 7) adds
  // `fromIsContact: false` and `filedUnder` — the contact never as the
  // subject or a `contactId` (FROM_SOMEBODY_ELSE below).
  'contact.opt_out_not_recorded': { touchId: SUBJECT, channel: 'email', why: 'unparseable' },
  'contact.created': { companyId: SUBJECT, source: 'manual', hasTimeZone: true },
  // The contacts route's shape, over a reply's own pause. `denyDraft` writes
  // `{ reason, alreadyPaused, inboundTouchId }` (DENIED_ANSWER_PAUSE below),
  // and an answer that failed, was refused at sending or was cancelled by a
  // bounce `{ reason, alreadyPaused, answerTouchId, answerEnded }`.
  'contact.paused': { reason: 'asked for Q1', alreadyPaused: false, replacedPauseFor: 'replied' },
  // The inbox's shape; `contactResumeByHand` writes `{ pausedFor }` alone.
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
  'reply.suggested': { contactId: SUBJECT, companyId: SUBJECT, model: 'anthropic/claude-haiku-4-5', chars: 412 },
  'reply.suggestion_dismissed': { suggestionId: SUBJECT },
  'reply.suggestion_used': { suggestionId: SUBJECT, answerTouchId: SUBJECT },
  'listing.coordinates_pruned': { companies: 3, olderThanDays: 30 },
  'task.outcome_recorded': { outcome: 'asked_to_stop', kind: 'call', companyId: SUBJECT, callBackTaskId: SUBJECT, suppressed: true },
  'evidence.changed': { scanId: SUBJECT, olderScanId: SUBJECT, fixed: 1, regressed: 2, keys: { fixed: ['csp'], regressed: ['hsts', 'tls'] }, taskId: SUBJECT },
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
  'send.paused': { campaignId: SUBJECT, channel: 'email', code: 'paused' },
  // DoveSoft (0019).
  'send.no_template': { campaignId: SUBJECT, channel: 'sms', code: 'no_template' },
  'send.template_mismatch': { campaignId: SUBJECT, channel: 'sms', code: 'template_mismatch' },
  // Review round 5: a promotional SMS whose band never opens, stored as unknown_timezone before.
  'send.band_never_opens': { campaignId: SUBJECT, channel: 'sms', code: 'band_never_opens' },
  // ICP profiles (0021), and the research connectors an owner lets run without asking.
  'icp.created': { name: 'Security-gap SaaS (India)', basedOn: 'Security-gap SaaS (US/EU)', geos: ['IN'], headcountMin: 10, headcountMax: 500 },
  'icp.activated': { name: 'Security-gap SaaS (India)', previous: 'Security-gap SaaS (US/EU)' },
  'company.listings_added': { added: 12, refreshed: 3 },
  'org.renamed': { from: 'Agency', to: 'Accemy' },
  'org.profile_updated': { fields: ['gstin', 'upiVpa'] },
  'quote.created': { companyId: 'c', number: 'Q-2026-0001', lines: 2, total: 29500 },
  'quote.updated': { fields: ['title'], total: 29500, revisedFromSent: true },
  'quote.sent': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.accepted': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.declined': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.withdrawn': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.accepted_via_share': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.declined_via_share': { companyId: 'c', number: 'Q-2026-0001', total: 29500 },
  'quote.email_drafted': { touchId: 't', number: 'Q-2026-0001' },
  'share_link.created': { kind: 'quote', linkId: 'l', quoteId: 'q', expiresAt: '2026-10-30T00:00:00.000Z' },
  'share_link.revoked': { kind: 'report', linkId: 'l' },
  'share_link.email_drafted': { kind: 'report', touchId: 't' },
  'service.created': { needs: 4, priced: true },
  'service.updated': { fields: ['name', 'priceFrom'] },
  'service.deleted': {},
  'service.suggested_added': { added: 10 },
  'agent.list_icps': { profiles: 2, turnId: SUBJECT },
  'agent.create_icp': { created: true, profileId: SUBJECT, turnId: SUBJECT },
  'agent.activate_icp': { changed: true, turnId: SUBJECT },
  'connector.reads_without_card': { name: 'tavily', on: true },
  // Settings → Assistant (0020): the playbook and the morning brief.
  'assistant.playbook_updated': { chars: 38, before: 0 },
  'assistant.brief_updated': { enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' },
  'assistant.brief_requested': {},
  'assistant.brief_started': { date: '2026-10-07', requested: false },
  'assistant.brief_failed': { date: '2026-10-07', requested: false, why: 'chat_disabled' },
  'agent.tool_unattended': { toolName: 'mcp__agency__add_note', toolUseId: 't1', risk: 'medium', rule: 'writes_internal_state' },
  'template.created': { channel: 'sms', category: 'service_explicit', externalId: '1107160000000012345' },
  'template.activated': { channel: 'sms', externalId: '1107160000000012345' },
  'template.deactivated': { channel: 'sms', externalId: '1107160000000012345' },
  'template.imported': { channel: 'sms', imported: 2, alreadyPresent: 0, skipped: 2, refused: 5 },
  'sms.drafted': { contactId: SUBJECT, campaignId: SUBJECT, templateId: SUBJECT },
  'sms.delivery_unmatched': { why: 'unknown_id', status: 'delivered' },
  'sms.inbound_unmatched': {
    why: 'ambiguous', optOut: true, contacts: 2, suppressed: true, paused: 2, cancelledQueued: 1, messageHash: 'a'.repeat(64),
    replacedPauseFor: 'replied', replacedPauses: 1,
  },
  'sms.dlr_unreadable': { why: 'missing_fields', missing: ['messageid'] },
  'sms.inbound_unreadable': { why: 'missing_fields', missing: ['from', 'text'] },
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

  // --- records.ts tools (2026-10-06): this file's actions go below ---
  // Ids, counts, flags and fixed words only. The rows each tool writes as its
  // route does (company.updated, contact.created, contact.updated,
  // contact.timezone_set, contact.paused, contact.resumed, suppression.added)
  // are above, actor `agent`.
  'agent.list_contacts': { companyId: SUBJECT, returned: 3, more: false, turnId: SUBJECT },
  'agent.add_company': { companyId: SUBJECT, created: true, turnId: SUBJECT },
  'agent.update_company': { companyId: SUBJECT, fields: ['name', 'timeZone'], turnId: SUBJECT },
  'agent.import_companies': { added: 3, alreadyPresent: 1, refused: 1, duplicates: 0, turnId: SUBJECT },
  'agent.add_contact': { contactId: SUBJECT, companyId: SUBJECT, turnId: SUBJECT },
  'agent.update_contact': { contactId: SUBJECT, fields: ['title', 'timeZone'], bounceCleared: false, turnId: SUBJECT },
  'agent.pause_contact': { contactId: SUBJECT, replacedPauseFor: 'replied', turnId: SUBJECT },
  'agent.resume_contact': { contactId: SUBJECT, pausedFor: 'manual', turnId: SUBJECT },
  'agent.add_suppression': {
    suppressionId: SUBJECT, kind: 'email', alreadyPresent: false, contactId: SUBJECT, contactsCovered: 1, turnId: SUBJECT,
  },
  // --- end records.ts ---

  // --- campaigns.ts tools (2026-10-06): this file's actions go below ---
  'agent.list_campaigns': { status: null, matched: 3, returned: 3, turnId: SUBJECT },
  'agent.create_campaign': { campaignId: SUBJECT, channel: 'email', status: 'draft', autoSend: false, turnId: SUBJECT },
  'agent.update_campaign': {
    campaignId: SUBJECT, statusFrom: 'paused', statusTo: 'active', renamed: false, dailyCapChanged: true,
    quietHoursChanged: false, turnId: SUBJECT,
  },
  'agent.enrol_contacts': {
    campaignId: SUBJECT, dryRun: false, queued: 14, skipped: 3, truncated: false, outOfTime: false, limit: 50, turnId: SUBJECT,
  },
  'agent.list_drafts': { total: 4, returned: 4, checked: 3, turnId: SUBJECT },
  'agent.get_draft': { draftId: SUBJECT, status: 'awaiting_approval', turnId: SUBJECT },
  'agent.find_businesses': { returned: 20, withoutWebsite: 7, more: true, failed: true, turnId: SUBJECT },
  'agent.add_businesses': { asked: 5, added: 4, refreshed: 1, missing: 0, turnId: SUBJECT },
  'agent.audit_website': { domain: 'rentman.io', strategy: 'mobile', outcome: 'measured', turnId: SUBJECT },
  'agent.get_opportunities': { companies: 40, needs: 3, matched: 12, returned: 10, turnId: SUBJECT },
  'agent.list_services': { services: 6, turnId: SUBJECT },
  'agent.create_quote': { quoteId: SUBJECT, companyId: SUBJECT, lines: 2, turnId: SUBJECT },
  'agent.get_quote': { quoteId: SUBJECT, turnId: SUBJECT },
  'agent.update_quote': { quoteId: SUBJECT, revisedFromSent: false, turnId: SUBJECT },
  'agent.list_quotes': { count: 3, turnId: SUBJECT },
  'agent.create_share_link': { kind: 'report', companyId: SUBJECT, linkId: SUBJECT, turnId: SUBJECT },
  // The public free website check (2026-10-08).
  'check.requested': { recognised: true, by: 'site_and_address', task: 'made' },
  // A website certificate about to expire (2026-10-08).
  'cert.alerted': { expires: '2026-10-20', daysLeft: 12, taskId: SUBJECT },
  // The night shift (0025).
  'night.updated': { enabled: true, at: '02:00', timeZone: 'Asia/Kolkata' },
  'night.requested': {},
  'night.search_added': { searchId: SUBJECT },
  'night.search_removed': { searchId: SUBJECT },
  'night.search_toggled': { searchId: SUBJECT, active: false },
  'night.searched': { searchId: SUBJECT, returned: 20, added: 6, failed: true },
  'night.ran': {
    date: '2026-10-09', searches: 2, failedSearches: 0, found: 40, added: 11, refreshed: 3, scanned: 6, scanFailed: 1,
    audited: 5, top: [SUBJECT], topNeeds: [['no_website']], why: null,
  },
  'night.failed': { date: '2026-10-09', error: 'ConnectionError' },
  // Follow-up sequences (0024).
  'agent.set_campaign_steps': { campaignId: SUBJECT, steps: 3, turnId: SUBJECT },
  'agent.get_night_finds': { found: 10, turnId: SUBJECT },
  'agent.get_evidence_signals': { sinceDays: 7, returned: 3, turnId: SUBJECT },
  'agent.get_whats_working': { kinds: 4, campaigns: 2, turnId: SUBJECT },
  'campaign.steps_saved': { steps: 3, messages: 1, calls: 1, visits: 1 },
  'sequence.step_taken': { campaignId: SUBJECT, position: 2, kind: 'message', touchId: SUBJECT },
  'sequence.step_skipped': { campaignId: SUBJECT, position: 3, kind: 'call', why: 'invalid' },
  'sequence.stopped': { campaignId: SUBJECT, reason: 'deal_closed', position: 3, returnedTouchId: SUBJECT },
  'agent.edit_draft': { draftId: SUBJECT, edited: true, reapprove: false, reason: 'changed_meanwhile', turnId: SUBJECT },
  // --- end campaigns.ts ---

  // --- proposals.ts tools (2026-10-06): this file's actions go below ---
  'agent.generate_proposal': {
    domain: 'rentman.io', proposalId: SUBJECT, scanId: SUBJECT, workstreams: 2, scopeItems: 4, turnId: SUBJECT,
  },
  'agent.get_proposal': { proposalId: SUBJECT, companyId: SUBJECT, stale: false, superseded: true, turnId: SUBJECT },
  'agent.list_meetings': { days: 14, includePast: true, upcoming: 2, past: 1, turnId: SUBJECT },
  'agent.reschedule_meeting': {
    meetingId: SUBJECT, replacementId: SUBJECT, startsAt: '2026-09-22T14:00:00.000Z', timeZone: 'Europe/London', turnId: SUBJECT,
  },
  'agent.cancel_meeting': { meetingId: SUBJECT, companyId: SUBJECT, turnId: SUBJECT },
  'agent.record_meeting_outcome': { meetingId: SUBJECT, companyId: SUBJECT, outcome: 'no_show', previous: 'held', turnId: SUBJECT },
  'agent.set_deal_owner': { dealId: SUBJECT, companyId: SUBJECT, ownerUserId: OTHER_USER, previousOwnerUserId: null, turnId: SUBJECT },
  'agent.complete_task': { taskId: SUBJECT, companyId: SUBJECT, alreadyDone: false, outcome: 'call_back', callBackTaskId: SUBJECT, suppressed: false, turnId: SUBJECT },
  // --- end proposals.ts ---

  // --- ops.ts tools (2026-10-06): this file's actions go below ---
  'agent.worker_status': { status: 'live', schema: 'ok', ownView: true, turnId: SUBJECT },
  'agent.recent_errors': { returned: 3, kinds: 5, ownView: true, turnId: SUBJECT },
  'agent.queue_status': {
    awaiting: 3, approved: 4, queued: 1, sending: 1, refused: 3, failed: 1, agentApprovals: 2, linkedinSteps: 1,
    smsWithoutProvider: 1, emailWithoutProvider: 0, ownView: true, turnId: SUBJECT,
  },
  'agent.rescan_stale': {
    scanned: 3, reached: 2, unreachable: 1, abandoned: 0, failed: 0, stillRunning: 0, skipped: 1, remaining: 4,
    companyIds: [SUBJECT],
    cronRunning: false, turnId: SUBJECT,
  },
  // --- end ops.ts ---
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
   * The /contacts resume's row is written by `contactResumeByHand`, in the
   * resume's own transaction (review round 4), so the pin follows it there.
   */
  it('says what paused a resumed contact by its class, and never reads the reason text', () => {
    expect(sentenceFor(line('contact.resumed', WRITTEN['contact.resumed']), lookups)).toBe(
      'resumed a contact at rentman.io who had been paused by their reply, to answer their reply',
    )
    const free = sentenceFor(line('contact.resumed', { hadReason: 'Jane said stop calling (by sam@agency.test)' }), lookups)
    expect(free).toBe('resumed a contact at rentman.io')
    expect(sentenceFor(line('contact.resumed', { pausedFor: 'constructor' }), lookups)).toBe('resumed a contact at rentman.io')
    const here = dirname(fileURLToPath(import.meta.url))
    const route = readFileSync(resolve(here, '../src/app/api/contacts/[id]/route.ts'), 'utf8')
    expect(route).not.toContain('hadReason')
    expect(route).not.toContain("action: 'contact.resumed'")
    const inbox = readFileSync(resolve(here, '../../../packages/db/src/inbox.ts'), 'utf8')
    const byHand = inbox.slice(inbox.indexOf('export async function contactResumeByHand('))
    expect(byHand.slice(0, byHand.indexOf('\n}\n'))).toContain('detail: { pausedFor: pauseReasonClass(contact.pausedReason) }')
    expect(inbox).not.toContain('hadReason')
  })

  /**
   * Review round 5, [12]. A stuck-send recovery puts a reply's pause back
   * over an answer it could not tell went — "the answer to it failed to
   * send" — and `dispatchTouch` lifts that pause when the provider had taken
   * the answer after all. The lift says why, beside the recovery's row it
   * corrects, and never quotes the reason's text.
   */
  it('says a reply’s pause was lifted because the answer to it went after all', () => {
    const detail = { reason: 'the answer to their reply went after all', pausedFor: 'replied', answerTouchId: SUBJECT }
    expect(sentenceFor(line('contact.resumed', detail, { actor: 'system' }), lookups)).toBe(
      'resumed a contact at rentman.io who had been paused by their reply, because the answer to it went after all',
    )
    const outreach = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/src/outreach.ts'), 'utf8')
    expect(outreach).toContain("detail: { reason: 'the answer to their reply went after all', pausedFor: pauseReasonClass(reason), answerTouchId: answer.id }")
  })

  /**
   * `denyDraft` records `stale_evidence` for words that quoted an AGED scan
   * and for words a newer scan SUPERSEDED, and its detail does not say
   * which. "A re-scan lets it be drafted again" is false of the second —
   * the re-scan happened, and re-enrolment drafts again straight away — so
   * the sentence says what is true of both.
   */
  it('words a deny on stale evidence so it is true whether the scan aged or was superseded', () => {
    const s = sentenceFor(line('draft.denied', { note: 'denied', refusalCode: 'stale_evidence' }), lookups)
    expect(s).toBe('denied a draft about rentman.io (its evidence was stale — it can be drafted again from a current scan): “denied”')
    expect(s).not.toContain('re-scan')
    const writer = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/src/outreach.ts'), 'utf8')
    expect(writer).toContain('detail: { note: row.decisionNote, refusalCode: row.refusalCode }')
  })

  /**
   * Two writers pause a contact with something to add. The contacts route,
   * over a reply's own pause, replaces it (`replacedPauseFor: 'replied'`) —
   * so answering the reply no longer resumes them. And `denyDraft`, when the
   * answer that lifted a reply's pause is denied, puts it back
   * (`inboundTouchId`). Both said only "paused a contact".
   */
  it('says when a pause replaced the one a reply caused, and when a denied answer put it back', () => {
    expect(sentenceFor(line('contact.paused', WRITTEN['contact.paused']), lookups)).toBe(
      'paused a contact at rentman.io: “asked for Q1”, replacing the pause their reply caused',
    )
    expect(sentenceFor(line('contact.paused', DENIED_ANSWER_PAUSE), lookups)).toBe(
      'paused a contact at rentman.io — the answer to their reply was denied',
    )
    // Only a reply's pause is named: a class nobody writes here says nothing.
    expect(sentenceFor(line('contact.paused', { reason: 'asked for Q1', replacedPauseFor: 'manual' }), lookups)).toBe(
      'paused a contact at rentman.io: “asked for Q1”',
    )
    expect(sentenceFor(line('contact.paused', { reason: 'asked for Q1', alreadyPaused: false }), lookups)).toBe(
      'paused a contact at rentman.io: “asked for Q1”',
    )
    const here = dirname(fileURLToPath(import.meta.url))
    const route = readFileSync(resolve(here, '../src/app/api/contacts/[id]/route.ts'), 'utf8')
    expect(route).toContain('replacedPauseFor: r.replaced')
    const outreach = readFileSync(resolve(here, '../../../packages/db/src/outreach.ts'), 'utf8')
    expect(outreach).toContain(`reason: '${String(DENIED_ANSWER_PAUSE.reason)}'`)
    expect(outreach).toContain('inboundTouchId: answer.answersTouchId')
  })

  /**
   * Review round 4, [0]: an answer that never goes puts the reply's pause
   * back, and the row says how it ended — never the deny's sentence, which
   * `inboundTouchId` selects, so these rows name the ANSWER instead.
   */
  it('says why a reply’s pause came back when the answer to it failed, was refused or was cancelled', () => {
    const outreach = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/src/outreach.ts'), 'utf8')
    for (const [ended, reason] of [
      ['failed', 'their reply is unanswered again: the answer to it failed to send'],
      ['refused', 'their reply is unanswered again: the answer to it was refused at sending'],
      ['bounced', 'their reply is unanswered again: the answer to it was cancelled by a bounce'],
    ] as const) {
      expect(outreach).toContain(`${ended}: '${reason}'`)
      expect(reason.length).toBeLessThanOrEqual(80)
      const detail = { reason, alreadyPaused: false, answerTouchId: SUBJECT, answerEnded: ended }
      expect(sentenceFor(line('contact.paused', detail), lookups)).toBe(`paused a contact at rentman.io: “${reason}”`)
    }
  })

  it('says when a reclassification paused somebody and cancelled what was queued', () => {
    expect(sentenceFor(line('reply.reclassified', WRITTEN['reply.reclassified']), lookups)).toBe(
      'reclassified a reply from a contact at rentman.io from auto reply to interested: paused them in every campaign; cancelled 1 queued',
    )
    expect(sentenceFor(line('reply.reclassified', { from: 'other', to: 'not_now', paused: false, cancelledQueued: 0 }), lookups)).toBe(
      'reclassified a reply from a contact at rentman.io from other to not now',
    )
  })

  it('says what the playbook and the morning brief did, by counts and settings alone (0020)', () => {
    const say = (a: string, d: unknown = WRITTEN[a], actor = ORG_USER) => sentenceFor(line(a, d, { actor }), lookups)
    expect(say('assistant.playbook_updated')).toBe(
      'saved the agency playbook the AI reads with every message — 38 characters, its first version',
    )
    expect(say('assistant.playbook_updated', { chars: 1200, before: 38 })).toBe(
      'saved the agency playbook the AI reads with every message — 1,200 characters, was 38',
    )
    expect(say('assistant.playbook_updated', { chars: 0, before: 1200 })).toBe(
      'cleared the agency playbook the AI reads (it was 1,200 characters)',
    )
    expect(say('assistant.brief_updated')).toBe(
      'switched the morning brief on, every day at 08:30 (Asia/Kolkata), running in their name',
    )
    expect(say('assistant.brief_updated', { enabled: false, at: '08:30', timeZone: 'Asia/Kolkata' })).toBe(
      'switched the morning brief off',
    )
    expect(say('assistant.brief_requested')).toBe('asked for a morning brief now; the worker starts it at its next look')
    expect(say('assistant.brief_started', WRITTEN['assistant.brief_started'], 'system')).toBe(
      'started the morning brief for 2026-10-07; it only reads and scans',
    )
    expect(say('assistant.brief_started', { date: '2026-10-07', requested: true }, 'system')).toBe(
      'started the morning brief for 2026-10-07, as asked; it only reads and scans',
    )
    expect(say('assistant.brief_failed', WRITTEN['assistant.brief_failed'], 'system')).toBe(
      'could not start the morning brief for 2026-10-07 — the worker has chat off, and the brief needs its model; that day is spent, and it runs again the next',
    )
    expect(say('agent.tool_unattended', WRITTEN['agent.tool_unattended'], 'agent')).toBe(
      'was declined mcp__agency__add_note in the morning brief: a run nobody is watching may only read and scan, so it was left as a next step for a person',
    )
    // A playbook's words never reach the log, so nothing here can quote them.
    expect(JSON.stringify(WRITTEN['assistant.playbook_updated'])).not.toMatch(/[a-z]{4,}\s/i)
  })

  it('says what a profile and a research connector’s switch did (0021)', () => {
    const say = (a: string, d: unknown = WRITTEN[a], actor = 'agent') => sentenceFor(line(a, d, { actor }), lookups)
    expect(say('icp.created')).toBe(
      'created the ICP profile “Security-gap SaaS (India)” from “Security-gap SaaS (US/EU)”: markets IN; 10–500 staff; it is inactive until somebody activates it',
    )
    expect(say('icp.activated')).toBe(
      'made the ICP profile “Security-gap SaaS (India)” the active one (it was “Security-gap SaaS (US/EU)”); every later scan is scored under it',
    )
    expect(say('connector.reads_without_card', WRITTEN['connector.reads_without_card'], ORG_USER)).toBe(
      'let the connector “tavily” run without asking — it only searches and reads, and every call is still recorded here',
    )
    expect(say('connector.reads_without_card', { name: 'tavily', on: false }, ORG_USER)).toBe(
      'set the connector “tavily” to ask a person on every call again',
    )
    expect(say('agent.tool_allow', { toolName: 'mcp__tavily__tavily_search', toolUseId: 't1', risk: 'high', rule: 'connector_read' })).toBe(
      'ran mcp__tavily__tavily_search without asking — a research connector that only searches and reads, which an owner set to run without asking',
    )
  })

  it('says an internal write ran at once because it changes only the agency’s records, not that it is low risk', () => {
    const say = (d: unknown) => sentenceFor(line('agent.tool_allow', d, { actor: 'agent' }), lookups)
    expect(say(WRITTEN['agent.tool_allow'])).toBe('ran get_icp without asking — it is low risk')
    expect(say({ toolName: 'mcp__agency__add_note', toolUseId: 't1', risk: 'medium', rule: 'writes_internal_state' })).toBe(
      "ran mcp__agency__add_note without asking — it changes only the agency's own records, and sends nothing",
    )
  })

  it('says what a template and an SMS row did, by ids and counts alone (0019)', () => {
    const say = (a: string, d: unknown = WRITTEN[a]) => sentenceFor(line(a, d), lookups)
    expect(say('template.created')).toBe('recorded an SMS template (1107160000000012345), service explicit')
    expect(say('template.deactivated')).toBe(
      'switched off an SMS template (1107160000000012345); a draft written from it is refused at sending',
    )
    expect(say('template.activated', { channel: 'whatsapp', externalId: 'meeting_reminder' })).toBe(
      'switched a WhatsApp template back on (meeting_reminder); messages can be drafted from it again',
    )
    expect(say('template.imported')).toBe('imported templates from a DLT export: 2 added; 2 skipped; 5 refused')
    expect(say('sms.drafted')).toBe(
      'drafted an SMS to a contact at rentman.io from a registered template; it waits for approval and nothing was sent',
    )
    expect(say('send.template_mismatch')).toBe(
      'refused an SMS to a contact at rentman.io: not its registered template; nothing was sent',
    )
    expect(say('sms.inbound_unmatched')).toBe(
      'received a text from a number more than one contact has, so it was filed under nobody; both contacts holding the number were paused and 1 queued message cancelled; the hold replaced the pause a reply had caused for 1 of them; it asked to stop, and the number was put on the suppression list',
    )
    expect(say('sms.inbound_unmatched', { why: 'ambiguous', paused: 1, cancelledQueued: 0 })).toBe(
      'received a text from a number more than one contact has, so it was filed under nobody; a contact holding the number was paused',
    )
    expect(say('sms.inbound_unmatched', { why: 'no_contact', optOut: true, suppressed: false })).toContain('NOT on the suppression list')
    expect(say('sms.delivery_unmatched')).toBe('received a delivery report for an SMS this system did not send; nothing was changed')
  })

  /**
   * A STOP from a number that could not be read writes no suppression, and
   * its row used to carry no `suppressed` key — which the sentence read as
   * "the number was put on the suppression list". A suppression is claimed
   * only where the row says `suppressed: true`, and the row is an alarm
   * otherwise.
   */
  it('claims a suppression for an unplaced SMS STOP only where the row says one was written', () => {
    const say = (d: unknown) => sentenceFor(line('sms.inbound_unmatched', d, { actor: 'system' }), lookups)
    const NOT = 'received a text from a number that could not be read, so it was filed under nobody; it asked to stop, and the number is NOT on the suppression list — follow up by hand'
    // As sms.ts writes it now, and as it wrote it before r5 (no key).
    expect(say({ why: 'unreadable_number', optOut: true, suppressed: false })).toBe(NOT)
    expect(say({ why: 'unreadable_number', optOut: true })).toBe(NOT)
    expect(say({ why: 'unreadable_number', optOut: false })).toBe('received a text from a number that could not be read, so it was filed under nobody')
    expect(say(WRITTEN['sms.inbound_unmatched'])).toContain('the number was put on the suppression list')
    const alarm = (d: Record<string, unknown>) => isAlarm(line('sms.inbound_unmatched', d, { actor: 'system' }))
    expect(alarm({ why: 'unreadable_number', optOut: true, suppressed: false })).toBe(true)
    expect(alarm({ why: 'unreadable_number', optOut: true })).toBe(true)
    expect(alarm({ why: 'no_contact', optOut: true, contacts: 0, suppressed: false })).toBe(true)
    expect(alarm(WRITTEN['sms.inbound_unmatched']!)).toBe(false)
    expect(alarm({ why: 'no_contact', optOut: false, contacts: 0 })).toBe(false)
  })

  /**
   * Review round 6, finding [21]. The held clause said nothing when every
   * holder was already paused although their messages were cancelled; it
   * called one of several "the contact holding the number"; and the row a
   * text filed under a contact leaves in ANOTHER org read "filed under
   * nobody". Each writer's row is worded for what it did.
   */
  describe('a text from a shared number (sms.inbound_unmatched)', () => {
    const say = (d: Record<string, unknown>) => sentenceFor(line('sms.inbound_unmatched', d, { actor: 'system' }), lookups)
    const NOBODY = 'received a text from a number more than one contact has, so it was filed under nobody'

    it('says what was cancelled when every holder was already paused', () => {
      expect(say({ why: 'ambiguous', optOut: false, contacts: 2, paused: 0, cancelledQueued: 3 })).toBe(
        `${NOBODY}; 3 queued messages to the contacts holding the number were cancelled (already paused, so not paused again)`,
      )
      expect(say({ why: 'ambiguous', optOut: false, contacts: 2, paused: 0, cancelledQueued: 0 })).toBe(NOBODY)
    })

    it('words one of several as one OF them', () => {
      expect(say({ why: 'ambiguous', optOut: false, contacts: 2, paused: 1, cancelledQueued: 0 })).toBe(
        `${NOBODY}; 1 of the 2 contacts holding the number was paused`,
      )
      expect(say({ why: 'ambiguous', optOut: false, contacts: 3, paused: 3, cancelledQueued: 2 })).toBe(
        `${NOBODY}; all 3 contacts holding the number were paused and 2 queued messages cancelled`,
      )
      expect(say({ why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 0 })).toBe(
        'received a text from a number more than one contact has, so it was filed under nobody; the contact holding the number was paused',
      )
    })

    it('says a text filed under a contact in another organisation was filed there, never under nobody', () => {
      const elsewhere = say({
        why: 'ambiguous', optOut: true, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_org', suppressed: true,
      })
      expect(elsewhere).toBe(
        'received a text from a number a contact here holds, and filed it under a contact in another organisation that this system had texted; the contact here holding it was paused and 1 queued message cancelled; it asked to stop, and the number was put on the suppression list',
      )
      expect(elsewhere).not.toContain('filed under nobody')
      expect(say({ why: 'ambiguous', optOut: true, contacts: 2, filedUnder: 'another_org', suppressed: false, paused: 0, cancelledQueued: 0 })).toBe(
        'received a text from a number 2 contacts here hold, and filed it under a contact in another organisation that this system had texted; it asked to stop, and the number is NOT on the suppression list — follow up by hand',
      )
      expect(isAlarm(line('sms.inbound_unmatched', { optOut: true, filedUnder: 'another_org', suppressed: false }, { actor: 'system' }))).toBe(true)
    })

    /** Review round 7, [2]: a reply's pause the hold replaced, so answering that reply no longer lifts the hold. */
    it('says the hold replaced the pause a holder’s reply had caused, and nothing when it replaced none', () => {
      expect(say({ why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 0, filedUnder: 'another_contact', replacedPauseFor: 'replied', replacedPauses: 1 })).toBe(
        'received a text from a number more than one contact here holds, and filed it under the one this system had texted; the other contact holding it was paused; the hold replaced the pause their reply had caused',
      )
      expect(say({ why: 'ambiguous', optOut: false, contacts: 3, paused: 3, cancelledQueued: 0, replacedPauseFor: 'replied', replacedPauses: 2 })).toBe(
        `${NOBODY}; all 3 contacts holding the number were paused; the hold replaced the pause a reply had caused for 2 of them`,
      )
      expect(say({ why: 'ambiguous', optOut: false, contacts: 2, paused: 1, cancelledQueued: 0 })).not.toContain('replaced')
      expect(say({ why: 'ambiguous', optOut: false, contacts: 2, paused: 1, cancelledQueued: 0, replacedPauseFor: 'manual', replacedPauses: 1 })).not.toContain('replaced')
    })

    it('says a twin in the same org was held beside the contact it was filed under', () => {
      expect(say({ why: 'ambiguous', optOut: false, contacts: 1, paused: 1, cancelledQueued: 1, filedUnder: 'another_contact' })).toBe(
        'received a text from a number more than one contact here holds, and filed it under the one this system had texted; the other contact holding it was paused and 1 queued message cancelled',
      )
    })

    it('says a redelivery paused nobody again, and what it wrote', () => {
      expect(say({ why: 'ambiguous', optOut: true, contacts: 1, redelivered: true, suppressed: true, messageHash: 'b'.repeat(64) })).toBe(
        'received again a text from a number more than one contact has, which it had filed under nobody; nobody was paused again; it asked to stop, and the number was put on the suppression list',
      )
      expect(say({ why: 'ambiguous', optOut: true, contacts: 1, filedUnder: 'another_org', redelivered: true, suppressed: true })).toBe(
        'received again a text from a number a contact here holds, which it had filed under a contact in another organisation; it asked to stop, and the number was put on the suppression list',
      )
    })

    it('never shows the message hash', () => {
      expect(say(WRITTEN['sms.inbound_unmatched']!)).not.toContain('aaaa')
    })

    /**
     * Review round 8, [0]: a delivery that finds the number suppressed eases
     * the holders an earlier, faulted delivery of the STOP left held hard —
     * on every writer's row, the filed org's redelivery included, which had
     * no row of its own before.
     */
    it('says how many holders held hard while the opt-out was not recorded were eased, on every writer’s row', () => {
      const EASED_ONE = '; a contact here held while the opt-out was not recorded is now held as anyone sharing the number is, which Resume lifts'
      const STOPPED = '; it asked to stop, and the number was put on the suppression list'
      expect(say({ why: 'ambiguous', optOut: true, contacts: 1, released: 1, filedUnder: 'another_contact', redelivered: true, suppressed: true })).toBe(
        `received again a text from a number more than one contact here holds, which it had filed under one of them${STOPPED}${EASED_ONE}`,
      )
      expect(say({ why: 'ambiguous', optOut: true, contacts: 1, paused: 0, cancelledQueued: 0, released: 1, filedUnder: 'another_contact', suppressed: true })).toBe(
        `received a text from a number more than one contact here holds, and filed it under the one this system had texted${STOPPED}${EASED_ONE}`,
      )
      expect(say({ why: 'ambiguous', optOut: true, contacts: 2, released: 2, filedUnder: 'another_org', redelivered: true, suppressed: true })).toBe(
        'received again a text from a number 2 contacts here hold, which it had filed under a contact in another organisation' +
          `${STOPPED}; 2 contacts here held while the opt-out was not recorded are now held as anyone sharing the number is, which Resume lifts`,
      )
      expect(say({ why: 'ambiguous', optOut: true, contacts: 2, released: 2, redelivered: true, suppressed: true, messageHash: 'b'.repeat(64) })).toContain(
        'nobody was paused again; it asked to stop, and the number was put on the suppression list; 2 contacts here held',
      )
      // Nothing eased, nothing said; and a row that eased somebody is not an alarm.
      expect(say({ why: 'ambiguous', optOut: true, contacts: 1, filedUnder: 'another_contact', suppressed: true, released: 0 })).not.toContain('held while')
      expect(isAlarm(line('sms.inbound_unmatched', { optOut: true, released: 1, suppressed: true }, { actor: 'system' }))).toBe(false)
    })
  })

  /**
   * An SMS STOP nobody could place has no contact: no subject, no
   * `contactId`. "A contact at an unknown company" sent the person following
   * up to look for somebody who does not exist.
   */
  it('words an opt-out not recorded from a number no single contact holds, without inventing a contact', () => {
    const unplaced = (d: Record<string, unknown>) =>
      sentenceFor(line('contact.opt_out_not_recorded', d, { actor: 'system' }), {})
    expect(unplaced({ channel: 'sms', why: 'unparseable_number' })).toBe(
      'could not record an opt-out texted from a number no single contact holds (the number could not be read) — ' +
        "it is NOT on the suppression list; read the number from the provider's inbound log and record it by hand",
    )
    // An error's class name says nothing a person can act on.
    expect(unplaced({ channel: 'sms', why: 'DrizzleQueryError' })).toBe(
      'could not record an opt-out texted from a number no single contact holds — ' +
        "it is NOT on the suppression list; read the number from the provider's inbound log and record it by hand",
    )
    for (const d of [{ channel: 'sms', why: 'unparseable_number' }, { channel: 'sms', why: 'record_failed' }]) {
      expect(unplaced(d)).not.toContain('a contact at')
      expect(isAlarm(line('contact.opt_out_not_recorded', d, { actor: 'system' }))).toBe(true)
    }
    // Filed under a contact, it still names where they work.
    expect(
      sentenceFor(line('contact.opt_out_not_recorded', { channel: 'sms', why: 'Error' }, { subjectType: 'contact', subjectId: SUBJECT }), lookups),
    ).toBe('could not record an opt-out from a contact at rentman.io — it is NOT on the suppression list; follow up by hand')
    expect(sentenceFor(line('contact.opt_out_not_recorded', WRITTEN['contact.opt_out_not_recorded']), lookups)).toContain(
      'from a contact at rentman.io',
    )
  })

  /**
   * Review round 5, [14]. The DoveSoft route writes `{ channel: 'sms', why:
   * 'record_failed' }` whenever recording a STOP THREW — most often inside
   * the one matched contact's `recordInboundReply`, which rolled back. The
   * writer never learned whose number it was, and /audit said it came "from
   * a number no single contact holds", so the person following up recorded
   * a bare suppression and never looked for the contact, who stayed neither
   * paused nor suppressed. It says whose number it was is not known, and
   * that the contact who holds it is to be paused as well.
   *
   * Review round 7, [8]: nor can the writer know that NOTHING was written.
   * A redelivery of a STOP already recorded, or a shared number held in one
   * org before another threw, reached this row, and "it is NOT on the
   * suppression list and nobody was paused" sent the person to record and
   * pause what was done already. It says to check first now.
   */
  it('words a STOP whose recording failed as not known to be anybody’s, and says to check before recording', () => {
    const failed = sentenceFor(line('contact.opt_out_not_recorded', { channel: 'sms', why: 'record_failed' }, { actor: 'system' }), {})
    expect(failed).toBe(
      'could not record an opt-out texted in: recording the text failed, so whose number it was is not known, and part of ' +
        'it may already be recorded — by an earlier delivery, or by this one before it failed; it may not be on the ' +
        'suppression list. It was refused so DoveSoft retries, but until a retry is recorded, check /suppressions for the ' +
        "number in the provider's inbound log and record it there if it is missing — anybody holding the number may already " +
        'be paused; pause whoever holds it and is not',
    )
    // Nothing the writer cannot know.
    expect(failed).not.toContain('before anything was written')
    expect(failed).not.toContain('nobody was paused')
    expect(failed).not.toContain('it is NOT on the suppression list')
    expect(failed).not.toContain('no single contact holds')
    expect(failed).not.toContain('a contact at')
    expect(isAlarm(line('contact.opt_out_not_recorded', { channel: 'sms', why: 'record_failed' }, { actor: 'system' }))).toBe(true)
    // The other subject-less reasons keep their words: those writers did
    // look, and found no single contact holding a readable number.
    for (const why of ['unparseable_number', 'DrizzleQueryError']) {
      expect(sentenceFor(line('contact.opt_out_not_recorded', { channel: 'sms', why }, { actor: 'system' }), {})).toContain(
        'from a number no single contact holds',
      )
    }
  })

  /**
   * Review round 7, [7]: a colleague replying all to our message asked to
   * stop, and the reply was filed under the contact the message went to.
   * The row names the contact only as `filedUnder` — a row about THEM is
   * what /inbox reads as their own opt-out nobody recorded — and the
   * sentence says whose address to record: the sender's, never the
   * contact's. Two writers: the fault path (`record_failed`, the reply may
   * yet be recorded by a retry) and the recorder's committed loud path (the
   * reply is stored, its sender's suppression refused).
   */
  it('words a stop from somebody other than the contact it was filed under, and says whose address to record', () => {
    const FROM_SOMEBODY_ELSE = { channel: 'email', fromIsContact: false, filedUnder: SUBJECT }
    const say = (d: Record<string, unknown>) =>
      sentenceFor(line('contact.opt_out_not_recorded', d, { actor: 'system', subjectType: 'touch', subjectId: SUBJECT }), lookups)
    expect(say({ ...FROM_SOMEBODY_ELSE, why: 'record_failed' })).toBe(
      'could not record an opt-out from a reply sent by somebody other than the contact at rentman.io it was filed under — ' +
        'recording the reply failed, so the sender may not be on the suppression list: a retry may record it, but check ' +
        '/suppressions for the address the reply came from and record it there if it is missing; the contact is not ' +
        'treated as the one who asked',
    )
    expect(say({ ...FROM_SOMEBODY_ELSE, touchId: SUBJECT, why: 'Error' })).toBe(
      'could not record an opt-out from a reply sent by somebody other than the contact at rentman.io it was filed under — ' +
        'the sender is NOT on the suppression list; read their address from the reply and record it by hand; the ' +
        'contact is not treated as the one who asked',
    )
    // Never the texted-in sentence, even with no subject to name.
    const bare = sentenceFor(line('contact.opt_out_not_recorded', { ...FROM_SOMEBODY_ELSE, why: 'record_failed' }, { actor: 'system' }), {})
    expect(bare).toContain('somebody other than the contact at an unknown company')
    expect(bare).not.toContain('texted')
    // Still an alarm: somebody's opt-out is recorded nowhere.
    expect(isAlarm(line('contact.opt_out_not_recorded', { ...FROM_SOMEBODY_ELSE, why: 'record_failed' }, { actor: 'system' }))).toBe(true)
  })

  /**
   * Review round 8, [0]: the contacts holding a number whose STOP could not
   * be recorded, other than the one it was filed under. Their row was about
   * each of them, as if THEY had asked — the inbox reads that as their own
   * opt-out nobody recorded, however old, and they could never be answered
   * or resumed. One row per org now, about the text, naming them only among
   * its `holders`; the sentence says they are not the one who asked, what
   * holds them, and what ends it.
   */
  it('words the holders of a number whose STOP was not recorded as holders, never as the one who asked', () => {
    const say = (d: Record<string, unknown>, over: Partial<AuditLine> = {}) =>
      sentenceFor(line('contact.opt_out_not_recorded', d, { actor: 'system', ...over }), lookups)
    // A recording that failed is refused whatever the push carried, so its
    // retry comes; a suppression that failed is refused only when the push
    // carried a message id (review round 10, [6]) — without one it is
    // answered 200, and no retry comes to ease anybody.
    const HELD =
      'They are not treated as the one who asked, but are held until it is recorded: Resume is refused until then, and the ' +
      'next text DoveSoft delivers from the number after that — its retry of this one included — makes it an ordinary hold ' +
      'that Resume lifts'
    const HELD_WHERE_ID =
      'They are not treated as the one who asked, but are held until it is recorded: Resume is refused until then, and the ' +
      'next text DoveSoft delivers from the number after that — its retry of this one included, where the push carried a ' +
      'message id — makes it an ordinary hold that Resume lifts'
    expect(say({ channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1, paused: 1, holders: [SUBJECT] })).toBe(
      'could not record an opt-out texted from a number a contact here holds — recording the text failed, so the number may ' +
        'not be on the suppression list; a retry may record it, but check /suppressions for the number on their record and ' +
        `record it there if it is missing. ${HELD}`,
    )
    expect(
      say({ channel: 'sms', why: 'suppression_failed', sharedNumber: true, contacts: 2, paused: 2, holders: [SUBJECT, OTHER_USER] }, {
        subjectType: 'touch', subjectId: SUBJECT,
      }),
    ).toBe(
      'could not record an opt-out texted from a number 2 contacts here hold — the number is NOT on the suppression list; ' +
        `record it by hand on /suppressions, from their record. ${HELD_WHERE_ID}`,
    )
    // A pause that could not be written is said, with what to do.
    expect(say({ channel: 'sms', why: 'Error', sharedNumber: true, contacts: 3, paused: 1 })).toMatch(
      /; only 1 of the 3 could be paused — pause the rest by hand$/,
    )
    expect(say({ channel: 'sms', why: 'Error', sharedNumber: true, contacts: 2, paused: 0 })).toMatch(/; none of them could be paused — pause them by hand$/)
    // A holder whose own pause stood (review round 9) is not eased by a text.
    expect(say({ channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 2, paused: 2, kept: 1 })).toMatch(
      /lifts; 1 of them was already held by a pause of their own, which stands — no text changes it, and Resume lifts it, where Resume may, only once the number is recorded$/,
    )
    expect(say({ channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1, paused: 1, kept: 1 })).toMatch(/lifts; they were already held by a pause of their own/)
    expect(say({ channel: 'sms', why: 'Error', sharedNumber: true, contacts: 2, paused: 2, kept: 2 })).toMatch(/lifts; all of them were already held by a pause of their own/)
    expect(say({ channel: 'sms', why: 'Error', sharedNumber: true, contacts: 3, paused: 2, kept: 2 })).toMatch(
      /lifts; 2 of them were already held by a pause of their own, which stands — .*; only 2 of the 3 could be paused — pause the rest by hand$/,
    )
    // Never the asker's sentence, the subject-less one, or a holder's id.
    const words = say({ channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1, paused: 1, holders: [SUBJECT] })
    expect(words).not.toContain('from a contact at')
    expect(words).not.toContain('no single contact holds')
    expect(words).not.toContain('whose number it was is not known')
    expect(words).not.toContain(SUBJECT)
    // Still an alarm: the number's opt-out is recorded nowhere.
    expect(isAlarm(line('contact.opt_out_not_recorded', { channel: 'sms', why: 'record_failed', sharedNumber: true, contacts: 1 }, { actor: 'system' }))).toBe(true)
  })

  /**
   * DoveSoft's two pushes, when they could not be read: which field was
   * missing, by name — a text nobody could read may have been a STOP, so
   * that row is an alarm.
   */
  it('says what an unreadable DoveSoft push lacked, and never more (0019)', () => {
    const say = (a: string, d: unknown = WRITTEN[a]) => sentenceFor(line(a, d, { actor: 'system' }), lookups)
    expect(say('sms.dlr_unreadable')).toBe(
      'could not read a delivery report DoveSoft sent (no message id); it was refused so DoveSoft retries, and nothing was changed',
    )
    expect(say('sms.inbound_unreadable')).toBe(
      'could not read a text DoveSoft passed on (no sender number or text), so nothing was recorded — it may have asked to stop; ' +
        'it was refused so DoveSoft retries, and the field names it did carry are in the error log',
    )
    expect(say('sms.inbound_unreadable', { why: 'unreadable_body' })).toContain('(the body was not a form or a JSON object)')
    expect(say('sms.inbound_unreadable', { why: 'too_large' })).toContain('(it was larger than the route reads)')
    // An unknown field name is dropped, not echoed.
    expect(say('sms.dlr_unreadable', { why: 'missing_fields', missing: ['secret_thing'] })).toBe(
      'could not read a delivery report DoveSoft sent; it was refused so DoveSoft retries, and nothing was changed',
    )
    expect(isAlarm(line('sms.inbound_unreadable', WRITTEN['sms.inbound_unreadable']))).toBe(true)
    expect(isAlarm(line('sms.dlr_unreadable', WRITTEN['sms.dlr_unreadable']))).toBe(false)
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
    // A pause is not the person's no, and the log does not call it one.
    expect(say('send.paused')).toBe('refused an email to a contact at rentman.io: contact paused; nothing was sent')
    // Review round 5: refused, never "held … retried later", and never a missing timezone.
    expect(say('send.band_never_opens')).toBe(
      'refused an SMS to a contact at rentman.io: promotional band never opens for them; nothing was sent',
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
    expect(sentenceFor(line('draft.denied', { note: 'old scan', refusalCode: 'stale_evidence' }), lookups)).toBe(
      'denied a draft about rentman.io (its evidence was stale — it can be drafted again from a current scan): “old scan”',
    )
    expect(sentenceFor(line('draft.denied', { refusalCode: 'needs_approval' }), lookups)).toBe('denied a draft about rentman.io')
    expect(
      sentenceFor(line('draft.edited', { channel: 'email', subjectChanged: true, reapprove: true }), lookups),
    ).toBe('edited the words of a draft email and its subject about rentman.io — it had been approved, so it waits for approval again')
    expect(sentenceFor(line('draft.edited', { channel: 'linkedin', subjectChanged: false, reapprove: false }), lookups)).toBe(
      'edited the words of a draft LinkedIn message about rentman.io',
    )
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
