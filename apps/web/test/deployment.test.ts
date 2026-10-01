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
import {
  DOVESOFT_TOKEN_PLACEHOLDER, dovesoftFacts, flagsFrom, noRepliesReadNote, nothingWillSendNote, type Deployment,
} from '../src/lib/deployment-facts'

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
      /No agent worker is connected to this deployment/,
    )
  })
})

describe('noRepliesReadNote', () => {
  it('is null with a worker, which reads the mailbox', () => {
    expect(noRepliesReadNote(facts({ worker: true }))).toBeNull()
  })

  it('is null with an inbound webhook, which a reply can arrive through', () => {
    expect(noRepliesReadNote(facts({ inbound: 'webhook' }))).toBeNull()
  })

  it('says so with neither', () => {
    expect(noRepliesReadNote(facts({}))).toBe(
      'No worker is reading a mailbox and no inbound webhook is configured on this deployment, so nothing here can learn that somebody replied. The queue is honest — it is just not being read.',
    )
  })
})

describe('dovesoftFacts', () => {
  const SECRET = 'S'.repeat(40)
  const ORG = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
  const base = { AUTH_URL: 'https://myagencyos.in', DOVESOFT_WEBHOOK_SECRET: undefined, DOVESOFT_ORG_ID: undefined }

  /**
   * The URLs a person registers with DoveSoft: built from AUTH_URL, never a
   * request's Host, and carrying the token as a placeholder — the secret is
   * a credential, and no page shows one (§2.3).
   */
  it('builds the two URLs from AUTH_URL with the token as a placeholder, never the secret', () => {
    const f = dovesoftFacts({ ...base, DOVESOFT_WEBHOOK_SECRET: SECRET })
    expect(f.urls).toEqual({
      dlr: 'https://myagencyos.in/api/inbound/dovesoft/dlr?token=<DOVESOFT_WEBHOOK_SECRET>',
      sms: 'https://myagencyos.in/api/inbound/dovesoft/sms?token=<DOVESOFT_WEBHOOK_SECRET>',
    })
    expect(DOVESOFT_TOKEN_PLACEHOLDER).toBe('<DOVESOFT_WEBHOOK_SECRET>')
    expect(JSON.stringify(f)).not.toContain(SECRET)
  })

  it('keeps a trailing slash or a path on AUTH_URL from doubling the slash', () => {
    expect(dovesoftFacts({ ...base, AUTH_URL: 'http://localhost:3000/' }).urls.sms).toBe(
      'http://localhost:3000/api/inbound/dovesoft/sms?token=<DOVESOFT_WEBHOOK_SECRET>',
    )
  })

  it('says both routes refuse everything without the secret — a STOP included', () => {
    const f = dovesoftFacts(base)
    expect(f.webhooks).toBe(false)
    expect(f.org).toBe(false)
    expect(f.sentences[0]).toContain('both DoveSoft routes answer 503')
    expect(f.sentences[0]).toContain('a STOP included')
    expect(f.sentences[1]).toContain('DOVESOFT_ORG_ID is not set')
  })

  it('flips each fact on exactly its own variable', () => {
    expect(dovesoftFacts({ ...base, DOVESOFT_WEBHOOK_SECRET: SECRET })).toMatchObject({ webhooks: true, org: false })
    expect(dovesoftFacts({ ...base, DOVESOFT_ORG_ID: ORG })).toMatchObject({ webhooks: false, org: true })
    expect(dovesoftFacts({ ...base, DOVESOFT_ORG_ID: ORG }).sentences[1]).toContain('audited in the org DOVESOFT_ORG_ID names')
  })

  /** The sending half lives on the worker; the page says so rather than guessing at it. */
  it('names the worker’s sending variables as invisible from here', () => {
    const last = dovesoftFacts(base).sentences.at(-1) ?? ''
    expect(last).toContain('DOVESOFT_API_KEY')
    expect(last).toContain('DOVESOFT_ENTITY_ID')
    expect(last).toContain('which this page cannot see')
  })
})
