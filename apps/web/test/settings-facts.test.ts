/**
 * What /settings and /settings/deployment say about the worker.
 *
 * The digest's "Worker:" line and /api/health read `heartbeatReportedStatus`,
 * which calls a row left by a worker somebody ran by hand and closed — silent,
 * over a week old, with no worker configured — RETIRED. These pages read the
 * same `HeartbeatReport` and used to switch on its `status` alone, which stays
 * `silent` for that row: "Worker silent since its last heartbeat, 9 days ago"
 * on the page beside a digest saying "retired", and "On Fly, check that the
 * machine was not scaled to zero" as the answer to "why would nothing send?"
 * on a deployment that never had a worker to scale.
 *
 * `app/settings/facts.ts` is pure (types only), so it is loaded here directly
 * and run over every status `heartbeatReport` can produce.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_RETIRED_AFTER_DAYS, heartbeatReport, heartbeatReportedStatus } from '@agency/db/queries'
import { deploymentFacts, sendingAnswer, workerLine, workerModes, type DeploymentFactInput } from '../src/app/settings/facts'
import { RETIRED_WORKER_WORDS } from '../src/lib/dashboard-view'

const NOW = new Date('2026-09-30T12:00:00Z')
const DAY = 86_400
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000)
const row = (secondsAgo: number) => ({
  lastTickAt: ago(secondsAgo), outreach: 'send-and-receive', chat: 'enabled', detail: { intervalMs: 15_000 },
})

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

describe('every status, retired included', () => {
  it('covers all five words', () => {
    const words = new Set(GRID.map(([, r, configured]) => heartbeatReportedStatus(heartbeatReport(r, configured, NOW))))
    expect([...words].sort()).toEqual(['live', 'never', 'not_configured', 'retired', 'silent'])
  })

  it.each(GRID)('%s', (_label, r, configured) => {
    const report = heartbeatReport(r, configured, NOW)
    const word = heartbeatReportedStatus(report)
    const line = workerLine(report)
    const sending = sendingAnswer(report)

    if (word === 'retired') {
      expect(line.text).toMatch(/^Worker retired — last seen 7 days ago; /)
      expect(line.text).toContain(RETIRED_WORKER_WORDS)
      expect(line.tone).toBe('plain')
      expect(line.lastSeenAt).toEqual(report.lastSeenAt)
      expect(sending.text).toContain(RETIRED_WORKER_WORDS)
      for (const said of [line.text, sending.text]) {
        expect(said).not.toMatch(/silent|scaled to zero/i)
      }
    } else {
      expect(line.text).not.toMatch(/retired/i)
      expect(sending.text).not.toMatch(/retired/i)
    }
    if (word === 'silent') {
      expect(line.text).toMatch(/^Worker silent since its last heartbeat/)
      expect(sending.text).toContain('scaled to zero')
    }
  })
})

describe('a retired worker', () => {
  const retired = heartbeatReport(row(9 * DAY), false, NOW)

  it('is the report the digest calls retired', () => {
    expect(retired.status).toBe('silent')
    expect(retired.retired).toBe(true)
    expect(heartbeatReportedStatus(retired)).toBe('retired')
  })

  it('reads as a fact, not an alarm, with the instant left for the page to render', () => {
    expect(workerLine(retired)).toEqual({
      tone: 'plain',
      text: `Worker retired — last seen 9 days ago; ${RETIRED_WORKER_WORDS}.`,
      lastSeenAt: retired.lastSeenAt,
    })
  })

  /**
   * Retired is a reading of the row, not knowledge of its history: on the
   * documented production shape (Vercel with no AGENT_URL, the worker on
   * Fly) a Fly worker dead for eight days reads the same, so the answer
   * says what to conclude if one was meant to be running.
   */
  it('answers "why would nothing send?" with the reason, what retired means, and what it means if one was meant to run', () => {
    const a = sendingAnswer(retired)
    expect(a.tone).toBe('warn')
    expect(a.text).toBe(
      `Nothing sends: ${RETIRED_WORKER_WORDS}. The last worker to report in was last seen 9 days ago; with none ` +
        'configured, a week without a heartbeat counts as retired — what a worker run by hand and then closed leaves ' +
        'behind — and nobody is alerted about it. If one is meant to be running elsewhere against this database, it ' +
        'has stopped. The CRM half works without one; sending, reply detection and chat need the worker (DEPLOYING.md).',
    )
  })

  it('still says what it reported at its last heartbeat', () => {
    expect(workerModes(retired)).toBe('At its last heartbeat it reported: sending email and reading a mailbox; chat on.')
  })
})

describe('a worker that sends SMS (0019)', () => {
  // `outreach` is the MAILBOX; `detail.sms` is DoveSoft. A worker with no
  // mailbox and DoveSoft on sends texts, and must not read as sending nothing.
  const smsRow = (outreach: string, sms: 'on' | 'off') => ({
    lastTickAt: ago(30), outreach, chat: 'enabled', detail: { intervalMs: 15_000, sms },
  })

  it('does not say "sends nothing" when only its mail is off', () => {
    const a = sendingAnswer(heartbeatReport(smsRow('disabled', 'on'), true, NOW))
    expect(a.tone).toBe('ok')
    expect(a.text).toContain('sends approved SMS through DoveSoft')
    expect(a.text).not.toContain('sends nothing')
    expect(workerModes(heartbeatReport(smsRow('disabled', 'on'), true, NOW))).toBe(
      'At its last heartbeat it reported: email outreach off; texts through DoveSoft; chat on.',
    )
  })

  it('still says "sends nothing" when mail and SMS are both off', () => {
    const a = sendingAnswer(heartbeatReport(smsRow('disabled', 'off'), true, NOW))
    expect(a.tone).toBe('warn')
    expect(a.text).toContain('sends nothing')
    expect(workerModes(heartbeatReport(smsRow('disabled', 'off'), true, NOW))).toBe(
      'At its last heartbeat it reported: email outreach off; SMS off; chat on.',
    )
  })

  it('says a receive-only worker with SMS on sends texts, not email', () => {
    const a = sendingAnswer(heartbeatReport(smsRow('receive-only', 'on'), true, NOW))
    expect(a.tone).toBe('ok')
    expect(a.text).toContain('does not send email')
  })
})

describe('the clause is the digest’s', () => {
  it('is restated in facts.ts word for word, beside the dashboard’s', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/app/settings/facts.ts', import.meta.url)), 'utf8')
    expect(src).toContain(`'${RETIRED_WORKER_WORDS}'`)
  })

  it('keeps facts.ts free of value imports, so this test can load it', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/app/settings/facts.ts', import.meta.url)), 'utf8')
    for (const line of src.split('\n').filter((l) => l.startsWith('import '))) expect(line).toMatch(/^import type /)
  })
})

/**
 * The Replies line is CONFIGURATION, like the Sending line beside it: a
 * worker on Fly reads its mailbox against this database whether or not this
 * web half holds AGENT_URL, so "Not read on this deployment: no worker reads
 * a mailbox" sat beside "Worker last seen 2 minutes ago · sending and
 * reading a mailbox". Review round 3, finding [20].
 */
describe('the Replies fact', () => {
  const input = (over: Partial<DeploymentFactInput['flags']> = {}, i: Partial<DeploymentFactInput> = {}): DeploymentFactInput => ({
    flags: { worker: false, mailIsLocalSink: false, inbound: 'none', cron: false, slack: false, unsubscribe: false, ...over },
    agent: false,
    secretsKey: 'unset',
    vercelEnv: undefined,
    inboundJson: false,
    inboundResend: false,
    rescanBatchSize: 25,
    ...i,
  })
  const replies = (i: DeploymentFactInput) => deploymentFacts(i).find((f) => f.area === 'Replies')!

  it('never states that no worker reads a mailbox', () => {
    for (const i of [input(), input({ worker: true }), input({ inbound: 'webhook' }, { inboundJson: true })]) {
      expect(replies(i).sentence).not.toMatch(/no worker reads a mailbox|the worker’s mailbox reader/)
    }
  })

  it('with nothing configured, points at the heartbeat as the Sending line does', () => {
    expect(replies(input()).sentence).toBe(
      'No inbound webhook is configured, and this deployment is not configured to reach a worker. Unless the heartbeat ' +
        'shows one reading a mailbox against this database, no reply is read.',
    )
  })

  it('names the webhooks it has, and a configured worker as configuration', () => {
    expect(replies(input({ inbound: 'webhook', worker: true }, { inboundJson: true })).sentence).toBe(
      'Accepted by the inbound webhook (/api/inbound/email). A worker is configured too; whether it reads a mailbox is the heartbeat’s question.',
    )
    expect(replies(input({ worker: true })).sentence).toBe(
      'No inbound webhook is configured. This deployment is configured to reach a worker; whether it reads a mailbox is the heartbeat’s question.',
    )
  })

  it('names the variables the line is read from, the worker’s included', () => {
    expect(replies(input()).vars).toEqual(['AGENT_URL', 'AGENT_INTERNAL_TOKEN', 'INBOUND_WEBHOOK_SECRET', 'RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY'])
  })
})
