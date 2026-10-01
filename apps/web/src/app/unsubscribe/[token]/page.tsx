import type { Metadata } from 'next'
import { unsubscribeOrgName, verifyUnsubscribeToken, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'

/**
 * The page behind an unsubscribe link (RFC 8058, §2.1).
 *
 * No session, no shell: the person arriving here is somebody this agency
 * emailed. Exempt from the cookie gate in `proxy.ts`. It shows one sentence
 * and one button, and records NOTHING by being loaded — link scanners and
 * mail-client previews fetch every URL in a message, and an opt-out recorded
 * on a GET would be recorded for people who never asked. The button POSTs
 * to `/api/unsubscribe/<token>`, the same endpoint a mail client's one-click
 * uses, so there is one path that writes the suppression row.
 *
 * The org's display name is the only thing this page reveals, and only to
 * someone holding a token this deployment signed — which is to say, the
 * person the message went to. Never the address: the token names a row, and
 * the row stays in the database.
 *
 * `force-dynamic` like every page here, and for a sharper reason than most:
 * with no cookies or headers read, Next would otherwise render a token's
 * answer once and cache it at that path.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Unsubscribe',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const secret = env().UNSUBSCRIBE_SECRET
  if (!secret) {
    return (
      <Frame>
        <p>
          This link cannot be used right now. Reply to the email asking to be removed, and a person will
          record it.
        </p>
      </Frame>
    )
  }

  const check = verifyUnsubscribeToken(secret, token)
  if (!check.ok) return <Invalid />

  let orgName: string | null
  try {
    orgName = await unsubscribeOrgName(getDb() as unknown as AgencyDb, check.touchId)
  } catch (err) {
    log.warn('unsubscribe page could not read the touch', {
      touchId: check.touchId,
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    return (
      <Frame>
        <p>
          This link cannot be checked right now. Try again in a few minutes, or reply to the email asking to
          be removed and a person will record it.
        </p>
      </Frame>
    )
  }
  if (!orgName) return <Invalid />

  return (
    <Frame>
      <p>Click to stop receiving email from {orgName}. This records your request immediately.</p>
      <form method="post" action={`/api/unsubscribe/${encodeURIComponent(token)}`}>
        {/* The RFC 8058 body, so a click from here and a mail client's one-click are the same request. */}
        <input type="hidden" name="List-Unsubscribe" value="One-Click" />
        <button type="submit">Unsubscribe</button>
      </form>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth">
        <h1>Unsubscribe</h1>
        {children}
      </div>
    </div>
  )
}

/** The same answer for a bad MAC, a malformed token and a row that is not an outbound email: no hint. */
function Invalid() {
  return (
    <Frame>
      <p>This link is not valid.</p>
    </Frame>
  )
}
