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
  HEARTBEAT_SILENT_AFTER_SECONDS, heartbeatReport, heartbeatSilentAfter, type DigestFacts,
} from '@agency/db/queries'
import { WORKER_SILENT_AFTER_SECONDS, workerSilent } from '../src/lib/worker-check'
import { slackMessage } from '../src/lib/slack-message'
import { digestNotification, workerSilentNotification } from '../src/app/api/cron/digest/notification'

const NOW = new Date('2026-09-30T06:43:00.000Z')
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000)
const ORG = '00000000-0000-4000-8000-00000000000a'
const ORIGIN = 'https://agency.example/'

describe('workerSilent', () => {
  it('uses the heartbeat reader’s default threshold, restated rather than imported', () => {
    expect(WORKER_SILENT_AFTER_SECONDS).toBe(HEARTBEAT_SILENT_AFTER_SECONDS)
  })

  it('is silent when a worker is configured and has never been heard from', () => {
    expect(workerSilent({ configured: true, lastSeenAt: null }, NOW)).toEqual({ silent: true, ageSeconds: null })
  })

  it('is live up to the threshold, inclusive, and silent one second past it', () => {
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(15) }, NOW)).toEqual({ silent: false, ageSeconds: 15 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(600) }, NOW)).toEqual({ silent: false, ageSeconds: 600 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(601) }, NOW)).toEqual({ silent: true, ageSeconds: 601 })
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(86_400) }, NOW)).toEqual({ silent: true, ageSeconds: 86_400 })
  })

  it('is not silent where no worker is configured and none ever wrote — that deployment says "nothing will send" instead', () => {
    expect(workerSilent({ configured: false, lastSeenAt: null }, NOW)).toEqual({ silent: false, ageSeconds: null })
  })

  /**
   * The documented production shape: Vercel with no AGENT_URL, a worker on
   * Fly. The web half is not "configured" for a worker, and one has been
   * writing heartbeats — then stopped. The row is the observation, and an
   * observation beats configuration: it is silent, as the digest's Worker
   * line already said.
   */
  it('is silent where a worker wrote a heartbeat and stopped, configured here or not', () => {
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(86_400) }, NOW)).toEqual({ silent: true, ageSeconds: 86_400 })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(601) }, NOW)).toEqual({ silent: true, ageSeconds: 601 })
    expect(workerSilent({ configured: false, lastSeenAt: secondsAgo(15) }, NOW)).toEqual({ silent: false, ageSeconds: 15 })
    expect(workerSilent({ configured: false, lastSeenAt: new Date(Number.NaN) }, NOW)).toEqual({ silent: true, ageSeconds: null })
  })

  it('honours the threshold a slow-ticking worker earns', () => {
    // A worker ticking every 20 minutes is on time eleven minutes after its last write.
    const earned = heartbeatSilentAfter({ detail: { intervalMs: 20 * 60_000 } })
    expect(earned).toBe(3600)
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(660) }, NOW, earned).silent).toBe(false)
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(3601) }, NOW, earned).silent).toBe(true)
  })

  it('reads a heartbeat from the future as clock skew, not as a negative age', () => {
    expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(-5) }, NOW)).toEqual({ silent: false, ageSeconds: 0 })
  })

  it('reads a threshold that is not a positive number as the default, never as "nothing is ever silent"', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(601) }, NOW, bad).silent, String(bad)).toBe(true)
      expect(workerSilent({ configured: true, lastSeenAt: secondsAgo(599) }, NOW, bad).silent, String(bad)).toBe(false)
    }
  })

  it('treats an unreadable timestamp as never heard from', () => {
    expect(workerSilent({ configured: true, lastSeenAt: new Date(Number.NaN) }, NOW)).toEqual({ silent: true, ageSeconds: null })
  })

  /**
   * Configured or not, with a row or without: the route passes the row's own
   * threshold, heartbeatReport uses the same one, and the alert fires exactly
   * when the digest's Worker line reads SILENT or NEVER. `configured: false`
   * with a row present is the case the grid used to leave out, and the one
   * that disagreed.
   */
  it('agrees with the digest’s Worker line on every deployment', () => {
    for (const configured of [true, false]) {
      for (const intervalMs of [undefined, 15_000, 20 * 60_000]) {
        for (const age of [null, 0, 599, 600, 601, 3599, 3600, 3601, 86_400]) {
          const row =
            age === null
              ? null
              : { lastTickAt: secondsAgo(age), outreach: 'send-and-receive', chat: 'enabled', detail: intervalMs ? { intervalMs } : {} }
          const report = heartbeatReport(row, configured, NOW)
          const check = workerSilent({ configured, lastSeenAt: row?.lastTickAt ?? null }, NOW, heartbeatSilentAfter(row))
          expect(check.silent, `configured ${String(configured)}, interval ${String(intervalMs)}, age ${String(age)}`).toBe(
            report.status === 'silent' || report.status === 'never',
          )
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

describe('digestNotification', () => {
  it('copies the facts field by field and nothing else', () => {
    const event = digestNotification({ orgId: ORG, facts: { ...FACTS, ...DECOYS } as DigestFacts, worker: 'live' })
    expect(event).toEqual({ kind: 'digest', orgId: ORG, worker: 'live', ...FACTS })
    expect(JSON.stringify(event)).not.toContain('DECOY')
  })

  it('puts no address, no body and no free-mail row name on the wire', () => {
    const wire = JSON.stringify(
      slackMessage(digestNotification({ orgId: ORG, facts: { ...FACTS, ...DECOYS } as DigestFacts, worker: 'silent' }), ORIGIN),
    )
    expect(wire).not.toContain('DECOY')
    expect(wire).not.toContain('@')
    expect(wire).not.toContain('jane')
    expect(wire).toContain('a personal address')
    expect(wire).toContain('rentman.io')
  })

  it('says the counts, the refusals in words, the unrecorded opt-out and the silent worker out loud', () => {
    const { text } = slackMessage(digestNotification({ orgId: ORG, facts: FACTS, worker: 'silent' }), ORIGIN)
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
    const event = digestNotification({ orgId: ORG, facts: FACTS, worker: 'live' })
    expect(event.topRotting).not.toBe(FACTS.topRotting)
    expect(event.refusals24h).not.toBe(FACTS.refusals24h)
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

  it('builds events by name, never by spreading the facts', () => {
    // `...f` or `...args` as a whole object; copying one array (`[...f.topRotting]`) is fine.
    expect(builders).not.toMatch(/\.\.\.\s*(args\.facts|args|facts|f)\s*[,}\n]/)
    expect(builders).toContain('topRotting: [...f.topRotting]')
  })
})
