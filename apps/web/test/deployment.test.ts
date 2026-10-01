/**
 * The deployment facts, stated from configuration and nothing else.
 *
 * `flagsFrom` is pure over an object so each flag can be shown to flip on
 * exactly its variable — `process.env` is never read here, and `deployment()`
 * (which reads it) is one line that is not worth a database. The sentences
 * are pinned because they are what a page shows in place of a promise the
 * deployment cannot keep.
 *
 * `lib/deployment.ts` carries `server-only` and reads `env()`, neither of
 * which vitest can resolve, so the facts are tested where they live:
 * `lib/deployment-facts.ts`, which imports nothing but a type.
 */
import { describe, expect, it } from 'vitest'
import { flagsFrom, noRepliesReadNote, nothingWillSendNote, type Deployment } from '../src/lib/deployment-facts'

/** Nothing configured but the mailbox every deployment has. */
const BARE = {
  AGENT_URL: undefined,
  AGENT_INTERNAL_TOKEN: undefined,
  SMTP_HOST: 'smtp.example.com',
  INBOUND_WEBHOOK_SECRET: undefined,
  RESEND_WEBHOOK_SECRET: undefined,
  RESEND_API_KEY: undefined,
  CRON_SECRET: undefined,
  SLACK_WEBHOOK_URL: undefined,
  UNSUBSCRIBE_SECRET: undefined,
} as const

describe('flagsFrom', () => {
  it('reports nothing when nothing is configured', () => {
    expect(flagsFrom(BARE)).toEqual<Deployment>({
      worker: false,
      mailIsLocalSink: false,
      inbound: 'none',
      cron: false,
      slack: false,
      unsubscribe: false,
    })
  })

  it('needs BOTH the worker address and the token before it claims a worker', () => {
    expect(flagsFrom({ ...BARE, AGENT_URL: 'http://127.0.0.1:3002' }).worker).toBe(false)
    expect(flagsFrom({ ...BARE, AGENT_INTERNAL_TOKEN: 't'.repeat(32) }).worker).toBe(false)
    expect(flagsFrom({ ...BARE, AGENT_URL: 'http://127.0.0.1:3002', AGENT_INTERNAL_TOKEN: 't'.repeat(32) }).worker).toBe(true)
  })

  it.each(['mailpit', 'localhost', '127.0.0.1', 'host.docker.internal', ' MAILPIT '])(
    'knows %s is a local sink',
    (host) => {
      expect(flagsFrom({ ...BARE, SMTP_HOST: host }).mailIsLocalSink).toBe(true)
    },
  )

  it('knows a real relay is not a sink', () => {
    expect(flagsFrom({ ...BARE, SMTP_HOST: 'smtp.eu.mailgun.org' }).mailIsLocalSink).toBe(false)
  })

  it('reports an inbound webhook when the plain JSON route has its secret', () => {
    expect(flagsFrom({ ...BARE, INBOUND_WEBHOOK_SECRET: 's'.repeat(32) }).inbound).toBe('webhook')
  })

  /**
   * The Resend route needs the signing secret to trust a delivery AND the
   * API key to fetch what was delivered; without either it answers 503.
   * Saying "webhook" about a route that refuses everything is the kind of
   * claim this module exists to stop.
   */
  it('reports the Resend webhook only when both its secret and its API key are set', () => {
    expect(flagsFrom({ ...BARE, RESEND_WEBHOOK_SECRET: 'whsec_' + 'x'.repeat(16) }).inbound).toBe('none')
    expect(flagsFrom({ ...BARE, RESEND_API_KEY: 're_123' }).inbound).toBe('none')
    expect(
      flagsFrom({ ...BARE, RESEND_WEBHOOK_SECRET: 'whsec_' + 'x'.repeat(16), RESEND_API_KEY: 're_123' }).inbound,
    ).toBe('webhook')
  })

  it('flips cron on CRON_SECRET', () => {
    expect(flagsFrom({ ...BARE, CRON_SECRET: 'c'.repeat(32) }).cron).toBe(true)
    expect(flagsFrom({ ...BARE, CRON_SECRET: 'c'.repeat(32) })).toMatchObject({ slack: false, unsubscribe: false })
  })

  it('flips slack on SLACK_WEBHOOK_URL', () => {
    expect(flagsFrom({ ...BARE, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }).slack).toBe(true)
    expect(flagsFrom({ ...BARE, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' })).toMatchObject({ cron: false, unsubscribe: false })
  })

  it('flips unsubscribe on UNSUBSCRIBE_SECRET', () => {
    expect(flagsFrom({ ...BARE, UNSUBSCRIBE_SECRET: 'u'.repeat(32) }).unsubscribe).toBe(true)
    expect(flagsFrom({ ...BARE, UNSUBSCRIBE_SECRET: 'u'.repeat(32) })).toMatchObject({ cron: false, slack: false })
  })
})

const facts = (over: Partial<Deployment>): Deployment => ({
  worker: false,
  mailIsLocalSink: false,
  inbound: 'none',
  cron: false,
  slack: false,
  unsubscribe: false,
  ...over,
})

describe('nothingWillSendNote', () => {
  it('is null with a worker', () => {
    expect(nothingWillSendNote(facts({ worker: true }))).toBeNull()
  })

  it('says so without one, whatever else is configured', () => {
    expect(nothingWillSendNote(facts({ inbound: 'webhook', cron: true, slack: true, unsubscribe: true }))).toMatch(
      /No agent worker is configured on this deployment/,
    )
  })

  /**
   * `worker` is CONFIGURATION: a worker on Fly sends against this database
   * whether or not this web half holds AGENT_URL — the documented production
   * shape. So the sentence says what is not configured here and where the
   * observation is, never that nothing will be sent. Round 3, finding [20].
   */
  it('says what is configured, never that nothing will be sent or no reply read', () => {
    const note = nothingWillSendNote(facts({}))!
    expect(note).not.toMatch(/No agent worker is connected|nothing queued here will be sent|no replies are being read/)
    expect(note).toContain('unless one runs against this database elsewhere')
    expect(note).toContain('/settings/deployment')
  })
})

describe('noRepliesReadNote', () => {
  it('is null with a worker, which reads the mailbox', () => {
    expect(noRepliesReadNote(facts({ worker: true }))).toBeNull()
  })

  it('is null with an inbound webhook, which a reply can arrive through', () => {
    expect(noRepliesReadNote(facts({ inbound: 'webhook' }))).toBeNull()
  })

  it('says so with neither — as configuration, pointing at the observation', () => {
    expect(noRepliesReadNote(facts({}))).toBe(
      'No worker is configured on this deployment and no inbound webhook is set up, so nothing here reads replies. ' +
        'Only a worker running against this database elsewhere could — /settings/deployment shows whether one is.',
    )
  })

  it('no longer states as fact that no worker reads a mailbox (round 3, finding [20])', () => {
    expect(noRepliesReadNote(facts({}))).not.toMatch(/No worker is reading a mailbox|nothing here can learn/)
  })
})
