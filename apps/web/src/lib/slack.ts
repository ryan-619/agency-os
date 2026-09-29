import 'server-only'
import { appendAudit, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { deliverNotification } from '@/lib/slack-post'
import type { NotificationEvent } from '@/lib/slack-message'

/**
 * The notification a route sends (§8.1–§8.2 of the plan; §2.3 of the spec).
 *
 * This is the module a route imports, and it is deliberately thin: it reads
 * the webhook URL and the app's origin from `env()`, opens the database, and
 * hands all three to `deliverNotification` in `lib/slack-post.ts`, which is
 * where building, posting, logging and the audit row live — and which is
 * tested with the network injected. The URL is read here and passed as an
 * argument so that it exists in exactly one place a log line could reach,
 * and that place logs nothing.
 *
 * A route calls `notify` from inside `after()`, wrapped in try/catch, so a
 * failed notification can never turn a committed write into a 500. `notify`
 * itself never throws either — belt and braces, because the write it is
 * about has already happened.
 *
 * Unset URL → nothing happens and nothing is written: a deployment with no
 * Slack is not one where notifications fail, it is one where they do not
 * exist.
 */
export type { SlackDelivery } from '@/lib/slack-post'
export { postToSlack } from '@/lib/slack-post'

export async function notify(
  event: NotificationEvent,
  deps: { readonly db?: AgencyDb; readonly fetchImpl?: typeof fetch } = {},
): Promise<void> {
  try {
    const e = env()
    if (!e.SLACK_WEBHOOK_URL) {
      log.debug('slack notification skipped', { event: event.kind, reason: 'not_configured' })
      return
    }
    await deliverNotification(event, {
      webhookUrl: e.SLACK_WEBHOOK_URL,
      origin: e.AUTH_URL,
      fetchImpl: deps.fetchImpl,
      audit: (entry) => appendAudit(deps.db ?? (getDb() as unknown as AgencyDb), entry),
    })
  } catch (err) {
    // `env()` throwing is the only way here, and that is a deployment with
    // no configuration at all — nothing to notify anyone about.
    log.warn('slack notification failed', {
      event: event.kind,
      error: err instanceof Error ? err.name : 'UnknownError',
    })
  }
}
