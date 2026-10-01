/**
 * The SMTP provider (PROMPT.md §8.4).
 *
 * "Email via SMTP over the agency's warmed mailboxes; SendGrid behind the same
 * interface for later volume."
 *
 * So this implements `MessageProvider` and nothing else. It does not decide
 * anything, it does not read the suppression list, and it does not know what a
 * campaign is — `sendOne` has already answered all of that by the time this is
 * called. A provider that could be reached without going through `sendOne`
 * would be a second path out of the building, which §8.4 forbids in as many
 * words.
 *
 * That is also why this file exports a FACTORY rather than a configured
 * instance: nothing constructs a transport at import time, so importing this
 * module cannot cause a connection, and a test that imports the send path
 * cannot accidentally acquire something that can deliver.
 */
import { createTransport, type Transporter } from 'nodemailer'
import type { MessageProvider } from './outreach.js'

export interface SmtpConfig {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string | undefined
  readonly password?: string | undefined
  /** The From header. A display name plus address, e.g. `Priya <priya@…>`. */
  readonly from: string
}

/**
 * Build the email provider.
 *
 * The transport is created once and reused: SMTP connection setup is the
 * expensive part, and a warmed mailbox's reputation depends partly on not
 * hammering it with new connections. `pool: true` keeps a small number open.
 */
export function createSmtpProvider(config: SmtpConfig): MessageProvider {
  let transport: Transporter | null = null

  const get = (): Transporter => {
    transport ??= createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Omitted entirely when there is no user. Passing `auth: { user:
      // undefined }` makes nodemailer attempt an AUTH command with an empty
      // username, which a real relay answers with 535 — and the error it
      // returns says "authentication failed", pointing at a password that is
      // not the problem.
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
      pool: true,
      maxConnections: 3,
    })
    return transport
  }

  return {
    name: 'smtp',
    channels: ['email'],
    async send(message) {
      // Headers are passed through as the send path built them. `In-Reply-To`
      // and `References` are ALSO set through nodemailer's own fields, which
      // it formats and folds correctly; `setHeader` replaces rather than
      // duplicates, so the same value arriving both ways is one header.
      const headers = message.headers ?? {}
      const inReplyTo = headers['In-Reply-To']
      const info = await get().sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        headers,
        ...(inReplyTo ? { inReplyTo, references: headers['References'] ?? inReplyTo } : {}),
      })
      // The Message-ID the server assigned. Kept on the touch row, and it is
      // what ties a bounce or a reply webhook back to the message that caused
      // it — without it an inbound reply can only be matched by address, which
      // is ambiguous the moment one person is in two campaigns.
      return { providerId: info.messageId }
    },
  }
}

/**
 * A provider that records instead of sending.
 *
 * For a dry run of a campaign, and for anywhere a real provider would be
 * dangerous. It satisfies the same interface so the path under test is the
 * path that runs in production — a code branch for "pretend to send" inside
 * `sendOne` would be a branch that could be wrong in exactly one direction.
 */
export function createDryRunProvider(
  onSend?: (m: { to: string; subject: string }) => void,
): MessageProvider & { readonly sent: readonly { to: string; subject: string }[] } {
  const sent: { to: string; subject: string }[] = []
  return {
    name: 'dry-run',
    channels: ['email', 'linkedin', 'sms', 'voice', 'whatsapp'],
    sent,
    async send(message) {
      sent.push({ to: message.to, subject: message.subject })
      onSend?.({ to: message.to, subject: message.subject })
      return { providerId: `dry-run-${sent.length}` }
    },
  }
}
