import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { pendingApprovals, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'
import { ApprovalQueue } from '@/components/chat/queue'

/**
 * The approval queue (PROMPT.md §2.4, §5.4).
 *
 * The chat panel shows an approval inline, which is the right place when
 * someone is watching the turn that raised it. This page is for the other
 * case, which is at least as common: the person who asked has gone to lunch,
 * and the turn is parked for thirty minutes waiting on anybody at all.
 *
 * §5.4's `notifyTeam(approval)` is this page, the sidebar count, and the row
 * itself. It deliberately sends no mail: Phase 2 ships no send path, §8.4 says
 * there must be exactly one, and adding a second here — to notify about the
 * first — would be the joke writing itself.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ApprovalsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const rows = await pendingApprovals(db, user.orgId)

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

  const decidable = can({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')

  return (
    <Shell
      user={user}
      orgName={orgLabel}
      current="approvals"
      signOut={signOutAction}
      pendingApprovals={rows.length}
    >
      <h1>Approvals</h1>
      <p className="lede">
        Anything that would leave the building waits here for a person. Nothing in Agency OS can
        send a message yet — the send path lands in Phase 4 — so approving a draft records the
        decision and lets the agent carry on, and nothing is delivered to anyone.
      </p>

      {rows.length === 0 ? (
        <div className="note">
          <strong>Nothing is waiting.</strong> When the agent tries to do something that leaves the
          building, it parks here and the conversation waits for your answer.
        </div>
      ) : (
        <ApprovalQueue
          canDecide={decidable}
          items={rows.map((r) => ({
            id: r.id,
            toolName: r.toolName,
            risk: r.risk,
            // Not truncated. Someone deciding whether this may be sent has to
            // see exactly what they are approving.
            payload: r.payload,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
          }))}
        />
      )}

      {!decidable ? (
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
          Your role cannot decide approvals. Someone with the owner role has to.
        </p>
      ) : null}
    </Shell>
  )
}
