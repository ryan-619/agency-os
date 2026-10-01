/**
 * The worker's one Slack message: an opt-out it could not record (§2.1's
 * Phase 4 obligation, said to a person in real time).
 *
 * A reply read over IMAP that says stop is handed to `handleInboundEmail`,
 * which writes the suppression row — and when that write fails, audits
 * `contact.opt_out_not_recorded`, logs `OPT-OUT NOT RECORDED`, pauses the
 * contact, and answers `optOutNotRecorded: true`. The web routes turn that
 * flag into an AWAITED Slack alarm; until now the worker had no way to, so a
 * "stop" that failed to store over IMAP waited for the next morning's digest
 * or somebody reading /compliance. This is that alarm, with the web's rules:
 *
 *  - **The same bytes.** The message is built by
 *    `slackOptOutNotRecordedPayload` in packages/core, which the web's
 *    `slackMessage` also calls — ids and a deep link, never a body, a name,
 *    an address or an `.inbound` row name. The link is built on
 *    `WEB_PUBLIC_URL`; with none, the alarm goes without a link rather than
 *    with an invented one.
 *  - **One attempt, three seconds, no retry.** The audit row is the truth;
 *    the alarm is a courtesy about a row that already exists.
 *  - **An audit row either way**, `notification.sent` or
 *    `notification.failed`, actor `system`, with the detail the web's
 *    `deliverNotification` writes — so /audit reads one sentence for both.
 *  - **The URL is the credential.** It reaches no log line, no audit row and
 *    no return value; `redact()` cannot see it (it matches key names, and
 *    this is a value inside a URL). A failure is reported by error NAME
 *    (`TypeError`, `AbortError`) or Slack's own short token (`no_service`).
 *  - **Never throws.** The reply is recorded; nothing here may undo that or
 *    stop the inbox reading the next message.
 *
 * The POST is a copy of the web's `postToSlack` (apps/web/src/lib/
 * slack-post.ts), not an import of it: that module lives in the Next app and
 * logs through the web's logger, and packages/core may not perform I/O. The
 * two are short and say the same thing; `notify.test.ts` pins this one.
 */
import { slackOptOutNotRecordedPayload, type SlackOptOutNotRecordedEvent, type SlackPayload } from '@agency/core'
import { appendAudit, type AgencyDb, type InboundOutcome } from '@agency/db'
import { loadEnv } from './env.js'
import type { Logger } from './logger.js'

export type SlackDelivery =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly status: number | null; readonly error: string }

const TIMEOUT_MS = 3_000

/** The class of a failure and nothing else — a message can quote the request, and the request is the URL. */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' && err.name) {
    return err.name
  }
  return 'UnknownError'
}

/**
 * Slack answers a refused webhook with a short plain-text token in the body
 * (`no_service`, `invalid_payload`, `channel_not_found`). Anything shaped
 * like that is kept; anything else is reduced to the status.
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

/** One POST, three seconds, no redirect followed. Never throws. */
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
      // A redirect would carry the payload wherever it names. The host is
      // pinned at the environment boundary; this keeps it pinned at the wire.
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

/**
 * The alarm a recorded reply raises, or null for every other outcome — the
 * rule of the web's `optOutNotRecordedNotification`
 * (apps/web/src/app/api/inbound/email/notification.ts). Nothing was written
 * for `matched: 'none'`; a redelivery (`duplicate`) raised it the first
 * time. Every field is named, never spread.
 */
export function optOutNotRecordedEvent(outcome: InboundOutcome): SlackOptOutNotRecordedEvent | null {
  if (outcome.matched === 'none' || outcome.duplicate || !outcome.optOutNotRecorded) return null
  return {
    kind: 'opt_out_not_recorded',
    orgId: outcome.orgId,
    touchId: outcome.touchId,
    contactId: outcome.contactId,
    path: 'reply',
  }
}

export interface OptOutAlarmDeps {
  /** `SLACK_WEBHOOK_URL`. The credential: handed to `fetch` and nowhere else. */
  readonly webhookUrl: string
  /** `WEB_PUBLIC_URL`, or null — then the message carries no link. */
  readonly origin: string | null
  readonly db: AgencyDb
  readonly log: Logger
  readonly fetchImpl?: typeof fetch
}

/** Build, post, record. Never throws. */
export async function raiseOptOutNotRecorded(event: SlackOptOutNotRecordedEvent, deps: OptOutAlarmDeps): Promise<void> {
  try {
    const result = await postToSlack(deps.webhookUrl, slackOptOutNotRecordedPayload(event, deps.origin), deps.fetchImpl ?? fetch)
    if (result.ok) {
      deps.log.info('slack notification sent', { event: event.kind, status: result.status })
    } else {
      deps.log.warn('slack notification failed', { event: event.kind, status: result.status, error: result.error })
    }
    try {
      await appendAudit(deps.db, {
        orgId: event.orgId,
        actor: 'system',
        action: result.ok ? 'notification.sent' : 'notification.failed',
        subjectType: 'touch',
        subjectId: event.touchId,
        detail: {
          channel: 'slack',
          event: event.kind,
          ids: { touchId: event.touchId, contactId: event.contactId },
          status: result.status,
          ...(result.ok ? {} : { error: result.error }),
        },
      })
    } catch (err) {
      // The alarm went (or did not); the record of that is what failed. Said
      // by class, and nothing to retry into.
      deps.log.warn('slack notification audit row not written', { event: event.kind, error: errorName(err) })
    }
  } catch (err) {
    deps.log.warn('slack notification failed', { event: event.kind, error: errorName(err) })
  }
}

/** What the inbox calls with an unrecorded opt-out. */
export type OptOutAlarm = (event: SlackOptOutNotRecordedEvent) => Promise<void>

/**
 * The alarm the environment configures, or null when `SLACK_WEBHOOK_URL` is
 * unset — a deployment with no Slack is one where the alarm does not exist,
 * not one where it fails. Said once, by NAME: whether it is on, and whether
 * its link can be built. Never the URL.
 */
export function optOutAlarmFrom(
  env: { readonly SLACK_WEBHOOK_URL?: string | undefined; readonly WEB_PUBLIC_URL?: string | undefined },
  deps: { readonly db: AgencyDb; readonly log: Logger; readonly fetchImpl?: typeof fetch },
): OptOutAlarm | null {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    deps.log.info('opt-out alarm: off; an unrecorded opt-out is still audited and logged', { missing: ['SLACK_WEBHOOK_URL'] })
    return null
  }
  const origin = env.WEB_PUBLIC_URL ?? null
  if (origin === null) {
    deps.log.info('opt-out alarm: on, without a link to the app', { missing: ['WEB_PUBLIC_URL'] })
  } else {
    deps.log.info('opt-out alarm: on')
  }
  return (event) =>
    raiseOptOutNotRecorded(event, {
      webhookUrl,
      origin,
      db: deps.db,
      log: deps.log,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    })
}

/**
 * The same, read from the worker's own validated environment — for a caller
 * that did not hand one in. `startWorker` (`worker.ts`) builds the inbox from
 * named settings and passes no alarm (it predates one), so the inbox derives
 * it here rather than staying silent. `loadEnv` already succeeded at boot over this same
 * environment; should it ever throw here, the alarm is off and says why by
 * class — the inbox itself must still run.
 */
export function optOutAlarmFromEnvironment(
  deps: { readonly db: AgencyDb; readonly log: Logger; readonly fetchImpl?: typeof fetch },
  source: NodeJS.ProcessEnv = process.env,
): OptOutAlarm | null {
  try {
    return optOutAlarmFrom(loadEnv(source), deps)
  } catch (err) {
    deps.log.warn('opt-out alarm: off; the environment could not be read', { error: errorName(err) })
    return null
  }
}
