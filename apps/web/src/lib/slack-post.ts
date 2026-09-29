import { log } from './logger'
import { slackMessage, type NotificationEvent, type SlackPayload } from './slack-message'

/**
 * Delivering a notification to Slack (§2.3 governs every line of it).
 *
 * The webhook URL IS the credential: anyone holding it can post to the
 * channel. `redact()` blanks values by KEY name and this one lives inside a
 * URL, so the logger cannot catch it — which is why nothing here ever puts
 * the URL, or an error that might quote it, into a log field, an audit row
 * or a return value. A failure is reported as the error's NAME (`TypeError`,
 * `AbortError`) or Slack's own short token (`no_service`), and that is all.
 *
 * No retry. A notification is a courtesy about a row that already exists;
 * the row is the truth, the audit log says whether the courtesy was paid,
 * and a retry loop on a serverless function is a bill. Three seconds and
 * one attempt, then move on.
 *
 * This file carries no `server-only` marker and reads no environment, so
 * the test suite can drive it with the network and the audit writer
 * injected. `lib/slack.ts` is what a route imports: it reads `env()`,
 * hands the URL and the database in, and carries the marker.
 */
export type SlackDelivery =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string }

const TIMEOUT_MS = 3_000

/** The class of a failure and nothing else — a message can quote the request. */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' && err.name) {
    return err.name
  }
  return 'UnknownError'
}

/**
 * Slack answers a refused webhook with a short plain-text token in the body
 * (`no_service`, `invalid_payload`, `channel_not_found`). Anything shaped
 * like that is worth keeping; anything else is reduced to the status.
 */
async function slackError(res: Response): Promise<string> {
  try {
    const body = (await res.text()).trim()
    if (/^[a-z_]{1,64}$/.test(body)) return body
  } catch {
    // Fall through to the status: the body is not part of the contract.
  }
  return `http_${res.status}`
}

export async function postToSlack(
  webhookUrl: string,
  payload: SlackPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackDelivery> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // A redirect would carry the payload to whatever the redirect names.
      // The host is pinned at the environment boundary; this keeps it pinned
      // at the wire.
      redirect: 'manual',
      signal: controller.signal,
    })
    if (res.ok) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: await slackError(res) }
  } catch (err) {
    return { ok: false, status: null, error: errorName(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** What the audit log is told about a notification — the shape `appendAudit` takes. */
export interface NotificationAuditEntry {
  readonly orgId: string
  readonly actor: 'system'
  readonly action: 'notification.sent' | 'notification.failed'
  readonly subjectType: 'touch' | 'meeting' | 'deal' | 'proposal' | 'campaign' | 'org'
  readonly subjectId: string | null
  readonly detail: Record<string, unknown>
}

/** The audit row's subject: the event's main id, and the ids worth keeping beside it. */
function subjectOf(event: NotificationEvent): {
  readonly type: NotificationAuditEntry['subjectType']
  readonly id: string | null
  readonly ids: Record<string, string | null>
} {
  switch (event.kind) {
    case 'reply':
      return { type: 'touch', id: event.touchId, ids: { touchId: event.touchId, contactId: event.contactId } }
    case 'booking':
      return { type: 'meeting', id: event.meetingId, ids: { meetingId: event.meetingId } }
    case 'deal_closed':
      return { type: 'deal', id: event.dealId, ids: { dealId: event.dealId } }
    case 'proposal_accepted':
      return { type: 'proposal', id: event.proposalId, ids: { proposalId: event.proposalId } }
    case 'opt_out_not_recorded':
      return { type: 'touch', id: event.touchId, ids: { touchId: event.touchId, contactId: event.contactId } }
    case 'campaign_paused':
      return { type: 'campaign', id: event.campaignId, ids: { campaignId: event.campaignId } }
    case 'worker_silent':
    case 'digest':
      return { type: 'org', id: null, ids: {} }
  }
}

/**
 * Build, post, record. Everything `notify` does once it knows there is a
 * webhook to post to, with the URL, the app's origin, the network and the
 * audit writer all handed in — so the whole path, including the promise
 * that the URL reaches no log line and no audit row, can be driven by a
 * test. Never throws: the write it is about has already happened, and a
 * courtesy that fails must not turn that into a 500.
 */
export async function deliverNotification(
  event: NotificationEvent,
  deps: {
    readonly webhookUrl: string
    /** `env().AUTH_URL`, never a request's Host header. */
    readonly origin: string
    readonly fetchImpl?: typeof fetch
    readonly audit: (entry: NotificationAuditEntry) => Promise<void>
  },
): Promise<void> {
  try {
    const result = await postToSlack(deps.webhookUrl, slackMessage(event, deps.origin), deps.fetchImpl ?? fetch)
    if (result.ok) {
      log.info('slack notification sent', { event: event.kind, status: result.status })
    } else {
      log.warn('slack notification failed', { event: event.kind, status: result.status, error: result.error })
    }

    const subject = subjectOf(event)
    try {
      await deps.audit({
        orgId: event.orgId,
        actor: 'system',
        action: result.ok ? 'notification.sent' : 'notification.failed',
        subjectType: subject.type,
        subjectId: subject.id,
        detail: {
          channel: 'slack',
          event: event.kind,
          ids: subject.ids,
          status: result.status,
          ...(result.ok ? {} : { error: result.error }),
        },
      })
    } catch (err) {
      // The notification went (or did not); the record of that is what
      // failed. Say so, by class, and stop — there is nothing to retry into.
      log.warn('slack notification audit row not written', { event: event.kind, error: errorName(err) })
    }
  } catch (err) {
    log.warn('slack notification failed', { event: event.kind, error: errorName(err) })
  }
}
