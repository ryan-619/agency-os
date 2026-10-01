/**
 * The environment boundary (§10: a boundary is validated, like every other).
 *
 * Written the day a real domain was attached, because that is the day AUTH_URL
 * changes — typed by hand into a dashboard, by somebody following a runbook
 * rather than reading `lib/env.ts`. It had been validated as "not empty",
 * which accepts a bare hostname: the deployment starts up green and then
 * throws on every single sign-in, because Auth.js builds the magic-link URL
 * with `new URL()`.
 *
 * `env()` memoises, so each case imports the module fresh with `resetModules`
 * rather than trying to un-cache it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/lib/env.js'

/** The smallest environment that validates. Every case starts from this. */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  AUTH_URL: 'https://myagencyos.in',
  SMTP_HOST: 'smtp.example.com',
}

async function loadWith(vars: Record<string, string | undefined>): Promise<() => Env> {
  vi.resetModules()
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await import('../src/lib/env.js')
  return mod.env
}

let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
  // Start from a known-empty slate for the variables under test, so a value in
  // the developer's own shell cannot make a case pass or fail.
  for (const k of [
    ...Object.keys(BASE), 'AUTH_TRUST_HOST', 'DATABASE_POOL_MAX', 'AGENT_URL',
    'CRON_SECRET', 'RESCAN_BATCH_SIZE', 'SLACK_WEBHOOK_URL', 'UNSUBSCRIBE_SECRET',
    'RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY', 'SECRETS_KEY', 'VERCEL_ENV',
    'INBOUND_WEBHOOK_SECRET', 'DOVESOFT_WEBHOOK_SECRET', 'DOVESOFT_ORG_ID',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  process.env = saved
})

describe('AUTH_URL', () => {
  it('accepts an absolute https origin', async () => {
    const env = await loadWith(BASE)
    expect(() => env()).not.toThrow()
  })

  it('accepts http, for a local or in-cluster deployment', async () => {
    const env = await loadWith({ ...BASE, AUTH_URL: 'http://localhost:3000' })
    expect(() => env()).not.toThrow()
  })

  it.each([
    ['a bare hostname', 'myagencyos.in'],
    ['a hostname with a path', 'myagencyos.in/signin'],
    ['a protocol-relative URL', '//myagencyos.in'],
    ['a scheme that is not http', 'ftp://myagencyos.in'],
    ['whitespace', '   '],
  ])('rejects %s', async (_name, value) => {
    const env = await loadWith({ ...BASE, AUTH_URL: value })
    expect(() => env()).toThrow(/AUTH_URL/)
  })

  it('still rejects an absent AUTH_URL, and names it', async () => {
    const env = await loadWith({ ...BASE, AUTH_URL: undefined })
    expect(() => env()).toThrow(/AUTH_URL/)
  })
})

describe('what the error message may contain', () => {
  it('names the variables that failed and never their values (§2.3)', async () => {
    const secret = 'super-secret-password-nobody-should-see'
    const env = await loadWith({
      ...BASE,
      AUTH_URL: 'not-a-url',
      DATABASE_URL: `postgres://user:${secret}@db.example.com:5432/db`,
    })
    try {
      env()
      expect.unreachable('expected the environment to be rejected')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).toContain('AUTH_URL')
      // The DSN is a credential. A validation error that prints it puts it in
      // every log that catches the startup failure.
      expect(message).not.toContain(secret)
      expect(message).not.toContain('not-a-url')
    }
  })
})

describe('DATABASE_URL and TLS', () => {
  it('accepts a loopback host with no sslmode, because there is no wire to protect', async () => {
    const env = await loadWith({ ...BASE, DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' })
    expect(() => env()).not.toThrow()
  })

  it('rejects a remote host with no sslmode', async () => {
    const env = await loadWith({
      ...BASE,
      DATABASE_URL: 'postgres://u:p@ep-xyz.aws.neon.tech/neondb',
    })
    expect(() => env()).toThrow(/DATABASE_URL/)
  })

  it('rejects sslmode=disable, which is present and means the opposite', async () => {
    const env = await loadWith({
      ...BASE,
      DATABASE_URL: 'postgres://u:p@ep-xyz.aws.neon.tech/neondb?sslmode=disable',
    })
    expect(() => env()).toThrow(/DATABASE_URL/)
  })

  it('accepts sslmode=require on a remote host', async () => {
    const env = await loadWith({
      ...BASE,
      DATABASE_URL: 'postgres://u:p@ep-xyz.aws.neon.tech/neondb?sslmode=require',
    })
    expect(() => env()).not.toThrow()
  })
})

/**
 * The optional variables behind the scheduled jobs, notifications, one-click
 * unsubscribe and the Resend inbound path. Each is absent by default and the
 * feature behind it fails closed; what these pin is that a PRESENT value is
 * held to its shape, that the shape names the variable and never the value,
 * and that a blank line — which is how `.env.example` documents every one of
 * them — is unset rather than a startup failure.
 */
describe('SLACK_WEBHOOK_URL', () => {
  it('is optional', async () => {
    const env = await loadWith(BASE)
    expect(env().SLACK_WEBHOOK_URL).toBeUndefined()
  })

  it('accepts an https hooks.slack.com URL', async () => {
    const env = await loadWith({ ...BASE, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' })
    expect(env().SLACK_WEBHOOK_URL).toBe('https://hooks.slack.com/services/T/B/x')
  })

  it('treats a blank value as unset, because that is how .env.example documents it', async () => {
    const env = await loadWith({ ...BASE, SLACK_WEBHOOK_URL: '' })
    expect(env().SLACK_WEBHOOK_URL).toBeUndefined()
  })

  /**
   * The variable makes a web function POST to whatever it names. Pinning the
   * host is what stops a mistyped value carrying every notification to a
   * stranger — or to the cloud metadata endpoint.
   */
  it.each([
    ['plain http', 'http://hooks.slack.com/services/T/B/x'],
    ['another host', 'https://evil.example/services/T/B/x'],
    ['the metadata endpoint', 'https://169.254.169.254/services/T/B/x'],
    ['not a URL', 'hooks.slack.com/services/T/B/x'],
  ])('refuses %s', async (_name, value) => {
    const env = await loadWith({ ...BASE, SLACK_WEBHOOK_URL: value })
    expect(() => env()).toThrow(/SLACK_WEBHOOK_URL/)
  })

  it('names the variable and never the value when it refuses (§2.3)', async () => {
    const value = 'https://evil.example/services/T0SECRET/B0SECRET/xxxSECRETxxx'
    const env = await loadWith({ ...BASE, SLACK_WEBHOOK_URL: value })
    try {
      env()
      expect.unreachable('expected the environment to be rejected')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).toContain('SLACK_WEBHOOK_URL')
      // The URL IS the credential. A validation error that prints it puts it
      // in every log that catches the startup failure.
      expect(message).not.toContain('SECRET')
      expect(message).not.toContain('evil.example')
    }
  })
})

describe.each([
  ['CRON_SECRET', 32],
  ['UNSUBSCRIBE_SECRET', 32],
  ['RESEND_WEBHOOK_SECRET', 16],
  ['DOVESOFT_WEBHOOK_SECRET', 32],
] as const)('%s', (name, min) => {
  it('is optional', async () => {
    const env = await loadWith(BASE)
    expect(env()[name]).toBeUndefined()
  })

  it(`accepts ${min} characters`, async () => {
    const env = await loadWith({ ...BASE, [name]: 'k'.repeat(min) })
    expect(env()[name]).toBe('k'.repeat(min))
  })

  it(`refuses ${min - 1} characters, and names the variable`, async () => {
    const env = await loadWith({ ...BASE, [name]: 'k'.repeat(min - 1) })
    expect(() => env()).toThrow(new RegExp(name))
  })

  it('treats a blank value as unset rather than as a too-short secret', async () => {
    const env = await loadWith({ ...BASE, [name]: '   ' })
    expect(env()[name]).toBeUndefined()
  })
})

describe('RESEND_API_KEY', () => {
  it('is optional, and a blank line is unset', async () => {
    expect((await loadWith(BASE))().RESEND_API_KEY).toBeUndefined()
    expect((await loadWith({ ...BASE, RESEND_API_KEY: '' }))().RESEND_API_KEY).toBeUndefined()
  })

  it('accepts a value', async () => {
    const env = await loadWith({ ...BASE, RESEND_API_KEY: 're_123' })
    expect(env().RESEND_API_KEY).toBe('re_123')
  })
})

describe('RESCAN_BATCH_SIZE', () => {
  it('defaults to 6', async () => {
    const env = await loadWith(BASE)
    expect(env().RESCAN_BATCH_SIZE).toBe(6)
  })

  it('reads a number', async () => {
    const env = await loadWith({ ...BASE, RESCAN_BATCH_SIZE: '12' })
    expect(env().RESCAN_BATCH_SIZE).toBe(12)
  })

  /**
   * The ceiling is the function's: on Vercel the scans run one after another
   * inside one invocation, and twenty is already past what a 300-second
   * function can be trusted to finish.
   */
  it.each(['0', '21', '-1', '2.5'])('refuses %s', async (value) => {
    const env = await loadWith({ ...BASE, RESCAN_BATCH_SIZE: value })
    expect(() => env()).toThrow(/RESCAN_BATCH_SIZE/)
  })
})

describe('VERCEL_ENV', () => {
  it('is optional — unset everywhere but Vercel', async () => {
    const env = await loadWith(BASE)
    expect(env().VERCEL_ENV).toBeUndefined()
  })

  it.each(['production', 'preview', 'development'])('accepts %s', async (value) => {
    const env = await loadWith({ ...BASE, VERCEL_ENV: value })
    expect(env().VERCEL_ENV).toBe(value)
  })

  it('refuses a value the platform never sends, without echoing it', async () => {
    const env = await loadWith({ ...BASE, VERCEL_ENV: 'staging' })
    expect(() => env()).toThrow(/VERCEL_ENV/)
    expect(() => env()).not.toThrow(/staging/)
  })
})

describe('SECRETS_KEY', () => {
  /**
   * Declared so the schema and `.env.example` agree on the name; the value is
   * read and validated by `secretsKeyFromEnv()` in packages/db, which is why
   * nothing here refuses a malformed one.
   */
  it('is optional and passed through', async () => {
    expect((await loadWith(BASE))().SECRETS_KEY).toBeUndefined()
    expect((await loadWith({ ...BASE, SECRETS_KEY: 'not-validated-here' }))().SECRETS_KEY).toBe('not-validated-here')
  })
})

describe('INBOUND_WEBHOOK_SECRET', () => {
  /**
   * It was the one optional secret with no line in `.env.example`, and the
   * reason was the shape: a blank value failed `min(32)`, so documenting it
   * the way every other variable is documented would have stopped a copied
   * file from booting. Now a blank is unset, like the others, and the route
   * keeps refusing everything until a real value is set.
   */
  it('treats a blank value as unset', async () => {
    const env = await loadWith({ ...BASE, INBOUND_WEBHOOK_SECRET: '' })
    expect(env().INBOUND_WEBHOOK_SECRET).toBeUndefined()
  })

  it('still refuses a short one', async () => {
    const env = await loadWith({ ...BASE, INBOUND_WEBHOOK_SECRET: 'short' })
    expect(() => env()).toThrow(/INBOUND_WEBHOOK_SECRET/)
  })
})

describe('DOVESOFT_ORG_ID', () => {
  /**
   * The org a DoveSoft text from an unknown number is filed under, and where
   * its opt-out is suppressed. A value that is not an org id would make every
   * such write fail, so it is refused at startup rather than at the first STOP.
   */
  it('is optional, and a blank line is unset', async () => {
    expect((await loadWith(BASE))().DOVESOFT_ORG_ID).toBeUndefined()
    expect((await loadWith({ ...BASE, DOVESOFT_ORG_ID: ' ' }))().DOVESOFT_ORG_ID).toBeUndefined()
  })

  it('accepts an org id', async () => {
    const id = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'
    expect((await loadWith({ ...BASE, DOVESOFT_ORG_ID: id }))().DOVESOFT_ORG_ID).toBe(id)
  })

  it('refuses something that is not one, and names the variable', async () => {
    const env = await loadWith({ ...BASE, DOVESOFT_ORG_ID: 'agency' })
    expect(() => env()).toThrow(/DOVESOFT_ORG_ID/)
  })
})
