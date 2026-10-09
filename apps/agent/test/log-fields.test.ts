/**
 * What a worker's warning says about a fault (2026-10-09): its class, a code
 * where it carries one, a hint where the code says the network or the
 * database went away — and never the message.
 */
import { describe, expect, it } from 'vitest'
import { DATABASE_GONE_HINT, NETWORK_HINT, faultFields } from '../src/log-fields.js'

const withCode = (code: unknown, message = 'connect ETIMEDOUT 203.0.113.9:5432 password=hunter2') =>
  Object.assign(new Error(message), { code })

describe('faultFields', () => {
  it('names the class, and nothing else, for an error with no code', () => {
    expect(faultFields(new TypeError('cannot read x of undefined'))).toEqual({ error: 'TypeError' })
    expect(faultFields('a string thrown')).toEqual({ error: 'UnknownError' })
    expect(faultFields(undefined)).toEqual({ error: 'UnknownError' })
  })

  it('says the network went away when the code says so, and keeps the message out', () => {
    for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'EADDRNOTAVAIL', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEOUT']) {
      const fields = faultFields(withCode(code))
      expect(fields).toEqual({ error: 'Error', code, hint: NETWORK_HINT })
      expect(JSON.stringify(fields)).not.toMatch(/203\.0\.113|hunter2|5432/)
    }
  })

  it('reads the code of the error a query builder wraps', () => {
    const wrapped = Object.assign(new Error('Failed query: select … params: secret'), {
      name: 'DrizzleQueryError',
      cause: withCode('57P01'),
    })
    expect(faultFields(wrapped)).toEqual({ error: 'DrizzleQueryError', code: '57P01', hint: DATABASE_GONE_HINT })
    expect(faultFields(Object.assign(new Error('x'), { cause: Object.assign(new Error('y'), { code: '08006' }) }))).toMatchObject({
      code: '08006',
      hint: DATABASE_GONE_HINT,
    })
  })

  it('keeps any other code bare, and drops one that is not a code', () => {
    expect(faultFields(withCode('23505'))).toEqual({ error: 'Error', code: '23505' })
    expect(faultFields(withCode('ERR_INVALID_URL'))).toEqual({ error: 'Error', code: 'ERR_INVALID_URL' })
    for (const code of [42, 'two words', 'a'.repeat(41), 'user@example.com', '']) {
      expect(faultFields(withCode(code))).toEqual({ error: 'Error' })
    }
  })

  it('looks only a few causes deep, so a loop of causes ends', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(faultFields(a)).toEqual({ error: 'Error' })
  })
})
