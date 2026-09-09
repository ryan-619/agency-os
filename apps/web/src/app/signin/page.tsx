import { redirect } from 'next/navigation'
import { auth, signIn } from '@/auth'

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

        {error ? (
          <p className="err">
            {error === 'AccessDenied'
              ? 'That address is not a team member. Ask an owner to add you.'
              : 'Sign-in failed. Try again.'}
          </p>
        ) : null}

        <form
          action={async (formData: FormData) => {
            'use server'
            const email = String(formData.get('email') ?? '').trim()
            if (!email) return
            await signIn('nodemailer', { email, redirectTo: '/' })
          }}
        >
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@agency.com" />
          <button type="submit">Email me a sign-in link</button>
        </form>

        <p className="fine">
          The link is valid for 15 minutes and can be used once. In local development,
          mail is captured by Mailpit at <a href="http://localhost:8025">localhost:8025</a> and
          never leaves the machine.
        </p>
      </div>
    </div>
  )
}
