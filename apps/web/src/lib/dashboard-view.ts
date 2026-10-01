import { dealIsOverdue, rottingState } from '@agency/core'
import {
  actorLabel, detailForDisplay, isActorLiteral, isAlarm, sentenceFor, subjectHref,
  type AuditCompanyRef, type AuditLine, type ResolvedActor,
} from './audit-copy'
import type { Deployment } from './deployment-facts'

/**
 * What the dashboard SAYS, decided from facts (PROMPT.md §2.2).
 *
 * The dashboard is the page everybody lands on, so it is the page where a
 * claim the deployment cannot keep does the most damage. Its honesty panel
 * used to be keyed on a phase number — "Phases 0–5 are built" — which was
 * true the day it was written and a lie the day Phase 6 landed, and said
 * nothing at all about THIS deployment. Every sentence here is keyed on
 * something that can be checked instead:
 *
 *   * **configuration** — `Deployment`, from `lib/deployment-facts.ts`:
 *     whether a worker, an inbound webhook, a cron secret, Slack or the
 *     unsubscribe secret is configured. It says a route EXISTS, never that
 *     the thing behind it works.
 *   * **observation** — the newest worker heartbeat (`heartbeatReport`), the
 *     newest `scan.cron_run` audit row, the calls on record. Each says
 *     something HAPPENED, never merely that it could.
 *
 * Neither is allowed to stand in for the other: a configured worker that
 * has not reported in is not sending, and a worker writing heartbeats to
 * this database is sending whatever this web app's configuration says.
 *
 * A zero is only a number when something on this deployment could have
 * recorded a row, so every counter whose recorder may be absent says
 * "none recorded" and names what is missing — the compliance page's rule.
 *
 * Pure: no `env()`, no database, no `server-only`, no `@/` import; the
 * deployment type is imported as a type. The page reads, this decides, and
 * `apps/web/test/dashboard-view.test.ts` pins every shape.
 */

// ---------------------------------------------------------------------------
// The worker, as the dashboard needs it
// ---------------------------------------------------------------------------

/**
 * The fields of `HeartbeatReport` (packages/db, `heartbeat-read.ts`) this
 * module reads. Restated structurally so that nothing here imports the
 * database package; `workerStatus()`'s answer satisfies it as it stands.
 */
export interface WorkerStatusLike {
  /** This web deployment is configured to reach a worker (`deployment().worker`). */
  readonly configured: boolean
  readonly status: 'not_configured' | 'never' | 'live' | 'silent'
  /**
   * A `silent` row older than `HEARTBEAT_RETIRED_AFTER_DAYS` where no worker
   * is configured: a session somebody ran by hand and closed. The digest and
   * /api/health call it `retired`, and so does every sentence here.
   */
  readonly retired: boolean
  readonly lastSeenAt: Date | null
  /** `/readyz`'s vocabulary: disabled | send-only | send-and-receive | receive-only. */
  readonly outreach: string | null
  /** enabled | disabled. Never which credential (§2.3). */
  readonly chat: string | null
}

/**
 * What the worker is called: its status, or `retired` — `heartbeatReportedStatus`
 * in packages/db, restated for the same reason as the interface above, and
 * held to it by `dashboard-view.test.ts` over every status the report can
 * have. The digest's "Worker:" line and /api/health say the same word.
 */
export type WorkerWord = WorkerStatusLike['status'] | 'retired'

export function workerWord(w: Pick<WorkerStatusLike, 'status' | 'retired'>): WorkerWord {
  return w.retired ? 'retired' : w.status
}

/**
 * Why nothing sends where a retired row is the newest — the digest's own
 * words (`workerWords` in `slack-message.ts`), so the channel and the page
 * read alike.
 */
export const RETIRED_WORKER_WORDS = 'no worker is configured, so nothing is sending or reading replies'

/** Whole units, floored, for "2 minutes" — never negative, never "0 minutes". */
export function elapsed(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  if (s < 60) return 'less than a minute'
  if (s < 3_600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86_400) return unit(Math.floor(s / 3_600), 'hour')
  return unit(Math.floor(s / 86_400), 'day')
}

function secondsSince(at: Date | null, now: Date): number | null {
  if (at === null) return null
  const ms = now.getTime() - at.getTime()
  // Two machines' clocks: a heartbeat "in the future" is skew, not a worker
  // that has yet to tick — `heartbeatAge` reads it the same way.
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : null
}

const own = <T>(map: Readonly<Record<string, T>>, key: string | null): T | undefined =>
  key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/** What the worker said it is doing. A value outside the CHECK is not guessed at. */
const OUTREACH_WORDS: Readonly<Record<string, string>> = {
  'send-and-receive': 'sending and receiving',
  'send-only': 'sending, not reading replies',
  'receive-only': 'reading replies, not sending',
  disabled: 'outreach switched off',
}

/** The worker is running and said it sends. */
export function workerSends(w: WorkerStatusLike): boolean {
  return w.status === 'live' && (w.outreach === 'send-and-receive' || w.outreach === 'send-only')
}

/** The worker is running and said it reads a mailbox. */
export function workerReceives(w: WorkerStatusLike): boolean {
  return w.status === 'live' && (w.outreach === 'send-and-receive' || w.outreach === 'receive-only')
}

/**
 * The agent can take a turn FROM THIS DEPLOYMENT: the web is configured to
 * reach a worker, the worker is running, and it said chat is on.
 */
export function agentReachable(d: Deployment, w: WorkerStatusLike): boolean {
  return d.worker && w.status === 'live' && w.chat === 'enabled'
}

/** Can a reply reach this deployment at all? A reading worker, or a webhook. */
function repliesArrive(d: Deployment, w: WorkerStatusLike): boolean {
  return workerReceives(w) || d.inbound === 'webhook'
}

/**
 * Why nothing is being sent, as a clause ("no worker is connected"), or null
 * when the worker is sending. Built from the heartbeat, not the flag: a
 * configured worker that has never reported in is not sending anything.
 */
function notSendingBecause(w: WorkerStatusLike): string | null {
  switch (workerWord(w)) {
    case 'not_configured':
      return 'no worker is connected'
    case 'never':
      return 'no worker has ever reported in'
    case 'silent':
      return 'the worker has gone quiet'
    case 'retired':
      return 'the last worker to report in has retired'
    case 'live':
      if (workerSends(w)) return null
      if (w.outreach === 'disabled') return 'the worker is running with outreach switched off'
      if (w.outreach === 'receive-only') return 'the worker is not sending'
      return 'the worker has not said that it sends'
  }
}

/** Why no mailbox is being read, as a clause, or null when one is. */
function notReadingBecause(w: WorkerStatusLike): string | null {
  if (workerReceives(w)) return null
  if (w.status === 'live') {
    return w.outreach === 'disabled'
      ? 'the worker is running with outreach switched off'
      : 'the worker is not reading a mailbox'
  }
  return notSendingBecause(w)
}

/** Why the agent cannot take a turn here, as a clause, or null when it can. */
function agentAbsentBecause(d: Deployment, w: WorkerStatusLike): string | null {
  if (agentReachable(d, w)) return null
  if (w.status !== 'live') return notSendingBecause(w)
  if (!d.worker) return 'this deployment is not configured to reach the worker'
  return 'chat is switched off in the worker'
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export interface WorkerLine {
  /** `ok`: heard from recently. `warn`: expected and not heard. `quiet`: none was expected. */
  readonly tone: 'ok' | 'warn' | 'quiet'
  readonly lead: string
  /**
   * An instant for the page to render after `lead` in the VIEWER's zone
   * (`<When>`), or null. Kept out of the text: a server-side string would
   * be in the server's zone, which is nobody's.
   */
  readonly at: Date | null
  /** What follows, joined with " · ", or null. */
  readonly tail: string | null
}

/**
 * The one line under the dashboard's heading. Five shapes, one per word:
 *
 *   * live — "Worker last seen 2 minutes ago · sending and receiving · chat on"
 *   * silent — "Worker silent since <when> · 3 hours without a heartbeat · …"
 *   * retired — "Worker retired — last seen <when> · no worker is configured, …"
 *   * never — "No worker has ever reported in · …"
 *   * not_configured — "No worker configured · …"
 *
 * A retired row is quiet, not a warning, for the digest's reason: nobody is
 * alerted about it, and a line that reads as an alarm every day teaches a
 * person to stop reading it.
 */
export function workerLine(w: WorkerStatusLike, now: Date): WorkerLine {
  const age = secondsSince(w.lastSeenAt, now)
  const doing = own(OUTREACH_WORDS, w.outreach)
  switch (workerWord(w)) {
    case 'live': {
      const chat = !w.configured
        ? 'chat is not reachable from this deployment'
        : w.chat === 'enabled'
          ? 'chat on'
          : w.chat === 'disabled'
            ? 'chat off'
            : null
      return {
        tone: 'ok',
        lead: age === null ? 'Worker reporting in' : `Worker last seen ${elapsed(age)} ago`,
        at: null,
        tail: join([doing ?? null, chat]),
      }
    }
    case 'silent':
      return {
        tone: 'warn',
        lead: 'Worker silent since',
        at: w.lastSeenAt,
        tail: join([
          age === null ? null : `${elapsed(age)} without a heartbeat`,
          'approved messages wait and no mailbox is read until it is back',
        ]),
      }
    case 'retired':
      return { tone: 'quiet', lead: 'Worker retired — last seen', at: w.lastSeenAt, tail: RETIRED_WORKER_WORDS }
    case 'never':
      return {
        tone: 'warn',
        lead: 'No worker has ever reported in',
        at: null,
        tail: 'this deployment is configured to reach one, and nothing has written a heartbeat to this database',
      }
    case 'not_configured':
      return {
        tone: 'quiet',
        lead: 'No worker configured',
        at: null,
        tail: 'none has ever reported in to this database, so nothing here sends or reads a mailbox',
      }
  }
}

function join(parts: readonly (string | null | false | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  return kept.length > 0 ? kept.join(' · ') : null
}

// ---------------------------------------------------------------------------
// "What this instance can and cannot do"
// ---------------------------------------------------------------------------

/** What the page observed, beside the configuration. */
export interface DashboardFacts {
  readonly now: Date
  /** The newest `scan.cron_run` audit row for this org, or null when the rescan has never run. */
  readonly lastRescanAt: Date | null
  /** Calls on record for this org — the one trace the voice service leaves here. */
  readonly callsOnRecord: number
}

export interface HonestyHeadline {
  readonly tone: 'ok' | 'warn'
  readonly text: string
}

/**
 * The panel's bold line. The phase statement is about the BUILD — the same
 * on every deployment of it — and it is the only place a phase number
 * appears; every bullet below is keyed on a fact.
 *
 * Phase 6 ships switched off (a compose profile, pending A2P 10DLC). This
 * page cannot see the voice service, but it can see whether a call was ever
 * written to this database, and a call on record is a line that was
 * switched on — so the sentence says which.
 */
export function honestyHeadline(d: Deployment, w: WorkerStatusLike, facts: DashboardFacts): HonestyHeadline {
  const voice =
    facts.callsOnRecord > 0
      ? 'Phases 0–6 are built, and the inbound voice line has answered calls on this database.'
      : 'Phases 0–6 are built; Phase 6, the inbound voice line, is deliberately not switched on, and no call is on record here.'
  const why = notSendingBecause(w)
  return why === null
    ? { tone: 'ok', text: voice }
    : { tone: 'warn', text: `${voice} Nothing on this deployment is sending: ${why}.` }
}

export interface HonestyBullet {
  /** Stable, for a React key and for the tests. */
  readonly id: string
  /** The bold opening sentence. */
  readonly lead: string
  readonly rest: string
}

/**
 * The bullets under the headline, in a fixed order: the worker, replies,
 * the scheduled rescan, notifications, the unsubscribe link, the mail sink,
 * and the three things no deployment of this build does. Each is chosen by a
 * fact and only by a fact.
 */
export function honestyBullets(d: Deployment, w: WorkerStatusLike, facts: DashboardFacts): HonestyBullet[] {
  const out: HonestyBullet[] = [workerBullet(d, w, facts.now), inboundBullet(d, w), cronBullet(d, facts)]

  out.push(
    d.slack
      ? {
          id: 'slack-on',
          lead: 'Notifications go to Slack.',
          rest:
            'SLACK_WEBHOOK_URL is set, so this deployment posts a line when it takes a booking, closes a deal, accepts a proposal, receives a reply through its webhook, or fails to store an opt-out.',
        }
      : {
          id: 'slack-off',
          lead: 'Nothing notifies anyone.',
          rest: 'No SLACK_WEBHOOK_URL is set, so what needs a person surfaces on this page, in the inbox and in the sidebar, and nowhere else.',
        },
  )

  out.push(
    d.unsubscribe
      ? {
          id: 'unsubscribe-on',
          lead: 'A one-click unsubscribe link is honoured here.',
          rest:
            'UNSUBSCRIBE_SECRET is set, so a link carried by a sent email can be verified by this deployment. The worker adds the link only when it holds the same secret and WEB_PUBLIC_URL.',
        }
      : {
          id: 'unsubscribe-off',
          lead: 'No one-click unsubscribe link is offered.',
          rest:
            'UNSUBSCRIBE_SECRET is not set, so this deployment cannot verify one. An opt-out arrives as a reply that says stop, or is added by hand on the suppressions page.',
        },
  )

  if (d.mailIsLocalSink) {
    out.push({
      id: 'mail-sink',
      lead: 'Sign-in links go to a local mail sink.',
      rest: 'SMTP_HOST points at a development mailbox, so a magic link from this deployment lands there and not in anybody’s inbox.',
    })
  }

  out.push({
    id: 'no-calls-or-texts',
    lead: 'Nothing here can place a call or send a text.',
    rest:
      'There is no code path for either — not a disabled one, none. Voice is an inbound line, and the service that answers it is a separate process this page cannot see.',
  })

  out.push({
    id: 'no-sourcing',
    lead: 'Nothing sources new companies on its own.',
    rest: agentReachable(d, w)
      ? 'Import a CSV, add them by hand, or ask the agent to search a connector and put what it finds on the board through the approval gate.'
      : 'Import a CSV or add them by hand. The agent could search a connector for them, but it cannot take a turn here: ' +
        `${agentAbsentBecause(d, w) ?? 'it is not reachable'}.`,
  })

  out.push({
    id: 'no-invitations',
    lead: 'Calendar invitations are not sent from here.',
    rest:
      'A meeting recorded here moves the deal, and its page offers an .ics file; the invitation itself goes from a person’s calendar or the calendar connector.',
  })

  return out
}

function workerBullet(d: Deployment, w: WorkerStatusLike, now: Date): HonestyBullet {
  const age = secondsSince(w.lastSeenAt, now)
  switch (workerWord(w)) {
    case 'not_configured':
      return {
        id: 'worker-none',
        lead: 'No agent worker is connected.',
        rest:
          'Chat, sending and reading a mailbox run in a separate long-lived process that is not part of this deployment. Drafts can be written and approved and will sit in the queue; nothing will send them.',
      }
    case 'never':
      return {
        id: 'worker-never',
        lead: 'A worker is configured and has never reported in.',
        rest:
          'This deployment has an address for one, but nothing has written a heartbeat to this database — so nothing is being sent, no mailbox is being read, and chat will say the worker is unreachable.',
      }
    case 'silent':
      return {
        id: 'worker-silent',
        lead: 'The worker has gone quiet.',
        rest:
          `Nothing has reported in for ${age === null ? 'a while' : elapsed(age)}. ` +
          'Approved messages wait in the queue and no mailbox is read until it is back.',
      }
    case 'retired':
      return {
        id: 'worker-retired',
        lead: 'The last worker to report in has retired.',
        rest:
          `It was last seen ${age === null ? 'over a week ago' : `${elapsed(age)} ago`} and ${RETIRED_WORKER_WORDS}. ` +
          'Its row is what a worker run by hand and closed leaves behind, so nobody is alerted about it. ' +
          'Drafts can be written and approved and will sit in the queue; nothing will send them.',
      }
    case 'live': {
      const doing =
        w.outreach === 'send-and-receive'
          ? 'It sends approved messages through the one send path, checking every rule again at the moment of sending, and reads the mailbox for replies.'
          : w.outreach === 'send-only'
            ? 'It sends approved messages through the one send path, checking every rule again at the moment of sending. It is not reading a mailbox.'
            : w.outreach === 'receive-only'
              ? 'It reads the mailbox for replies and is not sending: approved messages wait in the queue.'
              : w.outreach === 'disabled'
                ? 'Its outreach is switched off: nothing is sent and no mailbox is read.'
                : 'It has not said whether it sends or reads a mailbox.'
      const chat = !d.worker
        ? ' This deployment is not configured to reach it, so chat is not available here.'
        : w.chat === 'enabled'
          ? ' Chat runs in it.'
          : w.chat === 'disabled'
            ? ' Its chat is switched off.'
            : ''
      return { id: 'worker-live', lead: 'A worker is running.', rest: `${doing}${chat}` }
    }
  }
}

function inboundBullet(d: Deployment, w: WorkerStatusLike): HonestyBullet {
  if (d.inbound === 'webhook') {
    return {
      id: 'inbound-webhook',
      lead: 'Replies can arrive through an inbound webhook.',
      rest:
        'A provider posts them here, so a reply pauses its contact and moves the deal — and one that says stop suppresses the address — even with no worker running.' +
        (workerReceives(w) ? ' The worker reads the mailbox as well.' : ''),
    }
  }
  if (workerReceives(w)) {
    return {
      id: 'inbound-worker',
      lead: 'Replies are read from the mailbox by the worker.',
      rest: 'No inbound webhook is configured, so a reply reaches this deployment only while the worker is running.',
    }
  }
  return {
    id: 'inbound-none',
    lead: 'Nothing here can learn that somebody replied.',
    rest: `${capital(notReadingBecause(w) ?? 'no mailbox is being read')} and no inbound webhook is configured, so no reply can reach the inbox.`,
  }
}

function cronBullet(d: Deployment, facts: DashboardFacts): HonestyBullet {
  if (!d.cron) {
    return {
      id: 'cron-off',
      lead: 'Nothing rescans on its own.',
      rest:
        'No CRON_SECRET is set, so the scheduled rescan refuses every call. Evidence ages until somebody runs a scan, and stale evidence is never quoted.',
    }
  }
  // "Daily" is a claim about what happens, so the lead is chosen by the
  // newest run on record, not by the secret: a configured route nothing
  // calls — any host but Vercel, until somebody schedules it — never runs.
  const ran = secondsSince(facts.lastRescanAt, facts.now)
  const what =
    'CRON_SECRET is set, so the scheduled rescan accepts its daily call and works through stale and never-scanned companies a batch at a time.'
  const scheduler = 'On Vercel the schedule is in vercel.json; any other host needs its own scheduler to call it.'
  if (ran === null) {
    return { id: 'cron-on', lead: 'The daily rescan is configured and has not run yet.', rest: `${what} ${scheduler}` }
  }
  if (ran > RESCAN_OVERDUE_HOURS * 3_600) {
    return {
      id: 'cron-on',
      lead: `The daily rescan is configured and has not run for ${elapsed(ran)}.`,
      rest: `${what} ${scheduler}`,
    }
  }
  return { id: 'cron-on', lead: 'Stale companies are rescanned daily.', rest: `${what} It last ran ${elapsed(ran)} ago.` }
}

/**
 * How long after its last run the daily rescan is called late: a day, the
 * hour of jitter a Hobby plan allows either side, and room for one slow run.
 */
export const RESCAN_OVERDUE_HOURS = 36

// ---------------------------------------------------------------------------
// The Active ICP table
// ---------------------------------------------------------------------------

/**
 * Under the Active ICP table, which shows the profile's `outreach.channels`
 * and `max_per_day` beside its qualify-at score. The score is operative —
 * `scoreCompany` qualifies against it — and the other two are not: the send
 * path applies each campaign's own channel, daily cap and quiet hours and
 * reads neither (/settings/icp says the same of the whole outreach block).
 * Shown under bare "Channels" and "Daily cap" headings they read as the
 * limits in force, which is the claim this module exists to stop.
 */
export const ICP_OUTREACH_NOTE =
  'The channels and daily cap are what this profile describes, not what the send path enforces: each campaign ' +
  'applies its own channel, daily cap and quiet hours.'

// ---------------------------------------------------------------------------
// "Needs a look"
// ---------------------------------------------------------------------------

/** The subset of a deal row the counters read. */
export interface DealFacts {
  readonly stage: string
  readonly createdAt: Date
  readonly updatedAt: Date | null
  readonly closedAt: Date | null
  readonly nextActionAt: Date | null
}

/**
 * Open deals past their stage's limit, and open deals past their due date —
 * core's `rottingState` and `dealIsOverdue`, from `updated_at`, exactly as
 * the board decides them, so the counter and the cards cannot disagree.
 */
export function dealsNeedingALook(deals: readonly DealFacts[], now: Date): { rotting: number; overdue: number } {
  let rotting = 0
  let overdue = 0
  for (const d of deals) {
    if (d.closedAt !== null) continue
    if (rottingState(d.stage, d.updatedAt ?? d.createdAt, now)?.rotten) rotting += 1
    if (dealIsOverdue(d.nextActionAt, now)) overdue += 1
  }
  return { rotting, overdue }
}

/**
 * The /compliance checks marked "must be zero", as counts from the same
 * functions that page calls. Different units — calls, opt-outs, messages,
 * drafts, campaigns — so they are never summed; the dashboard counts CHECKS.
 */
export interface ComplianceMustBeZero {
  readonly undisclosedCalls: number
  readonly optOutsWithoutSuppression: number
  readonly optOutsNotStoredLastWindow: number
  readonly optInChannelMessagesWithoutOptIn: number
  readonly draftsOnStaleEvidence: number
  readonly autoSendOnOptInChannels: number
}

export function complianceChecksFailing(z: ComplianceMustBeZero): number {
  return [
    z.undisclosedCalls,
    z.optOutsWithoutSuppression,
    z.optOutsNotStoredLastWindow,
    z.optInChannelMessagesWithoutOptIn,
    z.draftsOnStaleEvidence,
    z.autoSendOnOptInChannels,
  ].filter((n) => n > 0).length
}

export interface LookCounts {
  readonly repliesUnhandled: number
  /** Outbound drafts awaiting a person. */
  readonly draftsAwaiting: number
  /** The agent's actions awaiting a person. */
  readonly approvalsPending: number
  readonly dealsRotting: number
  readonly dealsOverdue: number
  readonly tasksOverdue: number
  readonly companiesStale: number
  readonly companiesNeverScanned: number
  readonly companiesUnreachable: number
  /** The threshold `/companies?state=stale` uses — the ICP's, never a literal. */
  readonly staleAfterDays: number
  /** Null when the viewer may not read the compliance counts. */
  readonly complianceChecksFailing: number | null
}

export interface LookItem {
  readonly id: string
  readonly n: number
  /** Follows the number: "3 replies nobody has handled". */
  readonly label: string
  /** For the "nothing waiting" line: "unhandled replies". */
  readonly none: string
  readonly href: string
  /** A breakdown, a qualification, or — on a zero — the absent recorder. */
  readonly detail: string | null
  /** A §2.1 check that must be zero and is not. */
  readonly alarm: boolean
}

const noun = (n: number, one: string, many: string): string => (n === 1 ? one : many)
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${noun(n, one, many)}`

/**
 * The linked counters, compliance first. A counter whose recorder is absent
 * on this deployment and reads zero says so ("None recorded: …") rather
 * than passing for a clean zero.
 */
export function needsALook(c: LookCounts, d: Deployment, w: WorkerStatusLike): LookItem[] {
  const items: LookItem[] = []
  const quietSends = notSendingBecause(w)

  if (c.complianceChecksFailing !== null) {
    const n = c.complianceChecksFailing
    items.push({
      id: 'compliance',
      n,
      label: noun(n, 'compliance check that must be zero is not', 'compliance checks that must be zero are not'),
      none: 'compliance alarms',
      href: '/compliance',
      detail:
        n === 0 && quietSends !== null
          ? `None recorded, which is not the same as none happened: ${quietSends}, so the counts only the worker writes can be empty for that reason alone.`
          : null,
      alarm: n > 0,
    })
  }

  const noReplies = repliesArrive(d, w) ? null : notReadingBecause(w)
  items.push({
    id: 'replies',
    n: c.repliesUnhandled,
    label: noun(c.repliesUnhandled, 'reply nobody has handled', 'replies nobody has handled'),
    none: 'unhandled replies',
    href: '/inbox?show=unhandled',
    detail:
      noReplies !== null
        ? c.repliesUnhandled === 0
          ? `None recorded: ${noReplies} and no inbound webhook is configured, so no reply can arrive here.`
          : `No new ones can arrive: ${noReplies} and no inbound webhook is configured.`
        : null,
    alarm: false,
  })

  const awaiting = c.draftsAwaiting + c.approvalsPending
  const agentAbsent = agentAbsentBecause(d, w)
  items.push({
    id: 'approvals',
    n: awaiting,
    label: 'awaiting approval',
    none: 'approvals',
    href: '/approvals',
    detail:
      awaiting > 0
        ? join([
            c.draftsAwaiting > 0 && count(c.draftsAwaiting, 'draft'),
            c.approvalsPending > 0 && count(c.approvalsPending, 'agent action'),
            c.draftsAwaiting > 0 && quietSends !== null && `an approved draft waits: ${quietSends}`,
          ])
        : agentAbsent !== null
          ? `None waiting. The agent raises none here: ${agentAbsent}.`
          : null,
    alarm: false,
  })

  items.push({
    id: 'deals-rotting',
    n: c.dealsRotting,
    label: noun(c.dealsRotting, 'deal untouched past its stage’s limit', 'deals untouched past their stage’s limit'),
    none: 'untouched deals',
    href: '/pipeline',
    detail: null,
    alarm: false,
  })

  items.push({
    id: 'deals-overdue',
    n: c.dealsOverdue,
    label: noun(c.dealsOverdue, 'deal past its due date', 'deals past their due date'),
    none: 'overdue deals',
    href: '/pipeline',
    detail: null,
    alarm: false,
  })

  items.push({
    id: 'tasks-overdue',
    n: c.tasksOverdue,
    label: noun(c.tasksOverdue, 'task overdue', 'tasks overdue'),
    none: 'overdue tasks',
    href: '/tasks?view=overdue',
    detail: null,
    alarm: false,
  })

  items.push({
    id: 'companies-stale',
    n: c.companiesStale,
    label: `${noun(c.companiesStale, 'company', 'companies')} with evidence older than ${count(c.staleAfterDays, 'day')}`,
    none: 'stale companies',
    href: '/companies?state=stale',
    detail: c.companiesStale > 0 && !d.cron ? 'Nothing rescans on its own here: no CRON_SECRET is set.' : null,
    alarm: false,
  })

  items.push({
    id: 'companies-never-scanned',
    n: c.companiesNeverScanned,
    label: noun(c.companiesNeverScanned, 'company never scanned', 'companies never scanned'),
    none: 'unscanned companies',
    href: '/companies?state=never',
    detail: null,
    alarm: false,
  })

  items.push({
    id: 'companies-unreachable',
    n: c.companiesUnreachable,
    label: noun(
      c.companiesUnreachable,
      'company whose last scan could not reach the site',
      'companies whose last scan could not reach the site',
    ),
    none: 'unreachable sites',
    href: '/companies?state=failed',
    detail: null,
    alarm: false,
  })

  return items
}

/**
 * Split for display: a card for anything with a number or something to
 * say, and one quiet line naming what is clear. A zero with a detail is a
 * card, because "none recorded" is not "all clear".
 */
export function splitLook(items: readonly LookItem[]): { waiting: LookItem[]; clear: LookItem[] } {
  const waiting: LookItem[] = []
  const clear: LookItem[] = []
  for (const i of items) (i.n > 0 || i.detail !== null ? waiting : clear).push(i)
  return { waiting, clear }
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

/** An audit row, as `listAudit` returns it — the fields the feed reads. */
export interface FeedRow extends AuditLine {
  readonly id: string
  readonly createdAt: Date
}

/**
 * The shape `<AuditLog>` renders (`components/audit/log.tsx`), restated so
 * this module imports no component; the page passes one to the other, so a
 * drift is a type error there.
 */
export interface FeedLine {
  readonly id: string
  readonly at: string
  readonly who: string
  readonly whoNote: string | null
  readonly isPerson: boolean
  readonly sentence: string
  readonly href: string | null
  readonly alarm: boolean
  readonly action: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly detail: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every user id a line may name: the actor, a user the row is about, and a
 * `…By` / `…UserId` key in its detail (who approved, who a deal went to).
 * The /audit page's rule, so a sentence reads the same in both places.
 */
export function feedPersonIds(rows: readonly FeedRow[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (UUID.test(r.actor)) out.add(r.actor)
    if (r.subjectType === 'user' && r.subjectId && UUID.test(r.subjectId)) out.add(r.subjectId)
    const d = r.detail
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (/(By|UserId)$/.test(k) && typeof v === 'string' && UUID.test(v)) out.add(v)
      }
    }
  }
  return [...out]
}

/**
 * The feed's lines: `sentenceFor` with the company and people resolved,
 * `actorLabel` for who, `subjectHref` for where, `isAlarm` for the rows a
 * person must not scroll past — the audit page's vocabulary, not a second one.
 */
export function feedLines(
  rows: readonly FeedRow[],
  companies: ReadonlyMap<string, AuditCompanyRef>,
  people: ReadonlyMap<string, ResolvedActor>,
): FeedLine[] {
  const personName = (id: string): string | null => {
    const p = people.get(id)
    return p ? p.name || p.email : null
  }
  return rows.map((r) => {
    const company = companies.get(r.id) ?? null
    const who = actorLabel(r.actor, people)
    return {
      id: r.id,
      at: r.createdAt.toISOString(),
      who: who.label,
      whoNote: who.note,
      isPerson: !isActorLiteral(r.actor),
      sentence: sentenceFor(r, { company, person: personName }),
      href: subjectHref(r, company),
      alarm: isAlarm(r),
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      detail: detailForDisplay(r.detail),
    }
  })
}

/**
 * Why the feed has no sends or replies in it, when it cannot — or null when
 * the worker is sending and a reply can arrive. Shown under the feed whether
 * or not it is empty: a feed of people's own clicks is quiet about the half
 * of the product that is not running, and should say which half.
 */
export function quietFeedNote(d: Deployment, w: WorkerStatusLike): string | null {
  const noSends = notSendingBecause(w)
  const noReplies = repliesArrive(d, w) ? null : notReadingBecause(w)
  if (noSends === null && noReplies === null) return null
  if (noSends !== null && noReplies !== null) {
    return noSends === noReplies
      ? `${capital(noSends)}, so no sends or replies appear here.`
      : `${capital(noSends)} and no inbound webhook is configured, so no sends or replies appear here.`
  }
  if (noSends !== null) {
    return `${capital(noSends)}, so no sends appear here; replies still arrive${
      d.inbound === 'webhook' ? ' through the inbound webhook' : ''
    }.`
  }
  return `${capital(noReplies as string)} and no inbound webhook is configured, so no replies appear here.`
}
