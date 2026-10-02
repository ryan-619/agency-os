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
  /**
   * `DOVESOFT_WEBHOOK_SECRET` is set, so texts a contact sends back — a STOP
   * included — reach this deployment through DoveSoft's webhook (0019). Its
   * own fact rather than a third `inbound` value, because everything said
   * about `inbound` is about EMAIL: Message-IDs, addresses, a mailbox.
   * Optional so a literal that predates 0019 reads as false.
   */
  readonly smsInbound?: boolean
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
    | 'DOVESOFT_WEBHOOK_SECRET'
  >,
): Deployment {
  const resend = Boolean(e.RESEND_WEBHOOK_SECRET && e.RESEND_API_KEY)
  return {
    worker: Boolean(e.AGENT_URL && e.AGENT_INTERNAL_TOKEN),
    mailIsLocalSink: LOCAL_MAIL.test(e.SMTP_HOST.trim()),
    inbound: e.INBOUND_WEBHOOK_SECRET || resend ? 'webhook' : 'none',
    smsInbound: Boolean(e.DOVESOFT_WEBHOOK_SECRET),
    cron: Boolean(e.CRON_SECRET),
    slack: Boolean(e.SLACK_WEBHOOK_URL),
    unsubscribe: Boolean(e.UNSUBSCRIBE_SECRET),
  }
}

/**
 * The sentence to put under anything that queues a message, or null when a
 * worker is configured and the normal copy is true.
 *
 * Worded as CONFIGURATION, because that is all `d` is. A worker on Fly sends
 * against this database whether or not this web half holds AGENT_URL — the
 * documented production shape — so "nothing queued here will be sent" was a
 * claim this function cannot know. It says what is not configured here and
 * where the observation is; a page that has read the heartbeat says what it
 * saw instead (/compliance, /settings, the dashboard). Round 3, finding [20].
 */
export function nothingWillSendNote(d: Deployment): string | null {
  return d.worker
    ? null
    : 'No agent worker is configured on this deployment. The worker is what sends and reads a mailbox, so unless one runs against this database elsewhere — /settings/deployment shows its heartbeat — what is queued here waits.'
}

/**
 * The sentence to put under anything that promises to notice a reply, or
 * null when this deployment is configured with something that can: a worker,
 * or a provider webhook a reply can arrive through. Configuration, worded as
 * such, for the reason `nothingWillSendNote` gives.
 */
export function noRepliesReadNote(d: Deployment): string | null {
  if (d.worker || d.inbound === 'webhook') return null
  return d.smsInbound
    ? 'No worker is configured on this deployment and no email webhook is set up, so nothing here reads email replies; texts a contact sends back, a STOP included, still arrive through DoveSoft’s webhook. Only a worker running against this database elsewhere could read email — /settings/deployment shows whether one is.'
    : 'No worker is configured on this deployment and no inbound webhook is set up, so nothing here reads replies. Only a worker running against this database elsewhere could — /settings/deployment shows whether one is.'
}

/**
 * The placeholder the DoveSoft URLs carry where the token goes. The secret
 * itself is never shown (§2.3): a person pastes it in when they register the
 * URL on DoveSoft's side.
 */
export const DOVESOFT_TOKEN_PLACEHOLDER = '<DOVESOFT_WEBHOOK_SECRET>'

/** The web half of DoveSoft (0019), by variable name, for /settings/deployment. */
export interface DoveSoftFacts {
  /** `DOVESOFT_WEBHOOK_SECRET` is set, so the two webhook routes accept a request. */
  readonly webhooks: boolean
  /**
   * `DOVESOFT_ORG_ID` is set: the home of a text from a number no contact
   * anywhere holds, and of a report naming no message this system sent —
   * and nothing else. It decides nothing about a number somebody holds: a
   * number several contacts share is filed under the one this system
   * texted, or under nobody with every holder held (review round 6), and
   * the deployment's org is no evidence of whose it is, because every org
   * texts through the one DoveSoft account.
   */
  readonly org: boolean
  /**
   * The two URLs to register with DoveSoft, built from `AUTH_URL` — never a
   * request's Host header — with the token as `DOVESOFT_TOKEN_PLACEHOLDER`.
   */
  readonly urls: { readonly dlr: string; readonly sms: string }
  /** What the configuration means, one sentence each, in reading order. */
  readonly sentences: readonly string[]
}

/**
 * What this web deployment does with DoveSoft, from the configuration. The
 * SENDING half — `DOVESOFT_API_KEY`, `DOVESOFT_ENTITY_ID` — lives on the
 * worker's host, which nothing here can see, and the sentences say so rather
 * than guessing.
 */
export function dovesoftFacts(
  e: Pick<Env, 'AUTH_URL' | 'DOVESOFT_WEBHOOK_SECRET' | 'DOVESOFT_ORG_ID'>,
): DoveSoftFacts {
  const url = (path: string): string => `${new URL(path, e.AUTH_URL).toString()}?token=${DOVESOFT_TOKEN_PLACEHOLDER}`
  const webhooks = Boolean(e.DOVESOFT_WEBHOOK_SECRET)
  const org = Boolean(e.DOVESOFT_ORG_ID)
  return {
    webhooks,
    org,
    urls: { dlr: url('/api/inbound/dovesoft/dlr'), sms: url('/api/inbound/dovesoft/sms') },
    sentences: [
      webhooks
        ? 'Delivery reports and texts a contact sends back are accepted at the two URLs below, with DOVESOFT_WEBHOOK_SECRET as their token.'
        : 'DOVESOFT_WEBHOOK_SECRET is not set, so both DoveSoft routes answer 503: no delivery report is recorded, and no text a contact sends back — a STOP included — reaches this deployment.',
      // 0019 r5: matching is across every org first; the org is a fallback, never a filter.
      // r6: and never a preference among the contacts holding a number.
      org
        ? 'A text is filed under the contact whose number it came from, in whichever org holds them; DOVESOFT_ORG_ID decides nothing about a number a contact holds. Only a text from a number no contact anywhere holds — and a report naming a message this system did not send — is audited in the org DOVESOFT_ORG_ID names, and a STOP from such a number is put on that org’s suppression list.'
        : 'DOVESOFT_ORG_ID is not set. A text is still filed under the contact whose number it came from, in whichever org holds them; but one from a number no contact holds is filed under no org, and a STOP from such a number is recorded nowhere — it is answered 500 and logged OPT-OUT NOT RECORDED, for a person to record by hand.',
      // r6: a number several contacts share, in one org or several.
      'A number several contacts share is filed under the one this system texted at it, and every other contact holding it is paused and their waiting messages cancelled. When this system texted none of them, or more than one, it is filed under nobody, and every contact holding the number is paused and their waiting messages cancelled, until a person resumes them on /contacts. A STOP from a shared number is put on the suppression list of every org whose contacts hold it.',
      'DoveSoft’s report and inbound formats are not public. The routes read the common field names, and a payload they cannot read is refused with a 4xx, audited and logged — never answered 200 and dropped.',
      'Generate DOVESOFT_WEBHOOK_SECRET with `openssl rand -hex 32`, which needs no escaping anywhere. A secret with any other character must be percent-encoded where it stands in the URL (a + is %2B); the first refused token on each route is logged, by the route’s name, once per process.',
      'A push by GET carries its fields in the URL, so the platform’s request log — and DoveSoft’s — holds the sender’s number and the words of every text sent back, beside the token. Ask DoveSoft to push by POST, a form or JSON, where it offers it.',
      'Sending is the worker’s: DOVESOFT_API_KEY and DOVESOFT_ENTITY_ID live on its host, which this page cannot see. Every SMS is drafted from a registered template with Draft SMS on /contacts, and approved by a person on /approvals.',
    ],
  }
}
