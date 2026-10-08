/**
 * Whether the worker's mailboxes accept its logins, said before a message
 * depends on it (`src/outreach/mail-login.ts`).
 *
 * On 2026-10-08 an app password was typed at the SMTP username prompt and
 * nothing said so until a send would have failed. These pin what the boot
 * check reports for each answer a server can give, and that what it logs is
 * a reason and a hint — never the error's message, which can quote a
 * username typed where a password belonged.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../src/logger.js'
import {
  checkSmtpLogin, imapLoginFrom, smtpFailure, watchSmtpLogin, type MailLogin,
} from '../src/outreach/mail-login.js'

function captureLog(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...fields })
  }
  return { log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines }
}

/** What nodemailer throws when the server answers 535 to AUTH. */
const refused = (): Error =>
  Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted. user qwer tyui opas dfgh'), {
    code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN',
  })

describe('smtpFailure', () => {
  it('reads a refused login as refused, with the fix for Google', () => {
    const f = smtpFailure(refused(), 'smtp.gmail.com')
    expect(f).toMatchObject({ state: 'refused', reason: 'EAUTH 535' })
    expect(f.hint).toMatch(/whole address/)
    expect(f.hint).toMatch(/--gmail/)
  })

  it('names Resend’s username for a Resend login', () => {
    expect(smtpFailure(refused(), 'smtp.resend.com').hint).toMatch(/username is `resend`/)
  })

  it('reads a 534 or a bare EAUTH as refused too', () => {
    expect(smtpFailure(Object.assign(new Error('x'), { responseCode: 534 }), 'mail.example.com').state).toBe('refused')
    expect(smtpFailure(Object.assign(new Error('x'), { code: 'EAUTH' }), 'mail.example.com').state).toBe('refused')
  })

  it('reads anything else as unreachable, without blaming the settings for a machine offline', () => {
    for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND']) {
      const f = smtpFailure(Object.assign(new Error('x'), { code }), 'smtp.gmail.com')
      expect(f.state, code).toBe('unreachable')
      expect(f.reason).toBe(code)
      expect(f.hint).toMatch(/tried again/)
    }
    expect(smtpFailure('not even an error', 'smtp.gmail.com')).toMatchObject({ state: 'unreachable', reason: 'UNKNOWN' })
  })

  it('takes only a token-shaped code, never free text', () => {
    expect(smtpFailure(Object.assign(new Error('x'), { code: 'user@example.com said no' }), 'h').reason).toBe('UNKNOWN')
  })
})

describe('checkSmtpLogin', () => {
  it('answers ok when the login works, and says so once', async () => {
    const { log, lines } = captureLog()
    expect(await checkSmtpLogin({ verify: async () => {} }, { host: 'smtp.gmail.com', log })).toBe('ok')
    expect(lines).toEqual([{ level: 'info', msg: 'smtp login: ok', host: 'smtp.gmail.com' }])
  })

  it('answers refused, loudly, with a reason and a hint and never the server’s words', async () => {
    const { log, lines } = captureLog()
    const state = await checkSmtpLogin({ verify: async () => { throw refused() } }, { host: 'smtp.gmail.com', log })
    expect(state).toBe('refused')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', reason: 'EAUTH 535' })
    expect(String(lines[0]!.msg)).toMatch(/^SMTP LOGIN REFUSED/)
    expect(JSON.stringify(lines)).not.toMatch(/qwer|Username and Password|535-5/)
  })

  it('answers unreachable when the server never answers, within its timeout', async () => {
    const { log, lines } = captureLog()
    const state = await checkSmtpLogin({ verify: () => new Promise(() => {}) }, { host: 'smtp.gmail.com', log, timeoutMs: 20 })
    expect(state).toBe('unreachable')
    expect(lines[0]).toMatchObject({ level: 'warn', reason: 'TIMEOUT' })
  })

  it('answers unchecked for a transport that cannot verify', async () => {
    const { log, lines } = captureLog()
    expect(await checkSmtpLogin({}, { host: 'h', log })).toBe('unchecked')
    expect(lines).toEqual([])
  })
})

describe('watchSmtpLogin', () => {
  it('tries again until the login works, then stops trying', async () => {
    const { log } = captureLog()
    const answers = [refused(), Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), null]
    const verify = vi.fn(async () => {
      const next = answers.shift()
      if (next) throw next
    })
    const states: MailLogin[] = []
    const stop = watchSmtpLogin({ verify }, { host: 'smtp.gmail.com', log, recheckMs: 5, onState: (s) => states.push(s) })
    await vi.waitFor(() => expect(states).toEqual(['refused', 'unreachable', 'ok']))
    await new Promise((r) => setTimeout(r, 30))
    expect(verify).toHaveBeenCalledTimes(3)
    stop()
  })

  it('stops when told to, without another try', async () => {
    const { log } = captureLog()
    const verify = vi.fn(async () => { throw refused() })
    const states: MailLogin[] = []
    const stop = watchSmtpLogin({ verify }, { host: 'h', log, recheckMs: 200, onState: (s) => states.push(s) })
    await vi.waitFor(() => expect(states).toEqual(['refused']))
    stop()
    const calls = verify.mock.calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(verify.mock.calls.length).toBe(calls)
  })
})

describe('imapLoginFrom', () => {
  it('reads the inbox’s refused login as refused and anything else as unreachable', () => {
    expect(imapLoginFrom({ reason: 'authentication_failed' })).toBe('refused')
    expect(imapLoginFrom({ reason: 'AUTHENTICATIONFAILED' })).toBe('refused')
    expect(imapLoginFrom({ reason: 'ETIMEOUT' })).toBe('unreachable')
    expect(imapLoginFrom({})).toBe('unreachable')
  })
})
