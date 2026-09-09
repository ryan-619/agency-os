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
    trustHost: e.AUTH_TRUST_HOST,

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
          const { host } = new URL(url)
          await transport().sendMail({
            to: identifier,
            from: provider.from,
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
        // The verification-request leg also runs this callback; reject unknown
        // addresses there so no mail is sent to a stranger at all.
        const address = user?.email
        if (!address) return false

        const rows = await getDb()
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(sql`lower(${schema.users.email})`, address.toLowerCase()))
          .limit(1)

        if (rows.length === 0) {
          log.warn('sign-in refused: address is not a team member', { identifier: address })
          return false
        }
        // `email.verificationRequest` is true on the leg that sends the mail.
        void email
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

export { handlers, auth, signIn, signOut }

/** Convenience re-exports for the route handler. */
export const { GET, POST } = handlers
