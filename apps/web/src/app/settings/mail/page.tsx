import { redirect } from 'next/navigation'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { deployment } from '@/lib/deployment'
import { env } from '@/lib/env'
import { DKIM_DEFAULT_SELECTORS, isDkimSelector, mailFromDomain } from '@/lib/mail-dns'
import { MailDnsPanel } from './panel'

/**
 * Settings → Mail: SPF, DMARC and DKIM for the agency's OWN sending domain.
 *
 * The domain is read from `MAIL_FROM` and nothing else; the page offers no
 * way to check another. The lookup runs in `GET /api/settings/mail-dns`,
 * from the browser, so a slow nameserver delays a panel rather than the
 * page. A lookup that failed is "could not be checked" (§2.2): it is not an
 * observation, and calling it "missing" would be a finding nobody made.
 *
 * `?dkim=` names one selector to check instead of the default list. It is
 * checked here as a single DNS label before it reaches the panel, and again
 * by the route, which is the one that resolves it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NO_DOMAIN: Readonly<Record<'local' | 'no_address', string>> = {
  local:
    'MAIL_FROM is a development address with no public DNS, so there is nothing to check. Set it to the agency’s real sending address.',
  no_address: 'MAIL_FROM holds no address with a domain name, so there is nothing to check.',
}

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const sp = await searchParams
  const raw = typeof sp['dkim'] === 'string' ? sp['dkim'].trim() : ''
  const selectorRefused = raw !== '' && !isDkimSelector(raw)
  const dkim = raw !== '' && !selectorRefused ? raw.toLowerCase() : null

  const from = mailFromDomain(env().MAIL_FROM)
  const { mailIsLocalSink } = deployment()

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="mail" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Mail</h1>
      <p className="lede">
        This checks the agency&apos;s own sending domain, not a prospect&apos;s. A lookup that failed is &lsquo;could
        not be checked&rsquo; — it is not an observation.
      </p>

      {from.domain === null ? (
        <div className="note note-warn"><strong>{NO_DOMAIN[from.reason]}</strong></div>
      ) : (
        <>
          <table style={{ marginBottom: 12 }}>
            <tbody>
              <tr>
                <th style={{ width: 200 }}>Sending domain</th>
                <td className="mono">{from.domain}</td>
              </tr>
              <tr>
                <th>DKIM selectors tried</th>
                <td className="mono">{dkim ?? DKIM_DEFAULT_SELECTORS.join(', ')}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 13 }}>
            The domain is this web app&apos;s <code>MAIL_FROM</code> — the address sign-in links come from. The worker
            sends outreach from its own <code>MAIL_FROM</code>, set on its host; it is normally the same domain, and
            this page cannot see it.
          </p>
          {mailIsLocalSink ? (
            <div className="note warn">
              Sign-in mail on this deployment goes to a local development sink, so nothing this web app sends is
              judged by these records. They still decide how the worker&apos;s outreach from this domain is received.
            </div>
          ) : null}

          <div className="row-card slim" style={{ margin: '14px 0' }}>
            <form method="get" action="/settings/mail" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label htmlFor="dkim">Check one DKIM selector instead</label>
                <input id="dkim" name="dkim" defaultValue={dkim ?? ''} placeholder="e.g. resend" maxLength={63} />
                <span className="hint">
                  Selectors cannot be listed from DNS. Your provider names yours — Resend&apos;s is{' '}
                  <code>resend</code>, Google Workspace&apos;s <code>google</code>.
                </span>
              </div>
              <button type="submit">Check</button>
            </form>
            {selectorRefused ? (
              <p className="err-line">
                That is not a single DNS label (letters, digits and inner hyphens), so it was not looked up. The
                default selectors were checked instead.
              </p>
            ) : null}
            {dkim ? (
              <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
                <a href="/settings/mail">Back to the default selectors</a>
              </p>
            ) : null}
          </div>

          <MailDnsPanel dkim={dkim} />
        </>
      )}
    </Shell>
  )
}
