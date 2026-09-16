import 'server-only'
import { env } from '@/lib/env'
import { agentConfigured } from '@/lib/agent'

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
 * route already reports that one as `unreachable` when it happens.
 */
export interface Deployment {
  /**
   * A worker is configured. It is what runs the sender tick and the inbox,
   * so without it an approved message stays approved forever.
   */
  readonly worker: boolean
  /** Mail goes to a local development sink rather than a real relay. */
  readonly mailIsLocalSink: boolean
}

const LOCAL_MAIL = /^(localhost|127\.0\.0\.1|\[?::1\]?|mailpit|host\.docker\.internal)$/i

export function deployment(): Deployment {
  const e = env()
  return {
    worker: agentConfigured(),
    mailIsLocalSink: LOCAL_MAIL.test(e.SMTP_HOST.trim()),
  }
}

/**
 * The sentence to put under anything that queues a message, or null when
 * there is a worker and the normal copy is true.
 */
export function nothingWillSendNote(d: Deployment = deployment()): string | null {
  return d.worker
    ? null
    : 'No agent worker is connected to this deployment, so nothing queued here will be sent and no replies are being read. The queue is honest — it is just not being drained.'
}
