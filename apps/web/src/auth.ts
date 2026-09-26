import NextAuth from 'next-auth'
import Nodemailer from 'next-auth/providers/nodemailer'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@/lib/db'
import { env } from '@/lib/env'
import { transport } from '@/lib/mail'
import { log } from '@/lib/logger'
import type { Role } from '@agency/core'

/**
 * Auth.js v5, email magic link, database sessions (PROMPT.md §3).
 *
 * Verified against next-auth@5.0.0-beta.32 and @auth/drizzle-adapter@1.11.3:
 *   * `providers/email` is deprecated in favour of `providers/nodemailer`;
 *     the provider id is therefore "nodemailer", not "email".
 *   * The adapter's schema map keys are usersTable / accountsTable /
 *     sessionsTable / verificationTokensTable. authenticatorsTable is optional
 *     (WebAuthn) and is not used here.
 *   * next-auth 5.0.0-beta.32 declares a next peer of ^14 || ^15 || ^16.
 */
const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const e = env()
  return {
    adapter: DrizzleAdapter(getDb(), {
      usersTable: schema.users,
      accountsTable: schema.accounts,
      sessionsTable: schema.sessions,
      verificationTokensTable: schema.verificationTokens,
    }),

    // The email provider issues a single-use token that must be looked up on
    // the callback, so sessions are database-backed rather than JWT.
    session: { strategy: 'database', maxAge: 60 * 60 * 24 * 30 },

    secret: e.AUTH_SECRET,
    // undefined (not false) when unset, so @auth/core's own `??=` default
    // still applies. See the note in lib/env.ts.
    ...(e.AUTH_TRUST_HOST === undefined ? {} : { trustHost: e.AUTH_TRUST_HOST }),

    pages: { signIn: '/signin', verifyRequest: '/signin/check-email', error: '/signin' },

    providers: [
      Nodemailer({
        /**
         * `server` is required even though sendVerificationRequest below is
         * fully overridden and never uses it: the provider factory throws
         * `AuthError: Nodemailer requires a 'server' configuration` at
         * construction time if it is absent. Verified against
         * @auth/core@0.41.3 (providers/nodemailer.js, first statement).
         */
        server: {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE,
          auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD ?? '' } : undefined,
        },
        from: e.MAIL_FROM,
        // The default is 24 hours, which is far too long for a bearer credential.
        maxAge: 60 * 15, // a magic link is valid for 15 minutes
        /**
         * Overridden so the link is sent by our own transport and so that the
         * URL — which is a bearer credential for this account — is never
         * written to a log line (§2.3). Only the fact of sending is logged.
         */
        async sendVerificationRequest({ identifier, url, provider }) {
          /**
           * Membership is checked HERE rather than by refusing in the signIn
           * callback, so that the HTTP response is identical either way.
           *
           * Refusing in the callback makes @auth/core throw AccessDenied,
           * which redirects somewhere visibly different from the success path
           * — a clean oracle that turns a list of guessed addresses into the
           * exact roster worth phishing. The check-email page promises the
           * system will not reveal who has access; this is what keeps that
           * promise. A stranger gets the same redirect and no mail.
           */
          const known = await getDb()
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, identifier.toLowerCase()))
            .limit(1)

          if (known.length === 0) {
            log.warn('sign-in requested for an address that is not a team member', { identifier })
            return
          }

          const { host } = new URL(url)
          /**
           * The send is wrapped because THROWING here re-opens the oracle the
           * membership check above closes.
           *
           * @auth/core turns an exception out of `sendVerificationRequest`
           * into an error redirect, while the non-member path a few lines up
           * returns normally and lands on the check-email page. So the moment
           * SMTP is down, misconfigured, rate-limited or rejecting the
           * credential, the two paths become visibly different again and a
           * list of guessed addresses turns back into the exact roster.
           *
           * And SMTP being wrong is not a remote possibility — it is the
           * NORMAL state of a deployment whose sending domain has not been
           * set up yet, which is every deployment on its first day. The
           * oracle would be widest open exactly when nobody is looking for it.
           *
           * So a failed send produces the same response as a successful one,
           * and is reported as an error in the log instead. A member who gets
           * no mail is a worse experience than an error page; a stranger who
           * can enumerate the team is a worse outcome.
           */
          try {
            await sendMagicLink(url, identifier, provider.from)
          } catch (err) {
            // The class and code only. A nodemailer error can quote the
            // server's response, and `url` is a bearer credential for this
            // account — neither belongs in a log line (§2.3).
            log.error('magic link could not be sent; the address was told nothing', {
              identifier,
              host,
              error: err instanceof Error ? err.name : 'UnknownError',
              code: typeof (err as { code?: unknown })?.code === 'string'
                ? (err as { code: string }).code
                : undefined,
            })
            return
          }
          // identifier is an email address belonging to the team, not a
          // prospect, and the token is deliberately absent from this line.
          log.info('magic link sent', { identifier, host })
        },
      }),
    ],

    callbacks: {
      /**
       * There is no signup flow (§1). A person can sign in only if a team
       * member row already exists for their address — created by `npm run
       * db:seed` or by an owner inviting them. Without this, the adapter
       * would happily create a user for any address that receives the mail.
       */
      async signIn({ user, email }) {
        const address = user?.email
        if (!address) return false

        /**
         * This callback runs on BOTH legs of the magic-link flow.
         *
         * On the request leg (`email.verificationRequest`) it always allows,
         * so that a stranger and a team member get byte-identical responses —
         * sendVerificationRequest above is what decides whether mail is
         * actually sent. Refusing here instead would leak membership.
         *
         * On the callback leg — someone holding a token — membership is
         * required, and this is the gate that enforces "no signup flow" (§1).
         */
        if (email?.verificationRequest) return true

        /**
         * Exact match, not lower(email).
         *
         * @auth/core normalises the identifier to lower case before this
         * callback runs, and @auth/drizzle-adapter's getUserByEmail then does
         * an exact `eq(users.email, email)`. A case-insensitive gate here
         * would admit a user the adapter cannot find, and the adapter would
         * try to CREATE them — failing on users.org_id NOT NULL. The database
         * guarantees the two agree: users_email_is_normalised forbids storing
         * anything but the trimmed, lower-cased form.
         */
        const rows = await getDb()
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, address.toLowerCase()))
          .limit(1)

        if (rows.length === 0) {
          log.warn('sign-in refused: address is not a team member', { identifier: address })
          return false
        }
        return true
      },

      /**
       * Put org and role on the session so the UI and the API agree (§4).
       *
       * The returned object is built explicitly rather than by mutating and
       * returning `session`. Under the database strategy the `session`
       * argument is `{ ...adapterSession, user }` — it carries the raw
       * `sessionToken` and `userId`, and returning it verbatim publishes the
       * session token from GET /api/auth/session. Verified against
       * next-auth@5.0.0-beta.32 + @auth/core@0.41.3.
       */
      async session({ session, user }) {
        const rows = await getDb()
          .select({ orgId: schema.users.orgId, role: schema.users.role })
          .from(schema.users)
          .where(eq(schema.users.id, user.id))
          .limit(1)

        const row = rows[0]
        return {
          expires: session.expires,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            orgId: row?.orgId ?? '',
            role: (row?.role ?? 'member') as Role,
          },
        }
      },
    },

    logger: {
      error: (err) => log.error('auth error', { message: err.message, name: err.name }),
      warn: (code) => log.warn('auth warning', { code }),
      // debug intentionally dropped: Auth.js debug output includes tokens.
      debug: () => {},
    },
  }
})

/**
 * Compose and send the sign-in mail.
 *
 * Split out so the caller's try/catch is obviously around the whole send, and
 * so nothing between the membership check and the send can grow a second early
 * return that changes the response shape.
 */
async function sendMagicLink(
  url: string,
  identifier: string,
  // `string | undefined` because that is what the provider's own type says,
  // and passing it straight through preserves the previous behaviour exactly.
  // In practice it is always set: the provider is constructed with
  // `from: e.MAIL_FROM`, which env() gives a default.
  from: string | undefined,
): Promise<void> {
  await transport().sendMail({
    to: identifier,
    from,
    subject: `Sign in to Agency OS`,
    text: `Sign in to Agency OS\n\n${url}\n\nThis link is valid for 15 minutes and can be used once.\nIf you did not request it, ignore this message.\n`,
    html: `
      <body style="font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; color: #111">
        <h2 style="margin:0 0 12px">Sign in to Agency OS</h2>
        <p style="margin:0 0 20px">Use the button below to sign in as <strong>${escapeHtml(identifier)}</strong>.</p>
        <p style="margin:0 0 24px">
          <a href="${url}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a>
        </p>
        <p style="margin:0;color:#666;font-size:13px">
          This link is valid for 15 minutes and can be used once. If you did not request it, ignore this message.
        </p>
      </body>`,
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

export { handlers, auth, signIn, signOut }

/** Convenience re-exports for the route handler. */
export const { GET, POST } = handlers
