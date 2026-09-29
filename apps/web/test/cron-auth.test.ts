/**
 * The contract every cron route checks first. Four outcomes, in the order
 * the route must produce them — a secret that is unset is a 503 before any
 * header is looked at, a wrong bearer is a 401 before the platform is asked
 * where it is, and a preview deployment holding the right secret is still
 * refused.
 */
import { describe, expect, it } from 'vitest'
import { cronRequest } from '../src/lib/cron-auth'

const SECRET = 'c'.repeat(32)

describe('cronRequest', () => {
  it('answers 503 when no secret is configured, before reading any header', () => {
    expect(cronRequest({ authorization: `Bearer ${SECRET}`, secret: undefined, vercelEnv: 'production' })).toEqual({
      ok: false,
      status: 503,
      error: 'not_configured',
    })
  })

  it('answers 401 on a wrong bearer', () => {
    expect(cronRequest({ authorization: 'Bearer ' + 'x'.repeat(32), secret: SECRET, vercelEnv: 'production' })).toEqual({
      ok: false,
      status: 401,
      error: 'unauthorized',
    })
  })

  it('answers 401 on no header at all', () => {
    expect(cronRequest({ authorization: null, secret: SECRET, vercelEnv: 'production' })).toMatchObject({ ok: false, status: 401 })
  })

  it('answers 401 on the secret sent under another scheme', () => {
    expect(cronRequest({ authorization: `Basic ${SECRET}`, secret: SECRET, vercelEnv: 'production' })).toMatchObject({ ok: false, status: 401 })
  })

  /**
   * A preview deployment inherits the production environment and answers
   * the same URL. A rescan or a digest run from there is a job nobody
   * scheduled, so the right secret is not enough.
   */
  it.each(['preview', 'development'])('answers 403 not_production with the right bearer on %s', (vercelEnv) => {
    expect(cronRequest({ authorization: `Bearer ${SECRET}`, secret: SECRET, vercelEnv })).toEqual({
      ok: false,
      status: 403,
      error: 'not_production',
    })
  })

  it('checks the bearer before the environment, so a preview never learns which it failed', () => {
    expect(cronRequest({ authorization: 'Bearer nope', secret: SECRET, vercelEnv: 'preview' })).toMatchObject({ status: 401 })
  })

  it('is ok with the right bearer in production', () => {
    expect(cronRequest({ authorization: `Bearer ${SECRET}`, secret: SECRET, vercelEnv: 'production' })).toEqual({ ok: true })
  })

  it('is ok with the right bearer where no platform says where it is', () => {
    expect(cronRequest({ authorization: `Bearer ${SECRET}`, secret: SECRET, vercelEnv: undefined })).toEqual({ ok: true })
  })

  it('reads the scheme without regard to case', () => {
    expect(cronRequest({ authorization: `bearer ${SECRET}`, secret: SECRET, vercelEnv: 'production' })).toEqual({ ok: true })
  })
})
