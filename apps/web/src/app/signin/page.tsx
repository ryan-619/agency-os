import { redirect } from 'next/navigation'
import { AuthError } from 'next-auth'
import { auth, signIn } from '@/auth'
import { deployment } from '@/lib/deployment'

export const dynamic = 'force-dynamic'

/**
 * Sign in by magic link. There is no signup: the address must already belong
 * to a team member (PROMPT.md §1), which the `signIn` callback in auth.ts
 * enforces before any mail is sent.
 */

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const session = await auth()
  if (session?.user) redirect('/')

  // Next 16 passes searchParams as a promise to server components.
  const { error } = await searchParams

  return (
    <div className="auth-wrap">
      <div className="auth">
        <h1>Agency OS</h1>
        <p>Internal tool. Sign in with your team address.</p>

        {error ? <p className="err">Sign-in failed. Try again.</p> : null}

        <form
          action={async (formData: FormData) => {
            'use server'
            const email = String(formData.get('email') ?? '').trim()
            if (!email) return

            try {
              await signIn('nodemailer', { email, redirectTo: '/' })
            } catch (err) {
              /**
               * Two things are thrown through here and they must be handled
               * differently.
               *
               * On success `signIn` calls redirect(), which throws NEXT_REDIRECT.
               * That MUST propagate or the redirect never happens — so anything
               * that is not an AuthError is re-thrown untouched.
               *
               * On refusal @auth/core throws AccessDenied, and next-auth's
               * `signIn` re-throws it rather than converting it to a redirect
               * (lib/actions.js: `if (isAuthError && isRaw && !isRedirect) throw`).
               * Uncaught, that surfaced as a 500 "server-side exception" page —
               * so the friendly message this page renders was unreachable.
               */
              if (err instanceof AuthError) {
                /**
                 * Deliberately the SAME destination as success.
                 *
                 * The check-email page promises the system will not reveal
                 * which addresses belong to the team, and that promise has to
                 * be kept in behaviour, not just in copy: a distinguishable
                 * response is an oracle that turns an address list into the
                 * exact roster worth phishing. Both outcomes look identical
                 * from outside; only a real team member gets mail.
                 */
                redirect('/signin/check-email')
              }
              throw err
            }
          }}
        >
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@agency.com" />
          <button type="submit">Email me a sign-in link</button>
        </form>

        <p className="fine">
          The link is valid for 15 minutes and can be used once.
          {deployment().mailIsLocalSink ? (
            <>
              {' '}This instance sends through a local mail sink, so the message never leaves the
              machine — read it at <a href="http://localhost:8025">localhost:8025</a>.
            </>
          ) : null}
        </p>
      </div>
    </div>
  )
}
