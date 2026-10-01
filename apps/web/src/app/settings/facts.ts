import type { HeartbeatReport } from '@agency/db/queries'
import type { SchemaAgreement } from '@agency/db/schema-version'
import type { Deployment } from '../../lib/deployment-facts'

/**
 * What /settings and /settings/deployment say about this deployment, as
 * sentences built from facts the pages read.
 *
 * Every sentence names a variable, never a value (§2.3). Two kinds of fact
 * meet here and are kept apart in the wording: CONFIGURATION ("a worker is
 * configured", from `deployment()`) and OBSERVATION ("a worker last wrote a
 * heartbeat four minutes ago", from the database). A configured worker that
 * never reported in is not described as running, and a heartbeat from a
 * worker this web half is not configured to reach is still reported — it is
 * sending mail all the same.
 *
 * Pure: types only, and the one relative import is a type. Nothing here reads
 * the environment or the database.
 */

export type Tone = 'ok' | 'warn' | 'plain'

/** "12 seconds ago", "4 minutes ago", "3 hours ago", "2 days ago". */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (s < 60) return unit(s, 'second')
  if (s < 3600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86_400) return unit(Math.floor(s / 3600), 'hour')
  return unit(Math.floor(s / 86_400), 'day')
}

/**
 * Why nothing sends where the newest heartbeat is a retired row: the
 * digest's words (`workerWords` in `lib/slack-message.ts`) and the
 * dashboard's (`RETIRED_WORKER_WORDS` in `lib/dashboard-view.ts`), restated
 * so that this module keeps its type-only imports; `settings-facts.test.ts`
 * holds the three to one sentence.
 */
const RETIRED_WORKER_WORDS = 'no worker is configured, so nothing is sending or reading replies'

export interface WorkerLine {
  readonly tone: Tone
  readonly text: string
  /** The instant to render beside the text, in the viewer's zone. */
  readonly lastSeenAt: Date | null
}

/**
 * The worker's heartbeat as one line. `report` is null when it could not be
 * read — most often because migration 0018, which creates the table, is not
 * applied — and `errorName` is the error's class, never its message.
 *
 * A retired row (`report.retired`: silent for over a week where no worker is
 * configured) is called retired, as the digest and /api/health call it —
 * its `status` stays `silent`, so switching on that alone called the same
 * row "silent" here and "retired" in the channel.
 */
export function workerLine(report: HeartbeatReport | null, errorName?: string): WorkerLine {
  if (report === null) {
    return {
      tone: 'warn',
      text: `The worker heartbeat could not be read (${errorName ?? 'UnknownError'}). If the schema below is behind, that is why.`,
      lastSeenAt: null,
    }
  }
  const age = report.ageSeconds === null ? '' : ago(report.ageSeconds)
  if (report.retired) {
    return {
      tone: 'plain',
      text: `Worker retired — last seen ${age || 'over a week ago'}; ${RETIRED_WORKER_WORDS}.`,
      lastSeenAt: report.lastSeenAt,
    }
  }
  switch (report.status) {
    case 'live':
      return {
        tone: 'ok',
        text: `Worker last seen ${age}${report.configured ? '' : ', although this web deployment is not configured to reach it (no AGENT_URL / AGENT_INTERNAL_TOKEN), so chat from here is unavailable'}.`,
        lastSeenAt: report.lastSeenAt,
      }
    case 'silent':
      return {
        tone: 'warn',
        text: `Worker silent since its last heartbeat, ${age}. Nothing is being sent and no mailbox is being read until it ticks again.`,
        lastSeenAt: report.lastSeenAt,
      }
    case 'never':
      return {
        tone: 'warn',
        text: 'No worker has ever reported in to this database, although this deployment is configured to reach one.',
        lastSeenAt: null,
      }
    case 'not_configured':
      return {
        tone: 'plain',
        text: 'No worker configured, and none has ever reported in to this database.',
        lastSeenAt: null,
      }
  }
}

/** What a heartbeat says the worker was doing, as words. Never which credential it uses. */
export function workerModes(report: HeartbeatReport | null): string | null {
  if (report === null || report.status === 'never' || report.status === 'not_configured') return null
  // `outreach` describes the MAILBOX only; SMS is its own field (0019), and
  // a worker with DoveSoft and no mailbox sends texts while its mail is off.
  const outreach: Record<string, string> = {
    disabled: 'email outreach off',
    'send-only': 'sending email, not reading a mailbox',
    'send-and-receive': 'sending email and reading a mailbox',
    'receive-only': 'reading a mailbox, not sending email',
  }
  const parts = [
    report.outreach ? outreach[report.outreach] ?? report.outreach : null,
    report.sms === 'on' ? 'texts through DoveSoft' : report.sms === 'off' ? 'SMS off' : null,
    report.chat === 'enabled' ? 'chat on' : report.chat === 'disabled' ? 'chat off (no model credential)' : null,
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? `At its last heartbeat it reported: ${parts.join('; ')}.` : null
}

export interface DeploymentFactInput {
  readonly flags: Deployment
  /** `agentConfigured()` — what the chat route asks before it forwards a turn. */
  readonly agent: boolean
  /** `secretsKeyFromEnv() !== null` — a key that decodes; `malformed` is set but refused. */
  readonly secretsKey: 'valid' | 'malformed' | 'unset'
  /** The platform's own `VERCEL_ENV`, or undefined off Vercel. */
  readonly vercelEnv: 'production' | 'preview' | 'development' | undefined
  /** INBOUND_WEBHOOK_SECRET is set (the plain JSON webhook). */
  readonly inboundJson: boolean
  /** RESEND_WEBHOOK_SECRET and RESEND_API_KEY are both set. */
  readonly inboundResend: boolean
  readonly rescanBatchSize: number
}

export interface DeploymentFact {
  readonly area: string
  readonly on: boolean
  readonly sentence: string
  /** The variables the fact is read from, by name. */
  readonly vars: readonly string[]
}

/** Every flag this deployment has, as a sentence — "why does nothing send?" as a page. */
export function deploymentFacts(i: DeploymentFactInput): readonly DeploymentFact[] {
  const f = i.flags
  const webhooks = [
    i.inboundJson ? 'the inbound webhook (/api/inbound/email)' : null,
    i.inboundResend ? 'Resend’s inbound webhook (/api/inbound/resend)' : null,
  ].filter((w): w is string => w !== null)
  // Configuration only, like Sending: a worker on Fly reads its mailbox
  // against this database whether or not this web half holds its URL, so the
  // worker's part is the heartbeat's to say. Review round 3, finding [20].
  const workerPart = f.worker
    ? 'whether it reads a mailbox is the heartbeat’s question.'
    : null
  let replies: string
  if (webhooks.length > 0) {
    replies = `Accepted by ${webhooks.join(' and ')}.${workerPart ? ` A worker is configured too; ${workerPart}` : ''}`
  } else if (workerPart) {
    replies = `No inbound webhook is configured. This deployment is configured to reach a worker; ${workerPart}`
  } else {
    replies =
      'No inbound webhook is configured, and this deployment is not configured to reach a worker. Unless the ' +
      'heartbeat shows one reading a mailbox against this database, no reply is read.'
  }

  let cron: string
  if (!f.cron) cron = 'Not run: every /api/cron route answers 503 without the secret, so nothing rescans or sends a digest on a schedule.'
  else if (i.vercelEnv !== undefined && i.vercelEnv !== 'production') {
    cron = `The secret is set, but this is a ${i.vercelEnv} deployment and the cron routes refuse to run anywhere but production.`
  } else if (i.vercelEnv === 'production') {
    cron = `Run on Vercel's schedule (vercel.json): a nightly rescan of up to ${i.rescanBatchSize} companies, and a daily digest.`
  } else {
    cron = `The routes accept a request carrying the secret (up to ${i.rescanBatchSize} companies per rescan). Off Vercel nothing calls them unless you schedule it.`
  }

  return [
    {
      area: 'Sending',
      on: f.worker,
      // Configuration only. A worker elsewhere can be sending against this
      // database without this web half holding its URL; the heartbeat is
      // the observation, and the sentence points at it rather than guess.
      sentence: f.worker
        ? 'This deployment is configured to reach a worker, which runs the one send path. Whether it is running is the heartbeat’s question.'
        : 'This deployment is not configured to reach a worker. Unless the heartbeat shows one running against this database anyway, nothing queued here is sent.',
      vars: ['AGENT_URL', 'AGENT_INTERNAL_TOKEN'],
    },
    {
      area: 'Chat',
      on: i.agent,
      sentence: i.agent
        ? 'The agent runs in the configured worker; chat turns are forwarded to it.'
        : 'Unavailable here: the agent runs only in the worker, which cannot run on a serverless host.',
      vars: ['AGENT_URL', 'AGENT_INTERNAL_TOKEN'],
    },
    {
      area: 'Replies',
      on: webhooks.length > 0 || f.worker,
      sentence: replies,
      vars: ['AGENT_URL', 'AGENT_INTERNAL_TOKEN', 'INBOUND_WEBHOOK_SECRET', 'RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY'],
    },
    {
      // The web app's SMTP carries sign-in links only. Outreach goes through
      // the worker's own relay, configured on the worker's host.
      area: 'Sign-in mail',
      on: !f.mailIsLocalSink,
      sentence: f.mailIsLocalSink
        ? 'SMTP points at a local development sink, so a sign-in link reaches nobody’s inbox.'
        : 'SMTP points at a relay. Whether it delivers is not something this page can observe.',
      vars: ['SMTP_HOST'],
    },
    {
      area: 'One-click unsubscribe',
      on: f.unsubscribe,
      sentence: f.unsubscribe
        ? 'Links can be verified here. The worker adds the List-Unsubscribe header only when it holds the same secret and WEB_PUBLIC_URL.'
        : 'Not offered: /api/unsubscribe answers 503 and no link can be verified.',
      vars: ['UNSUBSCRIBE_SECRET'],
    },
    {
      area: 'Scheduled jobs',
      on: f.cron && (i.vercelEnv === undefined || i.vercelEnv === 'production'),
      sentence: cron,
      vars: ['CRON_SECRET', 'RESCAN_BATCH_SIZE'],
    },
    {
      area: 'Notifications',
      on: f.slack,
      sentence: f.slack ? 'Posted to a Slack incoming webhook.' : 'Not sent: no Slack webhook is configured.',
      vars: ['SLACK_WEBHOOK_URL'],
    },
    {
      area: 'Connector credentials',
      on: i.secretsKey === 'valid',
      sentence:
        i.secretsKey === 'valid'
          ? 'Can be stored, encrypted with the configured key.'
          : i.secretsKey === 'malformed'
            ? 'Cannot be stored: SECRETS_KEY is set but is not a valid key, so it is treated as unset.'
            : 'Cannot be stored: there is no key to encrypt them with.',
      vars: ['SECRETS_KEY'],
    },
  ]
}

/**
 * "Why does nothing send?", answered from what the worker last SAID about
 * itself rather than from this web half's configuration — a worker on Fly
 * sends whether or not this deployment holds its URL.
 */
export function sendingAnswer(report: HeartbeatReport | null): { tone: Tone; text: string } {
  if (report === null) {
    return { tone: 'warn', text: 'The heartbeat could not be read, so whether a worker is sending is not known from here.' }
  }
  if (report.retired) {
    // Not "check Fly": nothing is configured to be running, so nothing was scaled away.
    return {
      tone: 'warn',
      text:
        `Nothing sends: ${RETIRED_WORKER_WORDS}. The last worker to report in was last seen ` +
        `${report.ageSeconds === null ? 'over a week ago' : ago(report.ageSeconds)}; with none configured, a week without a ` +
        'heartbeat counts as retired — what a worker run by hand and then closed leaves behind — and nobody is alerted ' +
        'about it. If one is meant to be running elsewhere against this database, it has stopped. The CRM half works ' +
        'without one; sending, reply detection and chat need the worker (DEPLOYING.md).',
    }
  }
  switch (report.status) {
    case 'not_configured':
      return {
        tone: 'warn',
        text: 'Nothing sends: no worker is configured and none has ever reported in. The CRM half works without one; sending, reply detection and chat need the worker (DEPLOYING.md).',
      }
    case 'never':
      return {
        tone: 'warn',
        text: 'Nothing has been sent by a worker: this deployment is configured to reach one, but none has ever written a heartbeat to this database. Check that it is running and pointed at the same database.',
      }
    case 'silent':
      return {
        tone: 'warn',
        text: `Nothing is sending now: the worker's last heartbeat was ${report.ageSeconds === null ? 'unknown' : ago(report.ageSeconds)}. On Fly, check that the machine was not scaled to zero.`,
      }
    case 'live':
      if (report.outreach === 'disabled' && report.sms === 'on') {
        return {
          tone: 'ok',
          text: 'A worker is alive and sends approved SMS through DoveSoft. Its email outreach is disabled, so no email is sent and no mailbox is read; its mail settings live on its own host.',
        }
      }
      if (report.outreach === 'disabled') {
        return { tone: 'warn', text: 'A worker is alive but reports outreach disabled, so it sends nothing. Its mail settings live on its own host.' }
      }
      if (report.outreach === 'receive-only' && report.sms === 'on') {
        return {
          tone: 'ok',
          text: 'A worker is alive: it reads a mailbox and sends approved SMS through DoveSoft, but reports that it does not send email.',
        }
      }
      if (report.outreach === 'receive-only') {
        return { tone: 'warn', text: 'A worker is alive and reads a mailbox, but reports that it does not send.' }
      }
      return {
        tone: 'ok',
        text: 'A worker is alive and reports that it sends. A message that has still not gone out carries its reason on the message: a refusal, quiet hours, the daily cap, or an approval nobody has decided.',
      }
  }
}

/** The migration state, as `/api/health` computes it, in a sentence. */
export function schemaSentence(state: SchemaAgreement, expected: string, applied: string | null): { tone: Tone; text: string } {
  switch (state) {
    case 'ok':
      return { tone: 'ok', text: `The database is at migration ${expected}, which is what this code expects.` }
    case 'behind':
      return {
        tone: 'warn',
        text: `The database is at ${applied ?? '—'} and this code expects ${expected}. Features that need the newer tables will fail when used. Run ./tools/remote-setup.sh.`,
      }
    case 'ahead':
      return {
        tone: 'plain',
        text: `The database is at ${applied ?? '—'}, ahead of the ${expected} this code expects — a newer revision migrated it. Usually a rollout in progress.`,
      }
    case 'unknown':
      return {
        tone: 'warn',
        text: 'The migration ledger could not be read, so nothing is known about the schema. The database has probably never been migrated: run ./tools/remote-setup.sh.',
      }
  }
}
