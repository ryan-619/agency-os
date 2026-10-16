/**
 * Whether the worker's mailboxes accept its logins, said before a message
 * depends on it.
 *
 * On 2026-10-08 the outgoing mailbox was switched from Resend to Google with
 * the app password typed at the username prompt. Nothing said so: the
 * worker booted "sending: ON", and the first approved email of the morning
 * would have failed at the server's login and been left `failed`, to be
 * drafted again. So the SMTP login is tried at boot — nodemailer's
 * `verify()`: connect, greet, authenticate, quit, nothing sent — and every
 * half hour while it is not known to work, and the IMAP inbox reports each
 * session's outcome. The state rides on the heartbeat (`detail.smtpLogin`,
 * `detail.imapLogin`), so the dashboard can say a login was refused.
 *
 * A failure is logged by a reason and a hint, never the error's message: a
 * server's refusal can quote the username, and a username typed at the wrong
 * prompt can be a password.
 */
import type { MessageProvider } from '@agency/db'
import type { Logger } from '../logger.js'

/** `unchecked` until the first answer; `ok`, `refused` or `unreachable` after. */
export type MailLogin = 'unchecked' | 'ok' | 'refused' | 'unreachable'

export interface MailLoginFailure {
  readonly state: 'refused' | 'unreachable'
  readonly reason: string
  readonly hint: string
}

/** How long one try may take. A server that never answers is `unreachable`. */
export const SMTP_VERIFY_TIMEOUT_MS = 20_000
/** How often a login not known to work is tried again. */
export const SMTP_RECHECK_MS = 30 * 60_000

const token = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(v) ? v : undefined

/**
 * What a failed SMTP login was, from nodemailer's error: `EAUTH` (or a 534
 * or 535 reply) is the server refusing the username or password; anything
 * else is the server not being reached, which the hint does not blame on
 * the settings — a laptop offline answers ENOTFOUND for every name.
 */
export function smtpFailure(err: unknown, host: string): MailLoginFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; responseCode?: unknown }
  const code = token(e.code) ?? (err instanceof Error && err.name === 'SmtpVerifyTimeout' ? 'TIMEOUT' : 'UNKNOWN')
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null
  if (code === 'EAUTH' || responseCode === 534 || responseCode === 535) {
    const google = /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i.test(host)
    const resend = /(^|\.)resend\.com$/i.test(host)
    return {
      state: 'refused',
      reason: responseCode !== null ? `${code} ${responseCode}` : code,
      hint: google
        ? 'Google refused the login: the username must be the whole address and the password an app password — ./tools/run-worker.sh --gmail sets both'
        : resend
          ? "Resend refused the login: the username is `resend` and the password an API key — ./tools/run-worker.sh --smtp"
          : 'the mail server refused SMTP_USER or SMTP_PASSWORD — ./tools/run-worker.sh --smtp',
    }
  }
  return {
    state: 'unreachable',
    reason: code,
    hint:
      code === 'TIMEOUT'
        ? 'the mail server did not answer in time — this machine may be offline; it is tried again'
        : 'the mail server could not be reached — check SMTP_HOST and SMTP_PORT, and that this machine is online; it is tried again',
  }
}

/**
 * Try the outgoing login once, within `SMTP_VERIFY_TIMEOUT_MS`, and log the
 * outcome. Never throws.
 */
export async function checkSmtpLogin(
  provider: Pick<MessageProvider, 'verify'>,
  opts: { readonly host: string; readonly log: Logger; readonly timeoutMs?: number },
): Promise<MailLogin> {
  if (!provider.verify) return 'unchecked'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      provider.verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error('the SMTP login did not answer in time')
          e.name = 'SmtpVerifyTimeout'
          reject(e)
        }, opts.timeoutMs ?? SMTP_VERIFY_TIMEOUT_MS)
      }),
    ])
    opts.log.info('smtp login: ok', { host: opts.host })
    return 'ok'
  } catch (err) {
    const failure = smtpFailure(err, opts.host)
    if (failure.state === 'refused') {
      opts.log.error('SMTP LOGIN REFUSED — approved email will fail to send until this is fixed', {
        host: opts.host,
        reason: failure.reason,
        hint: failure.hint,
      })
    } else {
      opts.log.warn('smtp login: the mail server was not reached', {
        host: opts.host,
        reason: failure.reason,
        hint: failure.hint,
      })
    }
    return failure.state
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Check at once, then again every `SMTP_RECHECK_MS` while the answer is not
 * `ok` — a laptop that booted offline gets its answer once it is online.
 * `onState` hears each answer. Returns a stop function.
 */
export function watchSmtpLogin(
  provider: Pick<MessageProvider, 'verify'>,
  opts: {
    readonly host: string
    readonly log: Logger
    readonly onState: (state: MailLogin) => void
    readonly recheckMs?: number
    readonly timeoutMs?: number
  },
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async (): Promise<void> => {
    if (stopped) return
    const state = await checkSmtpLogin(provider, opts)
    if (stopped) return
    opts.onState(state)
    if (state !== 'ok') timer = setTimeout(() => void run(), opts.recheckMs ?? SMTP_RECHECK_MS)
  }
  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** The inbox's session outcome as a login state: `authentication_failed` is refused, any other failure unreachable. */
export function imapLoginFrom(failure: { readonly reason?: string | undefined }): 'refused' | 'unreachable' {
  return failure.reason === 'authentication_failed' || failure.reason === 'AUTHENTICATIONFAILED' ? 'refused' : 'unreachable'
}
