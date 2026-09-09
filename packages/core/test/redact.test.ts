import { describe, it, expect } from 'vitest'
import { redact, REDACTED } from '../src/index.js'

/**
 * §2.3: no credential is ever written to a log line. These tests pin the
 * backstop's behaviour — including, explicitly, what it does NOT catch, so
 * nobody reads the passing suite as permission to log arbitrary objects.
 */
describe('redact()', () => {
  it('redacts a top-level secret by key name', () => {
    expect(redact({ password: 'hunter2', ok: 1 })).toEqual({ password: REDACTED, ok: 1 })
  })

  // The realistic accident: logging a whole connector row in Phase 3.
  it('redacts a credential nested several levels deep', () => {
    const row = {
      id: 'c1',
      name: 'apollo',
      config: { url: 'https://mcp.apollo.io', headers: { authorization: 'Bearer sk-live-REAL' } },
      secret_ref: 'kms://abc',
    }
    const out = redact({ connector: row }) as Record<string, Record<string, unknown>>
    const config = out.connector.config as Record<string, unknown>
    const headers = config.headers as Record<string, unknown>

    expect(headers.authorization).toBe(REDACTED)
    expect(out.connector.secret_ref).toBe(REDACTED)
    // Non-sensitive fields survive, or the log would be useless — including
    // the connector's own URL, which is an endpoint, not a credential. A
    // connection string in that position WOULD be caught, by value shape.
    expect(config.url).toBe('https://mcp.apollo.io')
    expect(out.connector.id).toBe('c1')
    expect(out.connector.name).toBe('apollo')
  })

  it('redacts a matching key whatever the value type', () => {
    expect(redact({ token: { value: 'x' } })).toEqual({ token: REDACTED })
    expect(redact({ apiKey: ['a', 'b'] })).toEqual({ apiKey: REDACTED })
    expect(redact({ secret: 12345 })).toEqual({ secret: REDACTED })
  })

  it('covers the key names that actually appear in this codebase', () => {
    const fields = {
      DATABASE_URL: 'postgres://u:p@h/db',
      dsn: 'postgres://u:p@h/db',
      connectionString: 'postgres://u:p@h/db',
      AUTH_SECRET: 's',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      SMTP_PASSWORD: 'p',
      sessionToken: 't',
      cookie: 'c',
      credential: 'c',
      bearer: 'b',
    }
    for (const [k, v] of Object.entries(redact(fields))) {
      expect(v, `${k} should have been redacted`).toBe(REDACTED)
    }
  })

  it('walks arrays of objects', () => {
    const out = redact({ rows: [{ password: 'a' }, { safe: 'b' }] }) as { rows: unknown[] }
    expect(out.rows[0]).toEqual({ password: REDACTED })
    expect(out.rows[1]).toEqual({ safe: 'b' })
  })

  it('reduces an Error to name and message, dropping the stack', () => {
    const err = new Error('connect ECONNREFUSED postgres://user:pw@host')
    const out = redact({ error: err }) as Record<string, unknown>
    // `error` does not match the key pattern, so the value is walked, not replaced.
    expect(out.error).toEqual({ name: 'Error', message: err.message })
    expect(JSON.stringify(out)).not.toContain('at ')
  })

  // `seen` used to be every object visited anywhere, which flagged an ordinary
  // DAG as a cycle and dropped its contents from the log line.
  it('keeps both branches when the same object appears twice', () => {
    const shared = { name: 'shared', detail: 'kept' }
    const out = redact({ a: shared, b: shared }) as Record<string, unknown>
    expect(out.a).toEqual({ name: 'shared', detail: 'kept' })
    expect(out.b).toEqual({ name: 'shared', detail: 'kept' })
    expect(JSON.stringify(out)).not.toContain('[circular]')
  })

  it('keeps repeated siblings in an array', () => {
    const shared = { id: 1 }
    const out = redact({ rows: [shared, shared, shared] }) as { rows: unknown[] }
    expect(out.rows).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }])
  })

  it('survives a circular object instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = redact({ a }) as Record<string, Record<string, unknown>>
    expect(out.a.self).toBe('[circular]')
  })

  it('truncates beyond the depth cap', () => {
    let deep: Record<string, unknown> = { bottom: true }
    for (let i = 0; i < 12; i++) deep = { next: deep }
    expect(JSON.stringify(redact(deep))).toContain('[truncated]')
  })

  it('leaves primitives and empty input alone', () => {
    expect(redact({})).toEqual({})
    expect(redact({ n: 1, s: 'x', b: true, nul: null })).toEqual({ n: 1, s: 'x', b: true, nul: null })
  })

  // A broad key regex blanked ordinary columns and made log lines useless
  // without protecting anything. These are all real column names in the schema.
  it('leaves ordinary domain fields alone', () => {
    const fields = {
      signal_key: 'csp',
      linkedin_url: 'https://linkedin.com/in/someone',
      recording_url: 'https://recordings.example/1.mp3',
      provider_id: 'msg-1',
      session_id: 'abc',
      sdk_session_id: 's-1',
      domain: 'acme.com',
      tool_name: 'scan_company',
      AUTH_URL: 'http://localhost:3000',
      identifier: 'someone@example.com',
    }
    expect(redact(fields)).toEqual(fields)
  })

  // Caught by value shape, not key name, so an innocuously-named field holding
  // a connection string is still covered.
  it('redacts any value carrying embedded credentials, whatever the key', () => {
    expect(redact({ target: 'postgres://user:hunter2@host:5432/db' })).toEqual({ target: REDACTED })
    expect(redact({ note: 'smtp://u:p@mail.example:587' })).toEqual({ note: REDACTED })
    // ...but a URL with no credentials in it is left readable.
    expect(redact({ target: 'https://acme.com/pricing' })).toEqual({ target: 'https://acme.com/pricing' })
  })

  // Stated as a test so the limitation is visible, not discovered later.
  it('does NOT catch a bare secret stored under an innocuous key — by design', () => {
    expect(redact({ value: 'sk-live-REAL' })).toEqual({ value: 'sk-live-REAL' })
  })
})
