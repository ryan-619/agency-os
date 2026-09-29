import type { Env } from './env'

/**
 * What THIS deployment can actually do.
 *
 * The product's one claim about itself is that it never states something it
 * did not do (§2.2). That claim is easy to keep on a developer's machine,
 * where every process is running, and easy to break the moment only part of
 * the system is deployed — which is exactly what happens on a serverless
 * host, where `apps/agent` cannot run at all: it holds a Postgres advisory
 * lock for its lifetime, ticks every fifteen seconds, and keeps an IMAP IDLE
 * socket open. None of those exist in a function that lives for a second.
 *
 * Without that worker the CRM is entirely intact — companies, scans,
 * contacts, the pipeline, briefs, proposals, the booking page — and three
 * things silently are not: nothing sends, nothing watches for replies, and
 * the agent cannot take a turn. Copy that says otherwise is the failure this
 * module exists to prevent, so every screen that promises sending asks here
 * first.
 *
 * It is deliberately a statement about CONFIGURATION, not a health check. A
 * worker that is configured but down is a different problem, and the chat
 * route already reports that one as `unreachable` when it happens. The same
 * goes for every flag added since: each says a route EXISTS and holds what
 * it needs to accept a request, never that the thing behind it has been seen
 * to work.
 *
 * This is the pure half: the facts as a function over an object, and the
 * sentences a page shows in place of a promise the deployment cannot keep.
 * `deployment()` — the one line that reads the environment — lives in
 * `lib/deployment.ts` behind `server-only`, so this file can be imported by
 * a test and by nothing that runs in a browser.
 */
export interface Deployment {
  /**
   * A worker is configured. It is what runs the sender tick and the inbox,
   * so without it an approved message stays approved forever.
   */
  readonly worker: boolean
  /** Mail goes to a local development sink rather than a real relay. */
  readonly mailIsLocalSink: boolean
  /**
   * How a reply can reach this deployment without a worker: a provider
   * webhook, or nothing. `'webhook'` means a route exists that will ACCEPT
   * one — the plain JSON webhook with its secret, or Resend's with both the
   * signing secret and the API key that fetches the body. Either without its
   * pair answers 503, and a fact that says "webhook" about a route that
   * refuses everything is the claim this module exists to prevent.
   */
  readonly inbound: 'none' | 'webhook'
  /** The cron routes have a secret to check, so a scheduled job can run. */
  readonly cron: boolean
  /** A Slack webhook is configured, so a notification has somewhere to go. */
  readonly slack: boolean
  /** One-click unsubscribe tokens can be signed and verified here. */
  readonly unsubscribe: boolean
}

const LOCAL_MAIL = /^(localhost|127\.0\.0\.1|\[?::1\]?|mailpit|host\.docker\.internal)$/i

/**
 * The facts, from the configuration, as a pure function — so a test can
 * state them over an object and a page can never be told something the
 * variables do not say. `worker` is the same two-variable rule the chat
 * route uses (`agentConfigured()`), restated here rather than imported so
 * that this function reads nothing but its argument.
 */
export function flagsFrom(
  e: Pick<
    Env,
    | 'AGENT_URL'
    | 'AGENT_INTERNAL_TOKEN'
    | 'SMTP_HOST'
    | 'INBOUND_WEBHOOK_SECRET'
    | 'RESEND_WEBHOOK_SECRET'
    | 'RESEND_API_KEY'
    | 'CRON_SECRET'
    | 'SLACK_WEBHOOK_URL'
    | 'UNSUBSCRIBE_SECRET'
  >,
): Deployment {
  const resend = Boolean(e.RESEND_WEBHOOK_SECRET && e.RESEND_API_KEY)
  return {
    worker: Boolean(e.AGENT_URL && e.AGENT_INTERNAL_TOKEN),
    mailIsLocalSink: LOCAL_MAIL.test(e.SMTP_HOST.trim()),
    inbound: e.INBOUND_WEBHOOK_SECRET || resend ? 'webhook' : 'none',
    cron: Boolean(e.CRON_SECRET),
    slack: Boolean(e.SLACK_WEBHOOK_URL),
    unsubscribe: Boolean(e.UNSUBSCRIBE_SECRET),
  }
}

/**
 * The sentence to put under anything that queues a message, or null when
 * there is a worker and the normal copy is true.
 */
export function nothingWillSendNote(d: Deployment): string | null {
  return d.worker
    ? null
    : 'No agent worker is connected to this deployment, so nothing queued here will be sent and no replies are being read. The queue is honest — it is just not being drained.'
}

/**
 * The sentence to put under anything that promises to notice a reply, or
 * null when something on this deployment actually can: a worker reading the
 * mailbox, or a provider webhook a reply can arrive through.
 */
export function noRepliesReadNote(d: Deployment): string | null {
  return d.worker || d.inbound === 'webhook'
    ? null
    : 'No worker is reading a mailbox and no inbound webhook is configured on this deployment, so nothing here can learn that somebody replied. The queue is honest — it is just not being read.'
}
