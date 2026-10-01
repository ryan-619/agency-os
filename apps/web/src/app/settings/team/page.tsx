import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import { usersList, type AgencyDb, type TeamMember } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { TeamPanel, type TeamMemberView } from '@/components/settings/team'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { env } from '@/lib/env'

/**
 * Settings → Team: who can sign in, as what, and taking that away.
 *
 * Every signed-in member may READ the roster — it is the people they already
 * work with — and only an owner may change it (`users:write`). What is never
 * shown is `verification_tokens`: it holds a row for anybody who typed an
 * address at /signin, strangers included, and listing those as "pending"
 * would turn an outsider's sign-in attempt into a roster entry.
 *
 * The two dates are chosen for what they honestly mean. "Access granted" is
 * `created_at`. "Last signed in" is `email_verified`, which Auth.js re-stamps
 * on every completed magic link and at no other time; `updated_at` moves on
 * every sign-in too, through the adapter, so it is shown nowhere.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function TeamPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const members = await usersList(db, user.orgId)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const signInUrl = new URL('/signin', env().AUTH_URL).toString()
  const { mailIsLocalSink } = deployment()

  return (
    <Shell user={user} current="team" signOut={signOutAction}>
      <h1>Team</h1>
      <p className="lede">
        Who can sign in, and as what. Access is revoked, never deleted: every approval and message
        the person decided stays attributed to them.
      </p>
      <p className="muted" style={{ fontSize: 13 }}>
        Granting access sends nothing. The person goes to <code>{signInUrl}</code>, enters this
        address, and a sign-in link is mailed to it. Revoking signs them out of every browser at once
        and refuses their next link; restoring gives back the role they had, and they sign in again
        with a new link.
      </p>
      {mailIsLocalSink ? (
        <div className="note warn" style={{ marginBottom: 14 }}>
          Sign-in mail on this deployment goes to a local development mail sink, not to anybody’s
          inbox. A person granted access here cannot sign in from their own mailbox until real mail
          is configured.
        </div>
      ) : null}
      <TeamPanel
        members={members.map((m) => toView(m, user.id))}
        canWrite={can(principal, 'users:write')}
      />
    </Shell>
  )
}

/** The row, reduced to what the panel shows. Dates cross as ISO strings. */
function toView(m: TeamMember, viewerId: string): TeamMemberView {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
    grantedAt: m.createdAt.toISOString(),
    lastSignInAt: m.lastSignInAt ? m.lastSignInAt.toISOString() : null,
    liveSessions: m.liveSessions,
    revokedAt: m.revokedAt ? m.revokedAt.toISOString() : null,
    isViewer: m.id === viewerId,
  }
}
