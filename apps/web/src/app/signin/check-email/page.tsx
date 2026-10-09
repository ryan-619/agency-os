import { deployment } from '@/lib/deployment'
import { PasteSignInLink } from '@/components/paste-signin-link'

/**
 * Rendered per request, because it reads configuration.
 *
 * This page has no data and was therefore statically prerendered — which
 * means it ran at BUILD time, where runtime configuration does not exist.
 * `deployment()` calls `env()`, `env()` throws on a missing DATABASE_URL, and
 * the build died on this one page with production secrets absent. That is
 * the same trap CLAUDE.md §4 records for `getDb()`: an image build must not
 * need runtime credentials, and the way that rule gets broken is a module
 * reading configuration somewhere that runs before deploy rather than after.
 *
 * It was invisible locally because `apps/web/.env` is a symlink to the repo
 * root `.env`, so a build on this machine has the variables whether or not
 * the shell exports them.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default function CheckEmail() {
  return (
    <div className="auth-wrap">
      <div className="auth">
        <h1>Check your inbox</h1>
        <p>
          If that address belongs to a team member, a sign-in link is on its way. It is valid
          for 15 minutes and can be used once.
        </p>
        <p style={{ margin: '0 0 20px' }}>
          {/* The dead end this page used to be: a mistyped address left
              nowhere to go but the back button. */}
          <a href="/signin">Use a different address</a>
        </p>
        <PasteSignInLink />
        <p className="fine">
          You will see this page whether or not the address is on the team, and no account is
          ever created — so this screen reveals nothing about who has access.
          {deployment().mailIsLocalSink ? (
            <>
              <br />
              <br />
              This instance sends through a local mail sink, so nothing was actually
              delivered: <a href="http://localhost:8025">open the sink at localhost:8025</a>{' '}
              and follow the link there.
            </>
          ) : null}
        </p>
      </div>
    </div>
  )
}
