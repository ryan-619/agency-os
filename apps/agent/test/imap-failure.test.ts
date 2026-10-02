import { describe, expect, it } from 'vitest'
import { imapFailure } from '../src/outreach/inbox.js'

/**
 * The reconnect line's `reason` and `hint`: what a person reads to learn that
 * the host or the password is wrong — and nothing the error's message quotes.
 */
describe('imapFailure', () => {
  it('names a refused sign-in, with the fix', () => {
    const err = Object.assign(new Error('Invalid credentials (Failure) for ryan@example.com'), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      responseText: 'Invalid credentials (Failure)',
    })
    const out = imapFailure(err)
    expect(out.reason).toBe('authentication_failed')
    expect(out.hint).toContain('app password')
    expect(JSON.stringify(out)).not.toContain('ryan@example.com')
  })

  it('names a host that does not resolve, with the fix', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND ryan@myagencyos.in'), { code: 'ENOTFOUND' })
    const out = imapFailure(err)
    expect(out).toEqual({ reason: 'ENOTFOUND', hint: expect.stringContaining('IMAP_HOST') })
    expect(JSON.stringify(out)).not.toContain('myagencyos')
  })

  it("passes imapflow's own codes, and the server's bracketed code, through bare", () => {
    expect(imapFailure(Object.assign(new Error('x'), { code: 'NoConnection' }))).toEqual({ reason: 'NoConnection' })
    expect(imapFailure(Object.assign(new Error('x'), { serverResponseCode: 'UNAVAILABLE' }))).toEqual({ reason: 'UNAVAILABLE' })
  })

  it('says nothing for a code that is not a bare token, or no error at all', () => {
    expect(imapFailure(Object.assign(new Error('x'), { code: 'user ryan@example.com refused' }))).toEqual({})
    expect(imapFailure(Object.assign(new Error('x'), { code: 42 }))).toEqual({})
    expect(imapFailure(new Error('plain'))).toEqual({})
    expect(imapFailure('a string')).toEqual({})
    expect(imapFailure(null)).toEqual({})
  })
})
