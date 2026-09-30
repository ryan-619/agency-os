/**
 * The daily cron's pure half (§2.3, §2.4): when the worker counts as
 * silent, and what the two Slack events built from the digest carry.
 *
 * The alert that the worker is silent cannot come from the worker, so it
 * comes from this check on the web half — and it must agree with the
 * digest's own "Worker:" line, which `heartbeatReport` writes from the same
 * row. The agreement is asserted over a grid rather than argued in a comment.
 *
 * The route itself cannot be imported here (it reaches `server-only`
 * through `@/lib/db`), which is why its events are built by
 * `notification.ts` beside it. The last block reads the route's source to
 * pin the gate, the ceiling and the log lines.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_RETIRED_AFTER_DAYS, HEARTBEAT_SILENT_AFTER_SECONDS, heartbeatReport, heartbeatSilentAfter, type DigestFacts,
} from '@agency/db/queries'
import { WORKER_SILENT_AFTER_SECONDS, workerSilent } from '../src/lib/worker-check'
import { slackMessage } from '../src/lib/slack-message'
import {
  campaignPausedNotification, digestNotification, workerSilentNotification,
} from '../src/app/api/cron/digest/notification'

const NOW = new Date('2026-09-30T06:43:00.000Z')
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000)
const ORG = '00000000-0000-4000-8000-00000000000a'
const ORIGIN = 'https://agency.example/'

describe('workerSilent', () => {
  it('uses the heartbeat reader’s default threshold, restated rather than imported', () => {
    expect(WORKER_SILENT_AFTER_SECONDS).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
  })

  it('is silent when a worker is configured and has never been heard from', () => {
    expect(workerSilent({ configured: true, lastSeenAt: null }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: null })
  })

  it('is live up to the threshold, inclusive, and silent one second past it', () => {
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(15) }, NOW)).toEqual({ silent: false, retired: false, ageSeconds: 15 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(600) }, NOW)).toEqual({ silent: false, retired: false, ageSeconds: 600 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(601) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: 601 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(86_400) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: 86_400 })
  })

  it('is not silent where no worker is configured and none ever wrote — that deployment says "nothing will send" instead', () => {
    expect(workerSilent({ configured: false, lastSeenAt: null }, NOW)).toEqual({ silent: false, retired: false, ageSeconds: null })
  })

  /**
   * The documented production shape: Vercel with no AGENT_URL, a worker on
   * Fly. The web half is not "configured" for a worker, and one has been
   * writing heartbeats — then stopped. The row is the observation, and an
   * observation beats configuration: it is silent, as the digest's Worker
   * line already said — for a week, after which it is retired (below).
   */
  it('is silent where a worker wrote a heartbeat and stopped, configured here or not', () => {
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(86_400) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: 86_400 })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(601) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: 601 })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(15) }, NOW)).toEqual({ silent: false, retired: false, ageSeconds: 15 })
    expect(workerSilent({ configured: false, lastSeenAt: new Date(Number.NaN) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: null })
  })

  /**
   * `./tools/run-worker.sh` run once against production and closed leaves a
   * row nothing will ever prune. Where no worker is configured, a row older
   * than a week is that session, retired: named in the digest, alerted
   * about by nobody. A worker that was running and stopped still gets a
   * week of notices, and a configured one is silent however long it stays so.
   */
  it('is not silent, but retired, where no worker is configured and the row is more than a week old', () => {
    const week = HEARTBEAT_RETIRED_AFTER_DAYS * 86_400
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(week + 1) }, NOW)).toEqual({
      silent: false, retired: true, ageSeconds: week + 1,
    })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(90 * 86_400) }, NOW)).toMatchObject({ silent: false, retired: true })
    // Six days, and a week to the second: a worker that stopped, still worth the notice.
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(6 * 86_400) }, NOW)).toEqual({
      silent: true, retired: false, ageSeconds: 6 * 86_400,
    })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(week) }, NOW)).toMatchObject({ silent: true, retired: false })
    // Configured: today's rule, whatever the age.
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(90 * 86_400) }, NOW)).toEqual({
      silent: true, retired: false, ageSeconds: 90 * 86_400,
    })
    // An unreadable timestamp is not evidence of age either: silent, not retired.
    expect(workerSilent({ configured: false, lastSeenAt: new Date(Number.NaN) }, NOW)).toMatchObject({ silent: true, retired: false })
  })

  it('honours the threshold a slow-ticking worker earns', () => {
    // A worker ticking every 20 minutes is on time eleven minutes after its last write.
    const earned = heartbeatSilentAfter({ detail: { intervalMs: 20 * 60_000 } })
    expect(earned).toBe(3600)
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(660) }, NOW, earned).silent).toBe(false)
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(3601) }, NOW, earned).silent).toBe(true)
  })

  it('reads a heartbeat from the future as clock skew, not as a negative age', () => {
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(-5) }, NOW)).toEqual({ silent: false, retired: false, ageSeconds: 0 })
  })

  it('reads a threshold that is not a positive number as the default, never as "nothing is ever silent"', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(601) }, NOW, bad).silent, String(bad)).toBe(true)
      expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(599) }, NOW, bad).silent, String(bad)).toBe(false)
    }
  })

  it('treats an unreadable timestamp as never heard from', () => {
    expect(workerSilent({ configured: true, lastSeenAt: new Date(Number.NaN) }, NOW)).toEqual({ silent: true, retired: false, ageSeconds: null })
  })

  /**
   * Configured or not, with a row or without: the route passes the row's own
   * threshold, heartbeatReport uses the same one, and the alert fires exactly
   * when the digest's Worker line reads SILENT or NEVER — and never when it
   * reads RETIRED. `configured: false` with a row present is the case the
   * grid used to leave out, and the one that disagreed; a row past a week,
   * and a slow worker whose own threshold is longer than a week, are the
   * ones the retirement rule added.
   */
  it('agrees with the digest’s Worker line on every deployment', () => {
    const DAY = 86_400
    const week = HEARTBEAT_RETIRED_AFTER_DAYS * DAY
    for (const configured of [true, false]) {
      for (const intervalMs of [undefined, 15_000, 20 * 60_000, 3 * DAY * 1000]) {
        for (const age of [null, 0, 599, 600, 601, 3599, 3600, 3601, 86_400, week - 1, week, week + 1, 9 * DAY + 1, 30 * DAY]) {
          const row =
            age === null
              ? null
              : { lastTickAt: secondsAgo(age), outreach: 'send-and-receive', chat: 'enabled', detail: intervalMs ? { intervalMs } : {} }
          const report = heartbeatReport(row, configured, NOW)
          const check = workerSilent({ configured, lastSeenAt: row?.lastTickAt ?? null }, NOW, heartbeatSilentAfter(row))
          const cell = `configured ${String(configured)}, interval ${String(intervalMs)}, age ${String(age)}`
          expect(check.silent, cell).toBe((report.status === 'silent' && !report.retired) || report.status === 'never')
          expect(check.retired, cell).toBe(report.retired)
          expect(check.ageSeconds).toBe(report.ageSeconds)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------

const FACTS: DigestFacts = {
  pendingApprovals: 3,
  unhandledReplies: 2,
  rottingDeals: 4,
  staleCompanies: 5,
  neverScanned: 1,
  dueTasks: 2,
  overdueTasks: 1,
  refusals24h: [{ code: 'no_consent', n: 3 }, { code: 'suppressed', n: 1 }],
  optOutsNotRecorded24h: 1,
  spend24hUsd: '0.51',
  topRotting: ['jane-doe-gmail-com.inbound', 'rentman.io'],
}

/** What a careless caller might hang off the facts: a person, their words, an address. */
const DECOYS = {
  contactEmail: 'DECOY jane.doe@acme.example',
  lastReplyBody: 'DECOY please stop emailing me',
  ownerName: 'DECOY Priya',
}

/** The digest's arguments beside the facts: a worker heard from a minute ago, and no campaign paused. */
const QUIET = { workerLastSeenAt: secondsAgo(60), campaignPauses: { found: 0, notices: 0 } } as const

describe('digestNotification', () => {
  it('copies the facts field by field and nothing else', () => {
    const event = digestNotification({ orgId: ORG, facts: { ...FACTS, ...DECOYS } as DigestFacts, worker: 'live', ...QUIET })
    expect(event).toEqual({
      kind: 'digest', orgId: ORG, worker: 'live', workerLastSeenAt: '2026-09-30T06:42:00.000Z',
      campaignPauses: { found: 0, notices: 0 }, ...FACTS,
    })
    expect(JSON.stringify(event)).not.toContain('DECOY')
  })

  it('puts no address, no body and no free-mail row name on the wire', () => {
    const wire = JSON.stringify(
      slackMessage(digestNotification({ orgId: ORG, facts: { ...FACTS, ...DECOYS } as DigestFacts, worker: 'silent', ...QUIET }), ORIGIN),
    )
    expect(wire).not.toContain('DECOY')
    expect(wire).not.toContain('@')
    expect(wire).not.toContain('jane')
    expect(wire).toContain('a personal address')
    expect(wire).toContain('rentman.io')
  })

  it('says the counts, the refusals in words, the unrecorded opt-out and the silent worker out loud', () => {
    const { text } = slackMessage(digestNotification({ orgId: ORG, facts: FACTS, worker: 'silent', ...QUIET }), ORIGIN)
    expect(text).toContain('Approvals pending: 3')
    expect(text).toContain('replies unhandled: 2')
    expect(text).toContain('Companies stale: 5 · never scanned: 1')
    expect(text).toContain('Tasks due: 2 (overdue: 1)')
    expect(text).toContain('NEEDS A PERSON: 1 opt-out(s)')
    expect(text).toContain('USD 0.51')
    expect(text).toContain('SILENT')
    expect(text).not.toContain('no_consent')
    // The link is the dashboard — by path, never built from a domain.
    expect(text.trim().split('\n').at(-1)).toBe('https://agency.example/')
  })

  it('does not share the facts’ arrays with the event', () => {
    const event = digestNotification({ orgId: ORG, facts: FACTS, worker: 'live', ...QUIET })
    expect(event.topRotting).not.toBe(FACTS.topRotting)
    expect(event.refusals24h).not.toBe(FACTS.refusals24h)
  })

  /** A session somebody ran by hand and closed: named, dated, and not called SILENT. */
  it('names a retired worker with the day it was last seen, and does not call it silent', () => {
    const { text } = slackMessage(
      digestNotification({ orgId: ORG, facts: FACTS, worker: 'retired', ...QUIET, workerLastSeenAt: secondsAgo(12 * 86_400) }),
      ORIGIN,
    )
    expect(text).toContain('Worker: retired — last seen 2026-09-18; no worker is configured')
    expect(text).not.toContain('SILENT')
  })

  /**
   * Pauses past the cap get no notice of their own. The digest — posted
   * before the notices — says how many more there were, and where they are:
   * a count and a link, never a campaign's name.
   */
  it('says how many more campaigns paused themselves than the notices that follow', () => {
    const say = (found: number, notices: number) =>
      slackMessage(digestNotification({ orgId: ORG, facts: FACTS, worker: 'live', ...QUIET, campaignPauses: { found, notices } }), ORIGIN).text
    expect(say(5, 3)).toContain('and 2 more campaigns paused themselves — see https://agency.example/campaigns')
    expect(say(4, 3)).toContain('and 1 more campaign paused itself — see https://agency.example/campaigns')
    for (const [found, notices] of [[0, 0], [1, 1], [3, 3]] as const) expect(say(found, notices)).not.toContain('more campaign')
    // The dashboard is still the digest's own link, last.
    expect(say(5, 3).trim().split('\n').at(-1)).toBe('https://agency.example/')
  })
})

describe('workerSilentNotification', () => {
  it('carries the last tick as an instant and its age, and nothing else', () => {
    expect(workerSilentNotification({ orgId: ORG, lastSeenAt: secondsAgo(900), ageSeconds: 900 })).toEqual({
      kind: 'worker_silent',
      orgId: ORG,
      lastTickAt: '2026-09-30T06:28:00.000Z',
      ageSeconds: 900,
    })
  })

  it('says a worker that never ticked never ticked', () => {
    const event = workerSilentNotification({ orgId: ORG, lastSeenAt: null, ageSeconds: null })
    expect(event.lastTickAt).toBeNull()
    const { text } = slackMessage(event, ORIGIN)
    expect(text).toContain('never ticked')
    expect(text).toContain('Approved messages are not being sent')
  })
})

describe('campaignPausedNotification', () => {
  const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1'

  /** The worker pauses the campaign and cannot post; this is the notice it could not send. */
  it('carries the campaign’s id and the two numbers the pause was made on, and nothing else', () => {
    const pause = { campaignId: CAMPAIGN, bouncePct: 12, threshold: 5, name: 'DECOY Q4 list', sentTo: 25 }
    const event = campaignPausedNotification({ orgId: ORG, pause })
    expect(event).toEqual({ kind: 'campaign_paused', orgId: ORG, campaignId: CAMPAIGN, bouncePct: 12, threshold: 5 })
    expect(JSON.stringify(event)).not.toContain('DECOY')
  })

  it('says what stopped and links to the campaigns page — never a name or an address', () => {
    const { text } = slackMessage(campaignPausedNotification({ orgId: ORG, pause: { campaignId: CAMPAIGN, bouncePct: 12, threshold: 5 } }), ORIGIN)
    expect(text).toContain('Campaign paused itself')
    expect(text).toContain('12%')
    expect(text).toContain(CAMPAIGN)
    expect(text.trim().split('\n').at(-1)).toBe('https://agency.example/campaigns')
    expect(text).not.toContain('@')
  })
})

// ---------------------------------------------------------------------------

/**
 * `/api/health` reads the same report (`workerStatus` → `heartbeatReport`)
 * and cannot be imported here either (`server-only` through `@/lib/db`), so
 * its worker block is pinned by its source: a retired row reads `retired`
 * there as it does in the digest, not `silent`.
 */
describe('GET /api/health’s worker block, from its source', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const health = readFileSync(resolve(here, '../src/app/api/health/route.ts'), 'utf8')

  it('reports the status the digest line says, retired included', () => {
    expect(health).toMatch(/status: heartbeatReportedStatus\(s\)/)
    expect(health).toMatch(/status: HeartbeatReportedStatus/)
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/cron/digest, from its source', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const route = readFileSync(resolve(here, '../src/app/api/cron/digest/route.ts'), 'utf8')
  const builders = readFileSync(resolve(here, '../src/app/api/cron/digest/notification.ts'), 'utf8')

  it('is behind the cron gate, never cached, and bounded', () => {
    expect(route).toMatch(/cronRequest\(\{/)
    expect(route).toContain("export const runtime = 'nodejs'")
    expect(route).toContain("export const dynamic = 'force-dynamic'")
    expect(route).toContain('export const maxDuration = 60')
  })

  it('runs each org inside the once-a-window lock and writes through its handle', () => {
    expect(route).toMatch(/digestOnce\(db, orgId, since,/)
    expect(route).toMatch(/appendAudit\(tx, entry\)/)
    expect(route).toMatch(/digestFacts\(tx,/)
    // notify() opens its own connection and says nothing about what it did.
    expect(route).not.toMatch(/\bnotify\(/)
  })

  it('logs the route and the outcome, and at most an error class — never a URL or a count', () => {
    const calls = [...route.matchAll(/log\.\w+\('[^']*', \{([^}]*)\}/g)]
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const [, fields] of calls) {
      const keys = fields!.split(',').map((f) => f.split(':')[0]!.trim()).filter(Boolean)
      for (const k of keys) expect(['route', 'outcome', 'error'], fields).toContain(k)
    }
  })

  /**
   * The pauses are read and posted INSIDE digestOnce, through its handle, so
   * the once-per-day guard that keeps the digest from posting twice keeps
   * them from being announced twice; and read BEFORE digestRecord, so the
   * previous run's row still marks where the last announcement stopped.
   */
  it('announces each campaign that paused itself inside the once-a-window run, after the digest', () => {
    const inside = route.slice(route.indexOf('digestOnce(db, orgId, since,'))
    const read = inside.indexOf('digestCampaignPauses(tx, orgId,')
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(inside.indexOf('digestRecord(tx,'))
    const digestPost = inside.indexOf('post(tx, slack, digestNotification(')
    const pausePost = inside.indexOf('post(tx, slack, campaignPausedNotification(')
    expect(pausePost).toBeGreaterThan(digestPost)
    expect(inside.indexOf('workerSilentNotification(')).toBeGreaterThan(pausePost)
    // The budget an org is started with covers every notice it may post.
    expect(route).toMatch(/const ORG_BUDGET_MS = 15_000 \+ DIGEST_MAX_PAUSE_NOTICES \* 3_000/)
  })

  /**
   * The next run reads strictly after the mark this one records, so a
   * `cron.digest` row without it would send the next run back to the
   * timestamp comparison that read some pauses twice and others never.
   */
  it('records the mark the pauses were read through on every path, posted or not', () => {
    const records = [...route.matchAll(/digestRecord\(tx, \{[\s\S]*?\}\)/g)].map((m) => m[0])
    expect(records.length).toBeGreaterThanOrEqual(3)
    for (const r of records) expect(r, r).toContain('campaignPauses')
    expect(route.match(/readThrough: pauses\.readThrough/g)).toHaveLength(2)
  })

  /** A closed session is named, not alerted on: the status the digest line reads is the one the alert's rule agrees with. */
  it('names a retired worker in the digest line and the record, and alerts only on workerSilent', () => {
    expect(route).toMatch(/const worker = heartbeatReportedStatus\(report\)/)
    expect(route).toMatch(/const base = \{ orgId, counts, worker \} as const/)
    expect(route).not.toMatch(/worker: report\.status/)
    expect(route).toMatch(/if \(silence\.silent\) \{/)
  })

  it('builds events by name, never by spreading the facts', () => {
    // `...f` or `...args` as a whole object; copying one array (`[...f.topRotting]`) is fine.
    expect(builders).not.toMatch(/\.\.\.\s*(args\.facts|args|facts|f)\s*[,}\n]/)
    expect(builders).toContain('topRotting: [...f.topRotting]')
  })
})
