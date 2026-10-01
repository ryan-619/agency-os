import {
  agentReachable, workerReceives, workerSends, workerSendsSms, workerWord, type WorkerStatusLike,
} from '../../lib/dashboard-view'
import type { Deployment } from '../../lib/deployment-facts'

/**
 * Who records what for /compliance, on THIS deployment, as sentences.
 *
 * §2.2 applied to the auditor's own numbers: a zero only means something if
 * something could have recorded a row, so each block names the recorder that
 * is absent — "none recorded", never "none happened". Whether a WORKER
 * records anything is an observation: the newest heartbeat
 * (`workerStatus()`, the same report the dashboard and /settings read). A
 * worker on Fly writing to this database sends and reads a mailbox whether
 * or not this web half holds AGENT_URL — the documented production shape —
 * and a configured worker that has gone quiet records nothing. Configuration
 * (`deployment()`) speaks only where the heartbeat could not be read, and
 * then it says "configured", never "nothing sends". Review round 3, [20].
 *
 * Pure, with relative imports only, so `test/compliance-recorders.test.ts`
 * can import it; the page reads the heartbeat and hands it in.
 */
export interface Absent {
  /** Nothing is sending: every "went out" count is of what was recorded while something did. */
  readonly sending: string | null
  /** Nothing can learn, now, that somebody replied. */
  readonly replies: string | null
  /** The one-click link cannot be verified here. */
  readonly unsubscribe: string | null
  /** The voice service is a separate process this page cannot see. */
  readonly voice: string
  /** The agent raises approvals in chat turns, which need this deployment to reach the worker. */
  readonly agent: string | null
}

/** The heartbeat could not be read and no worker is configured: all that is known, said as configuration. */
const UNREAD_UNCONFIGURED =
  'No worker is configured on this deployment, and the heartbeat that would show one running against this database elsewhere could not be read'

/** Why no worker is sending, as the head of a sentence, from what the heartbeat says; null when one is. */
function notSending(w: WorkerStatusLike): string | null {
  switch (workerWord(w)) {
    case 'not_configured':
      return 'No worker is configured and none has reported in to this database'
    case 'never':
      return 'No worker has ever reported in to this database, although this deployment is configured to reach one'
    case 'silent':
      return 'The worker has gone quiet'
    case 'retired':
      return 'The last worker to report in has retired'
    case 'live':
      if (workerSends(w)) return null
      return w.outreach === 'disabled'
        ? 'The worker is running with outreach switched off'
        : 'The worker reports that it does not send'
  }
}

/**
 * Why no worker is reading a mailbox, likewise. A worker that texts through
 * DoveSoft with its mailbox off is SENDING (`workerSends`), so its outreach
 * is not "switched off" — its EMAIL outreach is, the dashboard's own words
 * for the same heartbeat (`notReadingBecause`; review round 5, [15]).
 */
function notReading(w: WorkerStatusLike): string | null {
  if (workerReceives(w)) return null
  if (w.status === 'live' && !w.retired) {
    return w.outreach === 'disabled'
      ? `The worker is running with ${workerSendsSms(w) ? 'email ' : ''}outreach switched off`
      : 'The worker reports that it does not read a mailbox'
  }
  return notSending(w)
}

/**
 * The sentence for each recorder that is missing. `w` is the heartbeat
 * report, or null when it could not be read (most often: 0018, which creates
 * the table, is not applied).
 */
/** An SMS reply (0019) reaches this deployment through DoveSoft's webhook, with or without a worker. */
const TEXTS_STILL_ARRIVE = 'texts a contact sends back, a STOP included, still arrive through DoveSoft’s webhook'

export function recorders(live: Deployment, w: WorkerStatusLike | null): Absent {
  let sending: string | null
  let replies: string | null
  let agent: string | null
  if (w === null) {
    sending = live.worker ? null : `${UNREAD_UNCONFIGURED}.`
    replies =
      live.worker || live.inbound === 'webhook'
        ? null
        : live.smsInbound
          ? `${UNREAD_UNCONFIGURED}, and no inbound email webhook is configured; ${TEXTS_STILL_ARRIVE}.`
          : `${UNREAD_UNCONFIGURED}, and no inbound webhook is configured.`
    agent = live.worker ? null : 'This deployment is not configured to reach the worker, so no chat turn from here raises an approval.'
  } else {
    const quiet = notSending(w)
    sending = quiet ? `${quiet}, so nothing is being sent now.` : null
    const deaf = live.inbound === 'webhook' ? null : notReading(w)
    replies = !deaf
      ? null
      : live.smsInbound
        ? `${deaf} and no inbound email webhook is configured, so no email reply is arriving now; ${TEXTS_STILL_ARRIVE}.`
        : `${deaf} and no inbound webhook is configured, so no reply is arriving now.`
    agent = agentReachable(live, w)
      ? null
      : !live.worker
        ? 'This deployment is not configured to reach the worker, so no chat turn from here raises an approval.'
        : quiet && w.status !== 'live'
          ? `${quiet}, so the agent raises no approvals now.`
          : 'Chat is switched off in the worker, so the agent raises no approvals.'
  }
  return {
    sending,
    replies,
    unsubscribe: live.unsubscribe ? null : 'UNSUBSCRIBE_SECRET is not set, so the one-click link is not offered here.',
    voice:
      'Calls are written by the voice service, a separate process this page cannot see — and it should not be switched on until A2P 10DLC registration has cleared.',
    agent,
  }
}

/**
 * The warning over the whole page when no worker is seen sending: the send
 * path, the mailbox reader and the agent all run in it, so the counts only
 * it writes are of what was recorded while one ran. Null when one is.
 */
export function workerBanner(live: Deployment, w: WorkerStatusLike | null): { lead: string; rest: string } | null {
  const rest =
    'The send path, the mailbox reader and the agent all run in the worker, so the counts only it writes — messages ' +
    'sent, most refusals, the agent’s approvals — are of what was recorded while one ran, which may be nothing.'
  if (w === null) {
    return live.worker
      ? null
      : {
          lead: 'No agent worker is configured on this deployment, and the heartbeat could not be read.',
          rest:
            'A worker running against this database elsewhere records as usual; without one, the counts only it ' +
            'writes — messages sent, most refusals, the agent’s approvals — may be nothing.',
        }
  }
  const quiet = notSending(w)
  return quiet ? { lead: `${quiet}.`, rest } : null
}
