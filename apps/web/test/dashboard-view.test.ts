/**
 * What the dashboard says, from facts (PROMPT.md §2.2).
 *
 * The honesty panel used to open "Phases 0–5 are built" — true the day it
 * was written, a lie the day Phase 6 landed, and silent about the
 * deployment it was rendered on. These pin the replacement's promises:
 *
 *   * every deployment shape yields the bullets its facts call for, and no
 *     bullet leans on a phase number — the headline states the build once,
 *     and whether a call is on record decides what it says about Phase 6;
 *   * each flag moves exactly the bullets tied to it, so a "cannot" is
 *     keyed on the fact it names;
 *   * the worker line has one shape per heartbeat status, and a RETIRED row
 *     — a session somebody ran by hand and closed over a week ago, with no
 *     worker configured — is called what the digest and /api/health call
 *     it, never "silent";
 *   * a counter whose recorder is absent reads "none recorded" and names
 *     what is missing, never a clean zero;
 *   * the feed speaks the audit page's vocabulary, not a second one.
 *
 * `lib/dashboard-view.ts` is pure — no `server-only`, no `@/` — so it is
 * loaded here directly; the last block reads the source to keep it so.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_RETIRED_AFTER_DAYS, heartbeatReport, heartbeatReportedStatus } from '@agency/db/queries'
import type { Deployment } from '../src/lib/deployment-facts'
import { slackMessage, type NotificationEvent } from '../src/lib/slack-message'
import {
  ICP_OUTREACH_NOTE,
  RESCAN_OVERDUE_HOURS,
  RETIRED_WORKER_WORDS,
  complianceChecksFailing,
  dealsNeedingALook,
  elapsed,
  feedLines,
  feedPersonIds,
  honestyBullets,
  honestyHeadline,
  needsALook,
  quietFeedNote,
  splitLook,
  workerLine,
  workerSends,
  workerSendsSms,
  workerWord,
  type DashboardFacts,
  type FeedRow,
  type LookCounts,
  type WorkerStatusLike,
} from '../src/lib/dashboard-view'

const NOW = new Date('2026-09-30T12:00:00Z')
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000)

/** Nothing configured: the Vercel half on its own. */
const BARE: Deployment = {
  worker: false,
  mailIsLocalSink: false,
  inbound: 'none',
  cron: false,
  slack: false,
  unsubscribe: false,
}

const NO_WORKER: WorkerStatusLike = {
  configured: false, status: 'not_configured', retired: false, lastSeenAt: null, outreach: null, chat: null,
}
const NEVER: WorkerStatusLike = { configured: true, status: 'never', retired: false, lastSeenAt: null, outreach: null, chat: null }
const LIVE: WorkerStatusLike = {
  configured: true,
  status: 'live',
  retired: false,
  lastSeenAt: ago(120),
  outreach: 'send-and-receive',
  chat: 'enabled',
}
const SILENT: WorkerStatusLike = { ...LIVE, status: 'silent', lastSeenAt: ago(3 * 3_600 + 5) }
/** A worker on Fly writing to this database while this web app has no AGENT_URL. */
const LIVE_ELSEWHERE: WorkerStatusLike = { ...LIVE, configured: false }
/**
 * `./tools/run-worker.sh` run once against this database nine days ago and
 * closed, on a deployment with no worker configured: `heartbeatReport` keeps
 * the status `silent` and sets `retired`.
 */
const RETIRED: WorkerStatusLike = { ...LIVE, configured: false, status: 'silent', retired: true, lastSeenAt: ago(9 * 86_400) }

const FACTS: DashboardFacts = { now: NOW, lastRescanAt: null, callsOnRecord: 0 }

const SHAPES: readonly { name: string; d: Deployment; w: WorkerStatusLike }[] = [
  { name: 'nothing configured', d: BARE, w: NO_WORKER },
  { name: 'worker configured, never reported', d: { ...BARE, worker: true }, w: NEVER },
  { name: 'worker live', d: { ...BARE, worker: true }, w: LIVE },
  { name: 'worker silent', d: { ...BARE, worker: true }, w: SILENT },
  { name: 'worker retired', d: BARE, w: RETIRED },
  { name: 'worker live elsewhere', d: BARE, w: LIVE_ELSEWHERE },
  { name: 'worker live, outreach off', d: { ...BARE, worker: true }, w: { ...LIVE, outreach: 'disabled' } },
  { name: 'worker live, send-only', d: { ...BARE, worker: true }, w: { ...LIVE, outreach: 'send-only' } },
  { name: 'worker live, receive-only', d: { ...BARE, worker: true }, w: { ...LIVE, outreach: 'receive-only' } },
  { name: 'worker live, mailbox off, SMS on', d: { ...BARE, worker: true }, w: { ...LIVE, outreach: 'disabled', sms: 'on' } },
  { name: 'worker live, sending and receiving, SMS on', d: { ...BARE, worker: true }, w: { ...LIVE, sms: 'on' } },
  { name: 'worker live, sending and receiving, SMS off', d: { ...BARE, worker: true }, w: { ...LIVE, sms: 'off' } },
  { name: 'worker live elsewhere, receive-only, SMS on', d: BARE, w: { ...LIVE_ELSEWHERE, outreach: 'receive-only', sms: 'on' } },
  { name: 'webhook, no worker', d: { ...BARE, inbound: 'webhook' }, w: NO_WORKER },
  {
    name: 'everything configured',
    d: { worker: true, mailIsLocalSink: false, inbound: 'webhook', cron: true, slack: true, unsubscribe: true },
    w: LIVE,
  },
  { name: 'local development', d: { ...BARE, worker: true, mailIsLocalSink: true }, w: LIVE },
]

const text = (b: { lead: string; rest: string }): string => `${b.lead} ${b.rest}`
const ids = (d: Deployment, w: WorkerStatusLike, facts: DashboardFacts = FACTS): string[] =>
  honestyBullets(d, w, facts).map((b) => b.id)
const bullet = (d: Deployment, w: WorkerStatusLike, id: string, facts: DashboardFacts = FACTS) => {
  const b = honestyBullets(d, w, facts).find((x) => x.id === id)
  if (!b) throw new Error(`no bullet ${id} in ${ids(d, w, facts).join(', ')}`)
  return b
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe('honestyHeadline', () => {
  it.each(SHAPES)('states the build as Phases 0–6 on every shape ($name)', ({ d, w }) => {
    const h = honestyHeadline(d, w, FACTS)
    expect(h.text).toMatch(/^Phases 0–6 are built/)
    expect(h.text).not.toMatch(/Phases 0–5/)
  })

  it('says Phase 6 is not switched on while no call is on record', () => {
    expect(honestyHeadline(BARE, NO_WORKER, FACTS).text).toContain(
      'Phase 6, the inbound voice line, is deliberately not switched on, and no call is on record here.',
    )
  })

  it('stops saying so once a call is on record, because then it was switched on', () => {
    const h = honestyHeadline(BARE, NO_WORKER, { ...FACTS, callsOnRecord: 3 })
    expect(h.text).toContain('the inbound voice line has answered calls on this database')
    expect(h.text).not.toMatch(/not switched on/)
  })

  it('warns, with the reason, whenever nothing is sending', () => {
    expect(honestyHeadline(BARE, NO_WORKER, FACTS)).toMatchObject({ tone: 'warn' })
    expect(honestyHeadline(BARE, NO_WORKER, FACTS).text).toContain('Nothing on this deployment is sending: no worker is connected.')
    expect(honestyHeadline({ ...BARE, worker: true }, NEVER, FACTS).text).toContain('no worker has ever reported in')
    expect(honestyHeadline({ ...BARE, worker: true }, SILENT, FACTS).text).toContain('the worker has gone quiet')
    expect(honestyHeadline(BARE, RETIRED, FACTS).text).toContain(
      'Nothing on this deployment is sending: the last worker to report in has retired.',
    )
    expect(honestyHeadline(BARE, RETIRED, FACTS).text).not.toMatch(/gone quiet|silent/i)
    expect(honestyHeadline({ ...BARE, worker: true }, { ...LIVE, outreach: 'disabled' }, FACTS).text).toContain(
      'the worker is running with outreach switched off',
    )
  })

  it('does not warn when a worker is live and sending', () => {
    expect(honestyHeadline({ ...BARE, worker: true }, LIVE, FACTS)).toMatchObject({ tone: 'ok' })
    expect(honestyHeadline(BARE, LIVE_ELSEWHERE, FACTS)).toMatchObject({ tone: 'ok' })
  })

  /** Texts are sends: the send path runs, checks every rule and records what it refused. */
  it('does not say nothing is sending while the worker sends texts, whatever its mailbox says', () => {
    for (const outreach of ['disabled', 'receive-only', null]) {
      const w = { ...LIVE, outreach, sms: 'on' as const }
      expect(honestyHeadline({ ...BARE, worker: true }, w, FACTS)).toMatchObject({ tone: 'ok' })
      expect(workerSends(w)).toBe(true)
      expect(workerSendsSms(w)).toBe(true)
    }
    // Off, or not said, it is the mailbox alone, as before.
    for (const sms of ['off', null, undefined] as const) {
      expect(honestyHeadline({ ...BARE, worker: true }, { ...LIVE, outreach: 'disabled', sms }, FACTS).text).toContain(
        'Nothing on this deployment is sending: the worker is running with outreach switched off.',
      )
    }
    // A silent worker sends nothing, whatever its last row said about SMS.
    expect(workerSends({ ...SILENT, sms: 'on' })).toBe(false)
    expect(honestyHeadline({ ...BARE, worker: true }, { ...SILENT, sms: 'on' }, FACTS).text).toContain('the worker has gone quiet')
  })
})

describe('honestyBullets', () => {
  it.each(SHAPES)('never leans on a phase number ($name)', ({ d, w }) => {
    for (const f of [FACTS, { ...FACTS, lastRescanAt: ago(3_600), callsOnRecord: 2 }]) {
      for (const b of honestyBullets(d, w, f)) expect(text(b)).not.toMatch(/\bPhases?\s*\d/i)
    }
  })

  it.each(SHAPES)('gives every bullet a distinct id and a lead that is a sentence ($name)', ({ d, w }) => {
    const bs = honestyBullets(d, w, FACTS)
    expect(new Set(bs.map((b) => b.id)).size).toBe(bs.length)
    for (const b of bs) {
      expect(b.lead).toMatch(/^[A-Z].*\.$/)
      expect(b.rest.length).toBeGreaterThan(20)
    }
  })

  it('says the three things no deployment of this build does, on every shape', () => {
    for (const { d, w } of SHAPES) {
      expect(ids(d, w)).toEqual(expect.arrayContaining(['no-calls', 'no-sourcing', 'no-invitations']))
    }
    expect(text(bullet(BARE, NO_WORKER, 'no-calls'))).toMatch(/no code path for one/)
  })

  /**
   * "Nothing here can place a call or send a text. There is no code path for
   * either" stopped being true with 0019: a text has a code path, the
   * worker's, through DoveSoft. The bullet keeps the call's "none" and says
   * where a text goes, on every shape.
   */
  it('no longer says there is no code path for a text, and says where one goes', () => {
    for (const { d, w } of SHAPES) {
      const said = text(bullet(d, w, 'no-calls'))
      expect(said).not.toMatch(/send a text|no code path for either/)
      expect(said).toContain('A text is sent only by the worker, through DoveSoft, from a registered template')
      expect(said).toContain('never from this page')
    }
  })

  describe('the worker', () => {
    it('picks one bullet per heartbeat status', () => {
      expect(ids(BARE, NO_WORKER)[0]).toBe('worker-none')
      expect(ids({ ...BARE, worker: true }, NEVER)[0]).toBe('worker-never')
      expect(ids({ ...BARE, worker: true }, SILENT)[0]).toBe('worker-silent')
      expect(ids({ ...BARE, worker: true }, LIVE)[0]).toBe('worker-live')
      expect(ids(BARE, RETIRED)[0]).toBe('worker-retired')
    })

    it('never says a worker is running unless one reported in within the threshold', () => {
      for (const w of [NO_WORKER, NEVER, SILENT, RETIRED]) {
        for (const b of honestyBullets({ ...BARE, worker: true }, w, FACTS)) {
          expect(text(b)).not.toMatch(/A worker is running|Chat runs in it|reads the mailbox for replies/)
        }
      }
    })

    it('says how long a silent worker has been quiet', () => {
      expect(bullet({ ...BARE, worker: true }, SILENT, 'worker-silent').rest).toContain('Nothing has reported in for 3 hours.')
    })

    it('calls a retired worker retired, with the digest’s words, and never quiet or silent', () => {
      const b = bullet(BARE, RETIRED, 'worker-retired')
      expect(b.lead).toBe('The last worker to report in has retired.')
      expect(b.rest).toContain(`It was last seen 9 days ago and ${RETIRED_WORKER_WORDS}.`)
      // A reading of the row, not knowledge of its history: a worker on another
      // host that died a week ago reads the same.
      expect(b.rest).toContain('if one is meant to be running elsewhere against this database, it has stopped')
      expect(text(b)).not.toMatch(/gone quiet|silent/i)
      expect(ids(BARE, RETIRED)).not.toContain('worker-silent')
    })

    it('says what a live worker said it is doing, and nothing it did not', () => {
      const d = { ...BARE, worker: true }
      expect(bullet(d, LIVE, 'worker-live').rest).toMatch(/sends approved messages.*reads the mailbox/)
      expect(bullet(d, { ...LIVE, outreach: 'send-only' }, 'worker-live').rest).toContain('It is not reading a mailbox.')
      expect(bullet(d, { ...LIVE, outreach: 'receive-only' }, 'worker-live').rest).toContain('is not sending')
      expect(bullet(d, { ...LIVE, outreach: 'disabled' }, 'worker-live').rest).toContain('nothing is sent and no mailbox is read')
      expect(bullet(d, { ...LIVE, chat: 'disabled' }, 'worker-live').rest).toContain('Its chat is switched off.')
    })

    /**
     * `outreach` is the MAILBOX. A worker with no SMTP and DoveSoft on wrote
     * `outreach: 'disabled'` and `sms: 'on'`, and the bullet said "nothing is
     * sent" while it sent texts.
     */
    it('says a worker with its mailbox off and DoveSoft on sends approved SMS, and that email outreach is off', () => {
      const d = { ...BARE, worker: true }
      const rest = bullet(d, { ...LIVE, outreach: 'disabled', sms: 'on' }, 'worker-live').rest
      expect(rest).toContain('It sends approved SMS through DoveSoft, checking every rule again at the moment of sending.')
      expect(rest).toContain('Its email outreach is switched off: no email is sent and no mailbox is read.')
      expect(rest).not.toContain('nothing is sent')
    })

    it('names the texts beside the mail in every other live mailbox mode with DoveSoft on', () => {
      const d = { ...BARE, worker: true }
      const say = (outreach: string | null) => bullet(d, { ...LIVE, outreach, sms: 'on' }, 'worker-live').rest
      expect(say('send-and-receive')).toBe(
        'It sends approved messages through the one send path — email, and texts through DoveSoft — checking every ' +
          'rule again at the moment of sending, and reads the mailbox for replies. Chat runs in it.',
      )
      expect(say('send-only')).toContain('email, and texts through DoveSoft')
      expect(say('send-only')).toContain('It is not reading a mailbox.')
      expect(say('receive-only')).toContain('It sends approved SMS through DoveSoft')
      expect(say('receive-only')).toContain('It is not sending email: approved emails wait in the queue.')
      expect(say('receive-only')).not.toMatch(/is not sending:/)
      expect(say(null)).toContain('It has not said whether it sends email or reads a mailbox.')
    })

    it('says SMS is off where the worker said so and its mail words could cover texts', () => {
      const d = { ...BARE, worker: true }
      const off = (outreach: string) => bullet(d, { ...LIVE, outreach, sms: 'off' }, 'worker-live').rest
      expect(off('send-and-receive')).toContain('SMS is switched off in it, so an approved text waits in the queue.')
      expect(off('send-only')).toContain('SMS is switched off in it')
      // "nothing is sent" and "is not sending" already cover a text.
      expect(off('disabled')).toBe('Its outreach is switched off: nothing is sent and no mailbox is read. Chat runs in it.')
      expect(off('receive-only')).not.toContain('SMS')
    })

    /** A worker from before 0019 wrote nothing about SMS, and sent none: nothing is said about it. */
    it('says nothing about SMS for a row that does not say, as before', () => {
      const d = { ...BARE, worker: true }
      for (const outreach of ['send-and-receive', 'send-only', 'receive-only', 'disabled', null]) {
        for (const w of [{ ...LIVE, outreach }, { ...LIVE, outreach, sms: null }]) {
          expect(bullet(d, w, 'worker-live').rest).not.toMatch(/SMS|DoveSoft|text/)
        }
      }
      expect(bullet(d, { ...LIVE, outreach: 'disabled', sms: null }, 'worker-live').rest).toContain(
        'nothing is sent and no mailbox is read',
      )
    })

    it('says chat is unavailable here when the worker is live but this deployment cannot reach it', () => {
      expect(bullet(BARE, LIVE_ELSEWHERE, 'worker-live').rest).toContain(
        'This deployment is not configured to reach it, so chat is not available here.',
      )
    })
  })

  describe('replies (deployment().inbound)', () => {
    it('names the webhook when one is configured, worker or not', () => {
      expect(ids({ ...BARE, inbound: 'webhook' }, NO_WORKER)).toContain('inbound-webhook')
      expect(bullet({ ...BARE, inbound: 'webhook' }, NO_WORKER, 'inbound-webhook').rest).toContain('even with no worker running')
      expect(bullet({ ...BARE, worker: true, inbound: 'webhook' }, LIVE, 'inbound-webhook').rest).toContain(
        'The worker reads the mailbox as well.',
      )
    })

    it('credits the worker only when it said it reads a mailbox', () => {
      expect(ids({ ...BARE, worker: true }, LIVE)).toContain('inbound-worker')
      expect(ids({ ...BARE, worker: true }, { ...LIVE, outreach: 'receive-only' })).toContain('inbound-worker')
      expect(ids({ ...BARE, worker: true }, { ...LIVE, outreach: 'send-only' })).toContain('inbound-none')
    })

    it('says only texts arrive when DoveSoft’s webhook is the one way in (0019)', () => {
      const sms = { ...BARE, smsInbound: true }
      expect(ids(sms, NO_WORKER)).toContain('inbound-sms-only')
      expect(ids(sms, NO_WORKER)).not.toContain('inbound-none')
      expect(bullet(sms, NO_WORKER, 'inbound-sms-only').rest).toBe(
        'No worker is connected and no inbound email webhook is configured, so an email reply reaches nothing. ' +
          'Texts a contact sends back, a STOP included, arrive through DoveSoft’s webhook.',
      )
      expect(bullet({ ...sms, inbound: 'webhook' }, NO_WORKER, 'inbound-webhook').rest).toContain('arrive through DoveSoft’s webhook')
    })

    it('says nothing can learn of a reply, and why, when neither exists', () => {
      expect(bullet(BARE, NO_WORKER, 'inbound-none').rest).toBe(
        'No worker is connected and no inbound webhook is configured, so no reply can reach the inbox.',
      )
      expect(bullet({ ...BARE, worker: true }, { ...LIVE, outreach: 'send-only' }, 'inbound-none').rest).toMatch(
        /^The worker is not reading a mailbox and no inbound webhook is configured/,
      )
      expect(bullet({ ...BARE, worker: true }, SILENT, 'inbound-none').rest).toMatch(/^The worker has gone quiet/)
    })
  })

  describe('the scheduled rescan', () => {
    it('says nothing rescans without CRON_SECRET', () => {
      const b = bullet(BARE, NO_WORKER, 'cron-off')
      expect(b.lead).toBe('Nothing rescans on its own.')
      expect(b.rest).toContain('No CRON_SECRET is set')
    })

    it('does not say "daily" about a rescan that has never run', () => {
      const b = bullet({ ...BARE, cron: true }, NO_WORKER, 'cron-on')
      expect(b.lead).toBe('The daily rescan is configured and has not run yet.')
      expect(b.rest).toContain('any other host needs its own scheduler')
      expect(text(b)).not.toMatch(/are rescanned daily/)
    })

    it('says "daily" once a run is on record, and when it was', () => {
      const b = bullet({ ...BARE, cron: true }, NO_WORKER, 'cron-on', { ...FACTS, lastRescanAt: ago(5 * 3_600) })
      expect(b.lead).toBe('Stale companies are rescanned daily.')
      expect(b.rest).toContain('It last ran 5 hours ago.')
    })

    it('says when the last run is older than a daily schedule allows', () => {
      const late = { ...FACTS, lastRescanAt: ago((RESCAN_OVERDUE_HOURS + 1) * 3_600) }
      expect(bullet({ ...BARE, cron: true }, NO_WORKER, 'cron-on', late).lead).toBe(
        'The daily rescan is configured and has not run for 1 day.',
      )
      const onTime = { ...FACTS, lastRescanAt: ago((RESCAN_OVERDUE_HOURS - 1) * 3_600) }
      expect(bullet({ ...BARE, cron: true }, NO_WORKER, 'cron-on', onTime).lead).toBe('Stale companies are rescanned daily.')
    })
  })

  it('names Slack, the unsubscribe link and the mail sink by their variables', () => {
    expect(bullet(BARE, NO_WORKER, 'slack-off').rest).toContain('No SLACK_WEBHOOK_URL is set')
    expect(bullet({ ...BARE, slack: true }, NO_WORKER, 'slack-on').rest).toContain('SLACK_WEBHOOK_URL is set')
    expect(bullet(BARE, NO_WORKER, 'unsubscribe-off').rest).toContain('UNSUBSCRIBE_SECRET is not set')
    expect(bullet({ ...BARE, unsubscribe: true }, NO_WORKER, 'unsubscribe-on').rest).toContain('UNSUBSCRIBE_SECRET is set')
    expect(ids(BARE, NO_WORKER)).not.toContain('mail-sink')
    expect(bullet({ ...BARE, mailIsLocalSink: true }, NO_WORKER, 'mail-sink').rest).toContain('SMTP_HOST')
  })

  it('offers the agent as a way to source companies only when it can take a turn here', () => {
    expect(bullet({ ...BARE, worker: true }, LIVE, 'no-sourcing').rest).toContain('ask the agent to search a connector')
    expect(bullet(BARE, NO_WORKER, 'no-sourcing').rest).toContain('it cannot take a turn here: no worker is connected.')
    expect(bullet(BARE, LIVE_ELSEWHERE, 'no-sourcing').rest).toContain(
      'this deployment is not configured to reach the worker',
    )
    expect(bullet({ ...BARE, worker: true }, { ...LIVE, chat: 'disabled' }, 'no-sourcing').rest).toContain(
      'chat is switched off in the worker',
    )
  })

  /**
   * The property the rewrite exists for: a "cannot" is keyed on the fact it
   * names. Flipping one configuration flag changes exactly its own bullet.
   */
  it.each([
    ['cron', 'cron-off', 'cron-on'],
    ['slack', 'slack-off', 'slack-on'],
    ['unsubscribe', 'unsubscribe-off', 'unsubscribe-on'],
  ] as const)('moves only its own bullet when %s flips', (flag, off, on) => {
    const before = ids(BARE, NO_WORKER)
    const after = ids({ ...BARE, [flag]: true }, NO_WORKER)
    expect(before.filter((i) => !after.includes(i))).toEqual([off])
    expect(after.filter((i) => !before.includes(i))).toEqual([on])
  })

  it('moves only the replies bullet when an inbound webhook appears', () => {
    const before = ids(BARE, NO_WORKER)
    const after = ids({ ...BARE, inbound: 'webhook' }, NO_WORKER)
    expect(before.filter((i) => !after.includes(i))).toEqual(['inbound-none'])
    expect(after.filter((i) => !before.includes(i))).toEqual(['inbound-webhook'])
  })
})

// ---------------------------------------------------------------------------
// The worker line
// ---------------------------------------------------------------------------

describe('workerLine', () => {
  it('not_configured: none was expected, so it is quiet rather than a warning', () => {
    expect(workerLine(NO_WORKER, NOW)).toEqual({
      tone: 'quiet',
      lead: 'No worker configured',
      at: null,
      tail: 'none has ever reported in to this database, so nothing here sends or reads a mailbox',
    })
  })

  it('never: a configured worker that has never reported in is a warning', () => {
    const l = workerLine(NEVER, NOW)
    expect(l.tone).toBe('warn')
    expect(l.lead).toBe('No worker has ever reported in')
    expect(l.at).toBeNull()
  })

  it('live: how long ago, and what it said it is doing', () => {
    expect(workerLine(LIVE, NOW)).toEqual({
      tone: 'ok',
      lead: 'Worker last seen 2 minutes ago',
      at: null,
      tail: 'sending and receiving · chat on',
    })
    expect(workerLine({ ...LIVE, outreach: 'send-only', chat: 'disabled' }, NOW).tail).toBe(
      'sending, not reading replies · chat off',
    )
  })

  it('live but unreachable from here: says chat is not reachable, not "chat on"', () => {
    expect(workerLine(LIVE_ELSEWHERE, NOW).tail).toBe('sending and receiving · chat is not reachable from this deployment')
  })

  it('live: says "texts through DoveSoft" when SMS is on, with the mailbox words saying which half is email', () => {
    expect(workerLine({ ...LIVE, sms: 'on' }, NOW).tail).toBe('sending and receiving email · texts through DoveSoft · chat on')
    expect(workerLine({ ...LIVE, outreach: 'send-only', sms: 'on' }, NOW).tail).toBe(
      'sending email, not reading replies · texts through DoveSoft · chat on',
    )
    expect(workerLine({ ...LIVE, outreach: 'receive-only', sms: 'on' }, NOW).tail).toBe(
      'reading replies, not sending email · texts through DoveSoft · chat on',
    )
    expect(workerLine({ ...LIVE, outreach: 'disabled', sms: 'on' }, NOW).tail).toBe(
      'email outreach switched off · texts through DoveSoft · chat on',
    )
    expect(workerLine({ ...LIVE, outreach: 'teleport', sms: 'on' }, NOW).tail).toBe('texts through DoveSoft · chat on')
  })

  it('live: says "SMS off" only where the mailbox words could be read as covering texts', () => {
    expect(workerLine({ ...LIVE, sms: 'off' }, NOW).tail).toBe('sending and receiving · SMS off · chat on')
    expect(workerLine({ ...LIVE, outreach: 'send-only', sms: 'off' }, NOW).tail).toBe('sending, not reading replies · SMS off · chat on')
    expect(workerLine({ ...LIVE, outreach: 'disabled', sms: 'off' }, NOW).tail).toBe('outreach switched off · chat on')
    expect(workerLine({ ...LIVE, outreach: 'receive-only', sms: 'off' }, NOW).tail).toBe('reading replies, not sending · chat on')
    // Not said: as before.
    expect(workerLine({ ...LIVE, sms: null }, NOW).tail).toBe('sending and receiving · chat on')
  })

  it('live: an outreach value outside the vocabulary is not echoed', () => {
    expect(workerLine({ ...LIVE, outreach: 'teleport' }, NOW).tail).toBe('chat on')
  })

  it('live: a heartbeat a moment in the future is clock skew, not a negative age', () => {
    expect(workerLine({ ...LIVE, lastSeenAt: new Date(NOW.getTime() + 4_000) }, NOW).lead).toBe(
      'Worker last seen less than a minute ago',
    )
  })

  it('silent: since when (for the viewer’s zone), and for how long', () => {
    const l = workerLine(SILENT, NOW)
    expect(l.tone).toBe('warn')
    expect(l.lead).toBe('Worker silent since')
    expect(l.at).toEqual(SILENT.lastSeenAt)
    expect(l.tail).toBe('3 hours without a heartbeat · approved messages wait and no mailbox is read until it is back')
  })

  it('retired: last seen when (for the viewer’s zone), and why nothing sends — quiet, never "silent"', () => {
    expect(workerLine(RETIRED, NOW)).toEqual({
      tone: 'quiet',
      lead: 'Worker retired — last seen',
      at: RETIRED.lastSeenAt,
      tail: RETIRED_WORKER_WORDS,
    })
  })
})

/**
 * The grid: every status `heartbeatReport` can produce, retired included,
 * built by the function the page's data comes from — so a row the digest
 * calls retired cannot be one the dashboard calls silent.
 */
describe('the dashboard and the digest call the worker the same thing', () => {
  const row = (secondsAgo: number, detail: Record<string, unknown> = {}) => ({
    lastTickAt: ago(secondsAgo), outreach: 'send-and-receive', chat: 'enabled', detail: { intervalMs: 15_000, ...detail },
  })
  const DAY = 86_400
  const ROWS = [
    ['no row', null],
    ['a fresh row', row(30)],
    ['an hour-old row', row(3_600)],
    ['a row just inside the retirement horizon', row(HEARTBEAT_RETIRED_AFTER_DAYS * DAY - 60)],
    ['a row past the retirement horizon', row(HEARTBEAT_RETIRED_AFTER_DAYS * DAY + 60)],
  ] as const
  const GRID = ROWS.flatMap(([label, r]) =>
    [true, false].map((configured) => [`${label}, worker ${configured ? '' : 'not '}configured`, r, configured] as const),
  )

  it.each(GRID)('%s', (_label, r, configured) => {
    const report = heartbeatReport(r, configured, NOW)
    const word = heartbeatReportedStatus(report)
    expect(workerWord(report)).toBe(word)

    const d = { ...BARE, worker: configured }
    const line = workerLine(report, NOW)
    const worker = honestyBullets(d, report, FACTS)[0]!
    const said = `${line.lead} ${line.tail ?? ''} ${worker.lead} ${worker.rest} ${honestyHeadline(d, report, FACTS).text}`
    expect(worker.id).toBe(
      { not_configured: 'worker-none', never: 'worker-never', live: 'worker-live', silent: 'worker-silent', retired: 'worker-retired' }[word],
    )
    if (word === 'retired') {
      expect(line.lead).toBe('Worker retired — last seen')
      expect(said).not.toMatch(/silent|gone quiet/i)
      expect(said).toContain(RETIRED_WORKER_WORDS)
    }
    if (word === 'silent') expect(line.lead).toBe('Worker silent since')
  })

  /**
   * The worker writes `sms` into the row's detail; `heartbeatReport` reads
   * it and the dashboard words it — over every status and both mailbox
   * extremes, built by the functions the page's data comes from. A row's SMS
   * is said only while the worker is live, and never as "nothing is sent".
   */
  describe('with what the row says about SMS', () => {
    const SMS_ROWS = [
      ['a fresh row', 30],
      ['an hour-old row', 3_600],
      ['a row past the retirement horizon', HEARTBEAT_RETIRED_AFTER_DAYS * DAY + 60],
    ] as const
    const SMS_GRID = SMS_ROWS.flatMap(([label, age]) =>
      (['on', 'off', undefined] as const).flatMap((sms) =>
        (['disabled', 'send-and-receive'] as const).flatMap((outreach) =>
          [true, false].map(
            (configured) =>
              [
                `${label}, sms ${String(sms)}, mailbox ${outreach}, worker ${configured ? '' : 'not '}configured`,
                { ...row(age, sms === undefined ? {} : { sms }), outreach },
                configured,
                sms ?? null,
              ] as const,
          ),
        ),
      ),
    )

    it.each(SMS_GRID)('%s', (_label, r, configured, sms) => {
      const report = heartbeatReport(r, configured, NOW)
      expect(report.sms).toBe(sms)
      const d = { ...BARE, worker: configured }
      const line = workerLine(report, NOW)
      const worker = honestyBullets(d, report, FACTS)[0]!
      const headline = honestyHeadline(d, report, FACTS).text
      const said = `${line.tail ?? ''} ${worker.rest}`
      const live = workerWord(report) === 'live'
      expect(said.includes('texts through DoveSoft') || said.includes('approved SMS through DoveSoft')).toBe(live && sms === 'on')
      if (live && sms === 'on') {
        expect(said).not.toContain('nothing is sent')
        expect(headline).not.toContain('Nothing on this deployment is sending')
      }
      if (sms === null) expect(said).not.toMatch(/SMS|DoveSoft/)
    })
  })

  it('covers every word, retired included', () => {
    const words = new Set(GRID.map(([, r, configured]) => heartbeatReportedStatus(heartbeatReport(r, configured, NOW))))
    expect([...words].sort()).toEqual(['live', 'never', 'not_configured', 'retired', 'silent'])
  })

  it('says it in the digest’s own words', () => {
    const digest: NotificationEvent = {
      kind: 'digest', orgId: '00000000-0000-4000-8000-0000000000aa', pendingApprovals: 0, unhandledReplies: 0,
      rottingDeals: 0, staleCompanies: 0, neverScanned: 0, dueTasks: 0, overdueTasks: 0, refusals24h: [],
      optOutsNotRecorded24h: 0, spend24hUsd: '0.00', worker: 'retired', workerLastSeenAt: RETIRED.lastSeenAt!.toISOString(),
      campaignPauses: { found: 0, notices: 0 }, topRotting: [],
    }
    expect(slackMessage(digest, 'https://agency.example').text).toContain(
      `Worker: retired — last seen 2026-09-21; ${RETIRED_WORKER_WORDS}`,
    )
  })
})

describe('elapsed', () => {
  it.each([
    [0, 'less than a minute'],
    [59, 'less than a minute'],
    [60, '1 minute'],
    [119, '1 minute'],
    [3_599, '59 minutes'],
    [3_600, '1 hour'],
    [86_399, '23 hours'],
    [86_400, '1 day'],
    [3 * 86_400 + 5, '3 days'],
    [-5, 'less than a minute'],
    [Number.NaN, 'less than a minute'],
  ])('%s seconds is "%s"', (s, words) => {
    expect(elapsed(s)).toBe(words)
  })
})

// ---------------------------------------------------------------------------
// Needs a look
// ---------------------------------------------------------------------------

const ZERO: LookCounts = {
  repliesUnhandled: 0,
  draftsAwaiting: 0,
  approvalsPending: 0,
  dealsRotting: 0,
  dealsOverdue: 0,
  tasksOverdue: 0,
  companiesStale: 0,
  companiesNeverScanned: 0,
  companiesUnreachable: 0,
  staleAfterDays: 14,
  complianceChecksFailing: 0,
}

const item = (c: LookCounts, d: Deployment, w: WorkerStatusLike, id: string) => {
  const i = needsALook(c, d, w).find((x) => x.id === id)
  if (!i) throw new Error(`no item ${id}`)
  return i
}

describe('needsALook', () => {
  it('links each counter to the list that holds its rows', () => {
    const hrefs = Object.fromEntries(needsALook(ZERO, BARE, NO_WORKER).map((i) => [i.id, i.href]))
    expect(hrefs).toEqual({
      compliance: '/compliance',
      replies: '/inbox?show=unhandled',
      approvals: '/approvals',
      'deals-rotting': '/pipeline',
      'deals-overdue': '/pipeline',
      'tasks-overdue': '/tasks?view=overdue',
      'companies-stale': '/companies?state=stale',
      'companies-never-scanned': '/companies?state=never',
      'companies-unreachable': '/companies?state=failed',
    })
  })

  it('a zero with no reply recorder is "none recorded", with the absent recorder named', () => {
    expect(item(ZERO, BARE, NO_WORKER, 'replies').detail).toBe(
      'None recorded: no worker is connected and no inbound webhook is configured, so no reply can arrive here.',
    )
    expect(item(ZERO, { ...BARE, worker: true }, SILENT, 'replies').detail).toMatch(/^None recorded: the worker has gone quiet/)
    expect(item(ZERO, BARE, RETIRED, 'replies').detail).toBe(
      'None recorded: the last worker to report in has retired and no inbound webhook is configured, so no reply can arrive here.',
    )
    expect(item(ZERO, { ...BARE, worker: true }, { ...LIVE, outreach: 'send-only' }, 'replies').detail).toMatch(
      /^None recorded: the worker is not reading a mailbox/,
    )
  })

  it('a zero with a reply recorder is a clean zero', () => {
    expect(item(ZERO, { ...BARE, inbound: 'webhook' }, NO_WORKER, 'replies').detail).toBeNull()
    expect(item(ZERO, { ...BARE, worker: true }, LIVE, 'replies').detail).toBeNull()
    expect(item(ZERO, { ...BARE, worker: true }, { ...LIVE, outreach: 'receive-only' }, 'replies').detail).toBeNull()
  })

  it('a zero with only DoveSoft’s webhook names the email half as missing, not a clean zero (0019)', () => {
    // Texts arrive; email replies cannot. A clean zero would claim both.
    const sms = { ...BARE, smsInbound: true }
    expect(item(ZERO, sms, NO_WORKER, 'replies').detail).toBe(
      'None recorded: no worker is connected and no inbound email webhook is configured, so no email reply can arrive here; ' +
        'texts still do, through DoveSoft’s webhook.',
    )
    expect(item(ZERO, { ...sms, worker: true }, { ...LIVE, outreach: 'send-only' }, 'replies').detail).toMatch(
      /^None recorded: the worker is not reading a mailbox and no inbound email webhook is configured, so no email reply can arrive here; texts still do/,
    )
    expect(item({ ...ZERO, repliesUnhandled: 2 }, sms, NO_WORKER, 'replies').detail).toBe(
      'No new email replies can arrive: no worker is connected and no inbound email webhook is configured; ' +
        'texts still do, through DoveSoft’s webhook.',
    )
    // Either email recorder makes it a clean zero again, texts or not.
    expect(item(ZERO, { ...sms, inbound: 'webhook' }, NO_WORKER, 'replies').detail).toBeNull()
    expect(item(ZERO, { ...sms, worker: true }, LIVE, 'replies').detail).toBeNull()
  })

  it('replies waiting with no recorder say no new ones can arrive', () => {
    const i = item({ ...ZERO, repliesUnhandled: 2 }, BARE, NO_WORKER, 'replies')
    expect(i.label).toBe('replies nobody has handled')
    expect(i.detail).toMatch(/^No new ones can arrive: no worker is connected/)
    expect(item({ ...ZERO, repliesUnhandled: 1 }, BARE, NO_WORKER, 'replies').label).toBe('reply nobody has handled')
  })

  it('approvals add drafts and agent actions, and say an approved draft will wait when nothing sends', () => {
    const i = item({ ...ZERO, draftsAwaiting: 2, approvalsPending: 1 }, BARE, NO_WORKER, 'approvals')
    expect(i.n).toBe(3)
    expect(i.detail).toBe('2 drafts · 1 agent action · an approved draft waits: no worker is connected')
    expect(item({ ...ZERO, draftsAwaiting: 1 }, { ...BARE, worker: true }, LIVE, 'approvals').detail).toBe('1 draft')
  })

  it('a zero in approvals names why the agent raises none here', () => {
    expect(item(ZERO, BARE, NO_WORKER, 'approvals').detail).toBe(
      'None waiting. The agent raises none here: no worker is connected.',
    )
    expect(item(ZERO, BARE, LIVE_ELSEWHERE, 'approvals').detail).toContain(
      'this deployment is not configured to reach the worker',
    )
    expect(item(ZERO, { ...BARE, worker: true }, LIVE, 'approvals').detail).toBeNull()
  })

  it('compliance counts failing checks, is an alarm when any fail, and is left out when the viewer may not read it', () => {
    const one = item({ ...ZERO, complianceChecksFailing: 1 }, { ...BARE, worker: true }, LIVE, 'compliance')
    expect(one).toMatchObject({ n: 1, alarm: true, label: 'compliance check that must be zero is not' })
    expect(item({ ...ZERO, complianceChecksFailing: 2 }, BARE, NO_WORKER, 'compliance').label).toBe(
      'compliance checks that must be zero are not',
    )
    expect(needsALook({ ...ZERO, complianceChecksFailing: null }, BARE, NO_WORKER).map((i) => i.id)).not.toContain(
      'compliance',
    )
    expect(needsALook(ZERO, BARE, NO_WORKER)[0]?.id).toBe('compliance')
  })

  it('a compliance zero with nothing sending says it is "none recorded", not "none happened"', () => {
    expect(item(ZERO, BARE, NO_WORKER, 'compliance').detail).toMatch(
      /^None recorded, which is not the same as none happened: no worker is connected/,
    )
    expect(item(ZERO, { ...BARE, worker: true }, LIVE, 'compliance')).toMatchObject({ detail: null, alarm: false })
  })

  it('states the stale threshold it was given, and says when nothing rescans', () => {
    const stale = item({ ...ZERO, companiesStale: 4, staleAfterDays: 21 }, BARE, NO_WORKER, 'companies-stale')
    expect(stale.label).toBe('companies with evidence older than 21 days')
    expect(stale.detail).toBe('Nothing rescans on its own here: no CRON_SECRET is set.')
    expect(item({ ...ZERO, companiesStale: 1, staleAfterDays: 1 }, BARE, NO_WORKER, 'companies-stale').label).toBe(
      'company with evidence older than 1 day',
    )
    expect(item({ ...ZERO, companiesStale: 4 }, { ...BARE, cron: true }, NO_WORKER, 'companies-stale').detail).toBeNull()
    expect(item(ZERO, BARE, NO_WORKER, 'companies-stale').detail).toBeNull()
  })

  it('never renders a number it was not given', () => {
    const c: LookCounts = {
      repliesUnhandled: 1, draftsAwaiting: 2, approvalsPending: 3, dealsRotting: 4, dealsOverdue: 5, tasksOverdue: 6,
      companiesStale: 7, companiesNeverScanned: 8, companiesUnreachable: 9, staleAfterDays: 14, complianceChecksFailing: 10,
    }
    expect(Object.fromEntries(needsALook(c, BARE, NO_WORKER).map((i) => [i.id, i.n]))).toEqual({
      compliance: 10, replies: 1, approvals: 5, 'deals-rotting': 4, 'deals-overdue': 5, 'tasks-overdue': 6,
      'companies-stale': 7, 'companies-never-scanned': 8, 'companies-unreachable': 9,
    })
  })
})

describe('splitLook', () => {
  it('shows a card for a number or a qualification, and lists the clean zeros', () => {
    const { waiting, clear } = splitLook(needsALook({ ...ZERO, tasksOverdue: 2 }, BARE, NO_WORKER))
    // replies, approvals and compliance are zeros whose recorder is absent:
    // "none recorded" is a card, never folded into "nothing waiting".
    expect(waiting.map((i) => i.id)).toEqual(['compliance', 'replies', 'approvals', 'tasks-overdue'])
    expect(clear.map((i) => i.id)).toEqual([
      'deals-rotting', 'deals-overdue', 'companies-stale', 'companies-never-scanned', 'companies-unreachable',
    ])
  })

  it('folds every zero into the clear line when every recorder is present', () => {
    const everything: Deployment = { ...BARE, worker: true, inbound: 'webhook', cron: true }
    expect(splitLook(needsALook(ZERO, everything, LIVE)).waiting).toEqual([])
  })
})

describe('dealsNeedingALook', () => {
  const day = 86_400_000
  const deal = (over: Partial<Parameters<typeof dealsNeedingALook>[0][number]>) => ({
    stage: 'contacted',
    createdAt: new Date(NOW.getTime() - 30 * day),
    updatedAt: new Date(NOW.getTime() - day),
    closedAt: null,
    nextActionAt: null,
    ...over,
  })

  it('counts open deals past their stage limit from updated_at, as the board does', () => {
    expect(dealsNeedingALook([deal({ updatedAt: new Date(NOW.getTime() - 10 * day) })], NOW).rotting).toBe(1)
    expect(dealsNeedingALook([deal({ updatedAt: new Date(NOW.getTime() - 9 * day) })], NOW).rotting).toBe(0)
    // No update yet: measured from creation.
    expect(dealsNeedingALook([deal({ updatedAt: null })], NOW).rotting).toBe(1)
  })

  it('counts an open deal past its due date, and not one with no due date', () => {
    expect(dealsNeedingALook([deal({ nextActionAt: new Date(NOW.getTime() - 1) })], NOW).overdue).toBe(1)
    expect(dealsNeedingALook([deal({ nextActionAt: NOW })], NOW).overdue).toBe(0)
    expect(dealsNeedingALook([deal({})], NOW).overdue).toBe(0)
  })

  it('ignores a closed deal entirely — an outcome neither rots nor falls due', () => {
    const closed = deal({
      stage: 'won',
      closedAt: new Date(NOW.getTime() - day),
      updatedAt: new Date(NOW.getTime() - 90 * day),
      nextActionAt: new Date(NOW.getTime() - 5 * day),
    })
    const reopenedLookingStage = deal({ ...closed, stage: 'contacted' })
    expect(dealsNeedingALook([closed, reopenedLookingStage], NOW)).toEqual({ rotting: 0, overdue: 0 })
  })
})

describe('complianceChecksFailing', () => {
  const clean = {
    undisclosedCalls: 0, optOutsWithoutSuppression: 0, optOutsNotStoredLastWindow: 0,
    optInChannelMessagesWithoutOptIn: 0, draftsOnStaleEvidence: 0, autoSendOnOptInChannels: 0,
  }

  it('counts CHECKS, never adds calls to opt-outs to messages', () => {
    expect(complianceChecksFailing(clean)).toBe(0)
    expect(complianceChecksFailing({ ...clean, optOutsWithoutSuppression: 40 })).toBe(1)
    expect(complianceChecksFailing({ ...clean, undisclosedCalls: 1, draftsOnStaleEvidence: 7 })).toBe(2)
  })

  it('counts every one of the six', () => {
    const all = Object.fromEntries(Object.keys(clean).map((k) => [k, 1])) as typeof clean
    expect(complianceChecksFailing(all)).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

const PRIYA = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
const GONE = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0002'
const APPROVER = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0003'
const DEAL = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c00d1'

const row = (over: Partial<FeedRow>): FeedRow => ({
  id: '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0ca001',
  createdAt: new Date('2026-09-30T11:58:00Z'),
  action: 'deal.moved',
  actor: PRIYA,
  subjectType: 'deal',
  subjectId: DEAL,
  detail: { from: 'replied', to: 'meeting' },
  ...over,
})

describe('feedPersonIds', () => {
  it('collects the actor, a user subject and a …By / …UserId key, and no literal actor', () => {
    const got = feedPersonIds([
      row({}),
      row({ id: 'b', actor: 'system', subjectType: 'user', subjectId: GONE }),
      row({ id: 'c', actor: 'agent', detail: { approvedBy: APPROVER, ownerUserId: 'not-a-uuid' } }),
    ])
    expect(got.sort()).toEqual([PRIYA, GONE, APPROVER].sort())
  })
})

describe('feedLines', () => {
  const companies = new Map([[row({}).id, { domain: 'rentman.io', name: 'Rentman' }]])
  const people = new Map([[PRIYA, { email: 'priya@agency.test', name: 'Priya', revoked: false }]])

  it('reads a row the way /audit does: the sentence, who, where, and the raw row', () => {
    const [line] = feedLines([row({})], companies, people)
    expect(line).toMatchObject({
      at: '2026-09-30T11:58:00.000Z',
      who: 'Priya',
      whoNote: null,
      isPerson: true,
      sentence: 'moved rentman.io from replied to meeting',
      href: '/companies/rentman.io',
      alarm: false,
      action: 'deal.moved',
    })
    expect(JSON.parse(line!.detail)).toEqual({ from: 'replied', to: 'meeting' })
  })

  it('names a process as itself and a missing person as a former teammate', () => {
    const [agent, gone] = feedLines([row({ actor: 'agent' }), row({ id: 'x', actor: GONE })], companies, people)
    expect(agent).toMatchObject({ who: 'agent', isPerson: false })
    expect(gone).toMatchObject({ who: 'a former teammate', isPerson: true })
  })

  it('marks an opt-out that was not stored, so it cannot be scrolled past', () => {
    const [line] = feedLines(
      [row({ action: 'contact.opt_out_not_recorded', actor: 'system', subjectType: 'contact', detail: { channel: 'email' } })],
      new Map(),
      people,
    )
    expect(line!.alarm).toBe(true)
    expect(line!.sentence).toContain('it is NOT on the suppression list')
  })

  it('shows an action nobody wrote a sentence for as its raw name', () => {
    expect(feedLines([row({ action: 'thing.happened' })], companies, people)[0]!.sentence).toBe('thing.happened')
  })
})

describe('quietFeedNote', () => {
  it('says why no sends or replies appear when no worker is connected', () => {
    expect(quietFeedNote(BARE, NO_WORKER)).toBe('No worker is connected, so no sends or replies appear here.')
  })

  it('names the quiet half only', () => {
    expect(quietFeedNote({ ...BARE, inbound: 'webhook' }, NO_WORKER)).toBe(
      'No worker is connected, so no sends appear here; replies still arrive through the inbound webhook.',
    )
    expect(quietFeedNote({ ...BARE, worker: true }, { ...LIVE, outreach: 'send-only' })).toBe(
      'The worker is not reading a mailbox and no inbound webhook is configured, so no replies appear here.',
    )
    expect(quietFeedNote({ ...BARE, worker: true }, { ...LIVE, outreach: 'receive-only' })).toBe(
      'The worker is not sending, so no sends appear here; replies still arrive.',
    )
    expect(quietFeedNote({ ...BARE, worker: true }, SILENT)).toBe(
      'The worker has gone quiet, so no sends or replies appear here.',
    )
    expect(quietFeedNote(BARE, RETIRED)).toBe(
      'The last worker to report in has retired, so no sends or replies appear here.',
    )
  })

  it('with only DoveSoft’s webhook, says the email half is quiet and texts still arrive (0019)', () => {
    const sms = { ...BARE, smsInbound: true }
    expect(quietFeedNote(sms, NO_WORKER)).toBe(
      'No worker is connected, so no sends or email replies appear here; texts still arrive, through DoveSoft’s webhook.',
    )
    expect(quietFeedNote({ ...sms, worker: true }, SILENT)).toBe(
      'The worker has gone quiet, so no sends or email replies appear here; texts still arrive, through DoveSoft’s webhook.',
    )
    expect(quietFeedNote({ ...sms, worker: true }, { ...LIVE, outreach: 'send-only' })).toBe(
      'The worker is not reading a mailbox and no inbound email webhook is configured, so no email replies appear here; ' +
        'texts still arrive, through DoveSoft’s webhook.',
    )
    expect(quietFeedNote({ ...sms, worker: true }, { ...LIVE, outreach: null })).toBe(
      'The worker has not said that it sends and no inbound email webhook is configured, so no sends or email replies appear here; ' +
        'texts still arrive, through DoveSoft’s webhook.',
    )
    // An email recorder is there: only the sending half is quiet.
    expect(quietFeedNote({ ...sms, inbound: 'webhook' }, NO_WORKER)).toBe(
      'No worker is connected, so no sends appear here; replies still arrive through the inbound webhook.',
    )
    expect(quietFeedNote({ ...sms, worker: true }, LIVE)).toBeNull()
  })

  it('is silent itself when the worker sends and a reply can arrive', () => {
    expect(quietFeedNote({ ...BARE, worker: true }, LIVE)).toBeNull()
    expect(quietFeedNote({ ...BARE, inbound: 'webhook' }, { ...LIVE, outreach: 'send-only' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('dashboard-view.ts loads outside Next', () => {
  const src = read('../src/lib/dashboard-view.ts')

  it('carries no server-only, no @/ import and no env()', () => {
    expect(src).not.toMatch(/^import .*['"]server-only['"]/m)
    expect(src).not.toMatch(/from ['"]@\//)
    expect(code(src)).not.toMatch(/\benv\(/)
    expect(code(src)).not.toMatch(/process\.env/)
  })

  it('imports Deployment as a type', () => {
    expect(src).toMatch(/^import type \{ Deployment \} from '\.\/deployment-facts'$/m)
  })
})

describe('the dashboard page', () => {
  const src = code(read('../src/app/page.tsx'))

  it('is dynamic and on the Node runtime, like every page', () => {
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(src).toMatch(/export const runtime = 'nodejs'/)
  })

  it('takes every sentence from dashboard-view rather than writing its own', () => {
    for (const fn of ['honestyHeadline', 'honestyBullets', 'workerLine', 'needsALook', 'feedLines', 'quietFeedNote']) {
      expect(src).toContain(`${fn}(`)
    }
    expect(src).not.toMatch(/Phases? \d/)
  })

  it('reads the stale threshold from the ICP, never a literal', () => {
    expect(src).toMatch(/readIcp\(icp\?\.definition\)/)
    expect(src).not.toMatch(/staleAfterDays:\s*\d/)
  })

  it('links the Contacts total to /contacts', () => {
    expect(src).toMatch(/href="\/contacts"><div className="n">\{c\.contacts\}/)
  })

  /**
   * CLAUDE.md §4 called this table "the one place left that overstates"
   * the profile's outreach block: it showed `outreach.channels` and
   * `max_per_day` under bare "Channels" and "Daily cap" headings, as if the
   * send path applied them. It applies each CAMPAIGN's channel, cap and
   * quiet hours, and reads neither value.
   */
  describe('the Active ICP table', () => {
    const table = src.slice(src.indexOf('<h2>Active ICP</h2>'), src.indexOf('<h2>', src.indexOf('<h2>Active ICP</h2>') + 1))

    it('is found, so the checks below read the table and not an empty string', () => {
      expect(table).toContain('<table>')
      expect(table).toContain('{dailyCap')
    })

    it('never heads the profile’s channels or cap as if they were the operative values', () => {
      expect(table).not.toMatch(/<th>Channels<\/th>|<th>Daily cap<\/th>/)
      expect(table).toContain('<th>Channels it describes</th>')
      expect(table).toContain('<th>Daily cap it describes</th>')
    })

    it('says what the send path applies instead, and links to where those caps live', () => {
      expect(table).toContain('{ICP_OUTREACH_NOTE}')
      expect(table).toMatch(/<a href="\/campaigns">/)
      expect(ICP_OUTREACH_NOTE).toBe(
        'The channels and daily cap are what this profile describes, not what the send path enforces: each campaign ' +
          'applies its own channel, daily cap and quiet hours.',
      )
    })
  })
})

/**
 * The SMS the dashboard words comes from the worker's own heartbeat:
 * `senderProvidersFrom` decides it once at boot and the heartbeat's
 * `detail` carries it. Pinned by source, because the worker cannot be
 * imported here; a rename there fails this rather than leaving every row
 * `sms: null` and the dashboard silent about texts that are going.
 */
describe('the worker writes what the dashboard reads about SMS', () => {
  const worker = code(read('../../agent/src/worker.ts'))

  it('puts sms beside halted and lockHeld in the heartbeat’s detail — and, since 0020, whether it writes the brief', () => {
    expect(worker).toContain(
      "detail: { halted: now.halted, lockHeld: now.lockHeld, sms: senders.sms, brief: credential ? 'on' : 'off' }",
    )
    expect(worker).toContain("sms: dovesoft.on ? 'on' : 'off',")
  })
})
