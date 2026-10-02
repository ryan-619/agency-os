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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
      smsInbound: false,
      cron: false,
      slack: false,
      unsubscribe: false,
    })
  })

  /**
   * DoveSoft's webhook brings texts in (0019), and nothing said about
   * `inbound` — Message-IDs, addresses, a mailbox — is true of it, so it is
   * its own fact and never makes `inbound` read 'webhook'.
   */
  it('reports SMS replies apart from the email webhook', () => {
    const d = flagsFrom({ ...BARE, DOVESOFT_WEBHOOK_SECRET: 'd'.repeat(32) })
    expect(d.smsInbound).toBe(true)
    expect(d.inbound).toBe('none')
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

  /**
   * The org is a FALLBACK: a text is matched across every org first, and
   * only a number nobody holds is filed under it. The sentence without it
   * said a STOP from such a number "can be recorded only in an org where a
   * contact holds the number" — of a number no contact holds.
   */
  it('says texts are matched across every org, and the org is where a number nobody holds is filed', () => {
    const on = dovesoftFacts({ ...base, DOVESOFT_ORG_ID: ORG }).sentences[1] ?? ''
    expect(on).toContain('in whichever org holds them')
    expect(on).toContain('Only a text from a number no contact anywhere holds')
    const off = dovesoftFacts(base).sentences[1] ?? ''
    expect(off).toContain('in whichever org holds them')
    expect(off).toContain('recorded nowhere')
    expect(off).toContain('OPT-OUT NOT RECORDED')
    expect(off).not.toContain('can be recorded only in an org where a contact holds the number')
  })

  /**
   * Review round 10, [6]: since round 9 such a STOP is answered 200 when the
   * push carried no message id — its retry could not be told from a new text
   * (`handleDoveSoftMo`) — and the sentence still said it "is answered 500",
   * which reads as "DoveSoft retries it". DEPLOYING.md's own wording.
   */
  it('says a STOP from a number nobody holds is answered 200 when the push carried no message id', () => {
    const off = dovesoftFacts(base).sentences[1] ?? ''
    expect(off).toContain(
      'it is answered 500 so DoveSoft retries — 200 when the push carried no message id, since its retry could not be ' +
        'told from a new text — and logged OPT-OUT NOT RECORDED, for a person to record by hand',
    )
    expect(off).not.toContain('it is answered 500 and logged')
  })

  /** Half of all base64 secrets carry a `+`, which a query string reads as a space. */
  it('says to generate the secret as hex, and to percent-encode any other in the URL', () => {
    const all = dovesoftFacts(base).sentences.join(' ')
    expect(all).toContain('openssl rand -hex 32')
    expect(all).toContain('percent-encoded')
    expect(all).not.toContain('base64')
  })

  it('says a GET push puts the number and the words in the request log, and to ask for POST', () => {
    const get = dovesoftFacts(base).sentences.find((x) => x.startsWith('A push by GET')) ?? ''
    expect(get).toContain('the sender’s number and the words of every text sent back')
    expect(get).toContain('request log')
    expect(get).toContain('Ask DoveSoft to push by POST')
  })

  it('renders every sentence, and repeats the encoding rule where the URLs are registered', () => {
    const page = readFileSync(fileURLToPath(new URL('../src/app/settings/deployment/page.tsx', import.meta.url)), 'utf8')
    expect(page).toContain('sms.sentences.map(')
    expect(page).toContain('percent-encoded unless it is hex (<code>openssl rand -hex 32</code>)')
  })

  /** The sending half lives on the worker; the page says so rather than guessing at it. */
  it('names the worker’s sending variables as invisible from here', () => {
    const last = dovesoftFacts(base).sentences.at(-1) ?? ''
    expect(last).toContain('DOVESOFT_API_KEY')
    expect(last).toContain('DOVESOFT_ENTITY_ID')
    expect(last).toContain('which this page cannot see')
  })
})
