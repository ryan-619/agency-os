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

/** The smallest environment that validates. Every case starts from this. */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  AUTH_URL: 'https://myagencyos.in',
  SMTP_HOST: 'smtp.example.com',
}

async function loadWith(vars: Record<string, string | undefined>): Promise<() => unknown> {
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
  for (const k of [...Object.keys(BASE), 'AUTH_TRUST_HOST', 'DATABASE_POOL_MAX', 'AGENT_URL']) {
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
