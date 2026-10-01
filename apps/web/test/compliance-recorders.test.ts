/**
 * /compliance says "none recorded" and names the recorder that is absent —
 * and whether a worker records anything is an OBSERVATION, the heartbeat,
 * never the web half's configuration.
 *
 * The documented production shape is Vercel without AGENT_URL and the worker
 * on Fly (or ./tools/run-worker.sh) sending and reading a mailbox against the
 * same database. `deployment().worker` is false there, and the page used to
 * put "No worker is connected, so nothing on this deployment sends" and "no
 * reply can arrive here" under its zeros, and a banner over the whole page,
 * while the dashboard beside it read the heartbeat and said the worker was
 * live. Review round 3, finding [20].
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { recorders, workerBanner } from '../src/app/compliance/recorders'
import type { WorkerStatusLike } from '../src/lib/dashboard-view'
import type { Deployment } from '../src/lib/deployment-facts'

const D = (over: Partial<Deployment> = {}): Deployment => ({
  worker: false,
  mailIsLocalSink: false,
  inbound: 'none',
  cron: false,
  slack: false,
  unsubscribe: true,
  ...over,
})

const W = (over: Partial<WorkerStatusLike> = {}): WorkerStatusLike => ({
  configured: false,
  status: 'live',
  retired: false,
  lastSeenAt: new Date('2026-10-01T09:58:00Z'),
  outreach: 'send-and-receive',
  chat: 'enabled',
  ...over,
})

describe('a live worker this web half is not configured to reach (Vercel + Fly)', () => {
  const live = W({ configured: false })

  it('is a recorder: nothing under a zero says nothing sends or no reply can arrive', () => {
    const a = recorders(D(), live)
    expect(a.sending).toBeNull()
    expect(a.replies).toBeNull()
  })

  it('raises no banner over the page', () => {
    expect(workerBanner(D(), live)).toBeNull()
  })

  it('still says the agent raises no approvals FROM HERE — chat needs this deployment to reach it', () => {
    expect(recorders(D(), live).agent).toContain('not configured to reach the worker')
  })
})

describe('a configured worker the heartbeat says is not doing the job', () => {
  it('names a quiet worker, although AGENT_URL is set', () => {
    const quiet = W({ configured: true, status: 'silent' })
    const a = recorders(D({ worker: true }), quiet)
    expect(a.sending).toBe('The worker has gone quiet, so nothing is being sent now.')
    expect(a.replies).toBe('The worker has gone quiet and no inbound webhook is configured, so no reply is arriving now.')
    expect(workerBanner(D({ worker: true }), quiet)?.lead).toBe('The worker has gone quiet.')
  })

  it('names a configured worker that has never reported in', () => {
    const a = recorders(D({ worker: true }), W({ configured: true, status: 'never', lastSeenAt: null, outreach: null, chat: null }))
    expect(a.sending).toContain('No worker has ever reported in to this database')
  })

  it('names a live worker that reports it does not send, or does not read a mailbox', () => {
    expect(recorders(D({ worker: true }), W({ configured: true, outreach: 'receive-only' })).sending).toBe(
      'The worker reports that it does not send, so nothing is being sent now.',
    )
    const sendOnly = recorders(D({ worker: true }), W({ configured: true, outreach: 'send-only' }))
    expect(sendOnly.sending).toBeNull()
    expect(sendOnly.replies).toContain('does not read a mailbox')
  })

  it('a webhook is a reply recorder whatever the worker is doing', () => {
    expect(recorders(D({ inbound: 'webhook' }), W({ status: 'silent' })).replies).toBeNull()
  })
})

describe('no worker anywhere', () => {
  const none = W({ configured: false, status: 'not_configured', lastSeenAt: null, outreach: null, chat: null })

  it('says what is configured and what was observed, together', () => {
    const a = recorders(D(), none)
    expect(a.sending).toBe('No worker is configured and none has reported in to this database, so nothing is being sent now.')
    expect(workerBanner(D(), none)?.lead).toBe('No worker is configured and none has reported in to this database.')
  })
})

describe('a heartbeat that could not be read', () => {
  it('falls back to configuration, worded as configuration', () => {
    const a = recorders(D(), null)
    for (const s of [a.sending, a.replies, a.agent, workerBanner(D(), null)?.lead]) {
      expect(s).toContain('configured')
      expect(s).not.toMatch(/No worker is connected|nothing on this deployment sends|no reply can arrive here/)
    }
  })

  it('says nothing where a worker is configured, as before', () => {
    const a = recorders(D({ worker: true }), null)
    expect(a.sending).toBeNull()
    expect(a.replies).toBeNull()
    expect(workerBanner(D({ worker: true }), null)).toBeNull()
  })
})

describe('the page', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/app/compliance/page.tsx', import.meta.url)), 'utf8')

  it('reads the heartbeat and hands it to the recorders and the banner', () => {
    expect(src).toContain("from '@/lib/worker-status'")
    expect(src).toMatch(/recorders\(live, worker\)/)
    expect(src).toMatch(/workerBanner\(live, worker\)/)
  })

  it('no longer keys the banner or a recorder on the configuration flag alone', () => {
    expect(src).not.toMatch(/\{live\.worker \? null : \(/)
    expect(src).not.toContain('function recorders(')
    expect(src).not.toContain('No agent worker is connected to this deployment')
  })
})
