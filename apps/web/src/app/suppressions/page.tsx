import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { listSuppressions, pausedContacts, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { SuppressionsPanel } from '@/components/outreach/suppressions'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

/**
 * The suppression list and the paused contacts (PROMPT.md §2.1, §8.4).
 *
 * Two lists that both mean "do not write to these people", with different
 * strengths. A suppression is permanent until an owner removes it, and it is
 * checked by the send path before anything else. A pause is what a reply
 * does — every campaign, immediately — and it ends when a person resumes.
 */
export const dynamic = 'force-dynamic'

export default async function SuppressionsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const [suppressions, paused] = await Promise.all([
    listSuppressions(db, user.orgId),
    pausedContacts(db, user.orgId),
  ])

  const icpRow = await icpForOrg(user.orgId)
  let orgLabel = 'Agency'
  if (icpRow) {
    try {
      orgLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      orgLabel = 'Agency'
    }
  }

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="suppressions" signOut={signOutAction}>
      <h1>Suppressions</h1>
      <p className="lede">
        One row here and no channel may ever contact that address, number or domain again. It is
        checked first, before consent and before anything a campaign says, on every message. Values
        are normalised on the way in so that a lookup is an exact match — a value that cannot be
        normalised is refused rather than stored in a form that would never match.
      </p>
      <SuppressionsPanel
        suppressions={suppressions.map((s) => ({
          id: s.id,
          kind: s.kind,
          value: s.value,
          reason: s.reason,
          createdAt: s.createdAt.toISOString(),
        }))}
        paused={paused.map((p) => ({
          id: p.id,
          email: p.email,
          pausedAt: p.pausedAt ? p.pausedAt.toISOString() : null,
          pausedReason: p.pausedReason,
        }))}
        canWrite={can(principal, 'contacts:write')}
        canRemove={can(principal, 'users:write')}
      />
    </Shell>
  )
}
