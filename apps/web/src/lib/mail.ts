import { createTransport } from 'nodemailer'
import { env } from '@/lib/env'

/**
 * Outbound SMTP for magic links.
 *
 * From Phase 4 this same transport sits behind the single send path in
 * packages/core; today it is only used for sign-in mail, which goes to a
 * member of the team, not to a prospect, and therefore bypasses no
 * suppression or consent rule that exists yet.
 */
export function transport() {
  const e = env()
  return createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD ?? '' } : undefined,
  })
}
