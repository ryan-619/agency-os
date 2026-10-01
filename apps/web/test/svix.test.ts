/**
 * Svix signature verification — what stands between the internet and
 * `handleInboundEmail` on `/api/inbound/resend`.
 *
 * Two kinds of evidence, because a verifier tested only against signatures
 * it computed itself proves it agrees with itself. The first case is the
 * vector Svix publishes in its "verifying manually" documentation; the rest
 * compute a signature here, in the test, from a fixed secret with
 * `node:crypto`, and then disturb one thing at a time.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SVIX_TOLERANCE_SECONDS, verifySvix } from '../src/lib/svix'

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const ID = 'msg_2Lh9KRb0pSGUZfHf3m5rjdyKvab'
const BODY = JSON.stringify({ type: 'email.received', created_at: '2026-09-30T10:00:00.000Z', data: { email_id: 'a1b2c3' } })
const NOW = new Date('2026-09-30T10:00:00.000Z')
const TS = String(Math.floor(NOW.getTime() / 1000))

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

const good = (): Parameters<typeof verifySvix>[0] => ({
  secret: SECRET, id: ID, timestamp: TS, signature: sign(SECRET, ID, TS, BODY), body: BODY, now: NOW,
})

describe('verifySvix', () => {
  it('agrees with the vector Svix publishes', () => {
    // docs.svix.com, "Verifying Webhooks Manually": this secret, id,
    // timestamp and payload sign to exactly this value.
    expect(verifySvix({
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: '1614265330',
      signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      body: '{"test": 2432232314}',
      now: new Date(1614265330 * 1000),
    })).toEqual({ ok: true })
  })

  it('accepts a signature computed from the secret', () => {
    expect(verifySvix(good())).toEqual({ ok: true })
  })

  it('refuses a body with one byte changed', () => {
    const changed = BODY.replace('a1b2c3', 'a1b2c4')
    expect(changed).not.toBe(BODY)
    expect(verifySvix({ ...good(), body: changed })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('refuses the body re-serialised, because the signature is over the RAW bytes', () => {
    // What a route that parsed first and verified second would hand in.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2)
    expect(verifySvix({ ...good(), body: reserialised })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('refuses a signature from another secret', () => {
    const other = 'whsec_' + Buffer.from('a different endpoint secret!').toString('base64')
    expect(verifySvix({ ...good(), signature: sign(other, ID, TS, BODY) })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('refuses a signature moved to another message id', () => {
    expect(verifySvix({ ...good(), id: 'msg_somethingElse' })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('refuses a delivery six minutes old as stale', () => {
    const old = String(Number(TS) - 6 * 60)
    expect(verifySvix({ ...good(), timestamp: old, signature: sign(SECRET, ID, old, BODY) }))
      .toEqual({ ok: false, why: 'stale' })
  })

  it('refuses a delivery six minutes in the future as stale', () => {
    const ahead = String(Number(TS) + 6 * 60)
    expect(verifySvix({ ...good(), timestamp: ahead, signature: sign(SECRET, ID, ahead, BODY) }))
      .toEqual({ ok: false, why: 'stale' })
  })

  it('accepts one exactly at the edge of the five-minute window', () => {
    expect(SVIX_TOLERANCE_SECONDS).toBe(300)
    const edge = String(Number(TS) - 300)
    expect(verifySvix({ ...good(), timestamp: edge, signature: sign(SECRET, ID, edge, BODY) })).toEqual({ ok: true })
  })

  it('reports a stale timestamp before comparing any signature', () => {
    // A stale timestamp with a signature that would not match anyway is
    // reported as stale: the cheaper refusal, and the more useful sentence.
    const old = String(Number(TS) - 3600)
    expect(verifySvix({ ...good(), timestamp: old, signature: 'v1,AAAA' })).toEqual({ ok: false, why: 'stale' })
  })

  it('passes when the second of two signatures matches (a rotated secret)', () => {
    const rotatedOut = sign('whsec_' + Buffer.from('the secret before rotation').toString('base64'), ID, TS, BODY)
    expect(verifySvix({ ...good(), signature: `${rotatedOut} ${sign(SECRET, ID, TS, BODY)}` })).toEqual({ ok: true })
  })

  it('skips entries in another scheme rather than failing on them', () => {
    const v1 = sign(SECRET, ID, TS, BODY)
    expect(verifySvix({ ...good(), signature: `v1a,c29tZXRoaW5n ${v1}` })).toEqual({ ok: true })
    // ...but the right bytes under the wrong scheme label are not a v1 signature.
    expect(verifySvix({ ...good(), signature: v1.replace(/^v1,/, 'v2,') })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('refuses a secret without the whsec_ prefix as bad_secret', () => {
    expect(verifySvix({ ...good(), secret: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' })).toEqual({ ok: false, why: 'bad_secret' })
    expect(verifySvix({ ...good(), secret: 'whsec_' })).toEqual({ ok: false, why: 'bad_secret' })
    expect(verifySvix({ ...good(), secret: 'whsec_not base64!' })).toEqual({ ok: false, why: 'bad_secret' })
  })

  it('reports a bad secret even when the headers are missing — the deployment is what is wrong', () => {
    expect(verifySvix({ ...good(), secret: 'plain', id: null, timestamp: null, signature: null }))
      .toEqual({ ok: false, why: 'bad_secret' })
  })

  it.each([
    ['svix-id', { id: null }],
    ['svix-timestamp', { timestamp: null }],
    ['svix-signature', { signature: null }],
    ['an empty svix-signature', { signature: '' }],
    ['a timestamp that is not one', { timestamp: '2026-09-30T10:00:00Z' }],
  ])('refuses without %s as missing', (_label, patch) => {
    expect(verifySvix({ ...good(), ...patch })).toEqual({ ok: false, why: 'missing' })
  })

  it('refuses a signature list with no v1 entry at all', () => {
    expect(verifySvix({ ...good(), signature: 'nonsense' })).toEqual({ ok: false, why: 'mismatch' })
  })

  it('never puts the secret, or the signature it expected, into its answer', () => {
    const expected = sign(SECRET, ID, TS, BODY).slice(3)
    const verdicts = [
      verifySvix(good()),
      verifySvix({ ...good(), body: BODY + ' ' }),
      verifySvix({ ...good(), timestamp: '1' }),
      verifySvix({ ...good(), signature: null }),
      verifySvix({ ...good(), secret: SECRET.slice(6) }),
    ]
    for (const v of verdicts) {
      const text = JSON.stringify(v)
      expect(text).not.toContain(SECRET.slice(6))
      expect(text).not.toContain(expected)
      expect(Object.keys(v).sort()).toEqual(v.ok ? ['ok'] : ['ok', 'why'])
    }
  })
})
