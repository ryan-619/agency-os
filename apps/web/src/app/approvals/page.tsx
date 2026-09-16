import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { and, eq, inArray } from 'drizzle-orm'
import {
  listCampaigns, listContactsForCompany, pendingApprovals, pendingDrafts, schema, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { icpForOrg } from '@/lib/queries'
import { ApprovalQueue } from '@/components/chat/queue'
import { DraftQueue, type DraftView } from '@/components/outreach/drafts'

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
  const [rows, drafts, campaigns] = await Promise.all([
    pendingApprovals(db, user.orgId),
    pendingDrafts(db, user.orgId),
    listCampaigns(db, user.orgId),
  ])

  /**
   * Who each draft could go to: the contacts at its company, with the ones the
   * send path would refuse anyway marked as such and why. The reason is shown
   * rather than the person silently omitted — "not offered: Priya (no
   * timezone)" is something a person can fix; an empty list is not.
   */
  const companyIds = [...new Set(drafts.map((d) => d.company?.id).filter((id): id is string => Boolean(id)))]
  const contactsByCompany = new Map(
    await Promise.all(
      companyIds.map(async (id) => [id, await listContactsForCompany(db, user.orgId, id)] as const),
    ),
  )
  // The send path falls back to the company's zone when the contact has none
  // (0010), so the page must too — or it refuses to offer people the worker
  // would happily send to. Found by review.
  const companyZones = new Map(
    (
      await db
        .select({ id: schema.companies.id, timeZone: schema.companies.timeZone })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, user.orgId), inArray(schema.companies.id, companyIds.length ? companyIds : ['00000000-0000-4000-8000-000000000000'])))
    ).map((c) => [c.id, c.timeZone] as const),
  )
  const draftViews: DraftView[] = drafts.map((d) => ({
    id: d.touch.id,
    channel: d.touch.channel,
    subject: d.touch.subject,
    body: d.touch.body,
    createdAt: d.touch.createdAt.toISOString(),
    company: d.company,
    candidates: (d.company ? contactsByCompany.get(d.company.id) ?? [] : []).map((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed'
      const address = d.touch.channel === 'linkedin' ? c.linkedinUrl : c.email
      const declined = c.consents.find((k) => k.channel === d.touch.channel && !k.granted)
      const zone = c.timeZone ?? (d.company ? companyZones.get(d.company.id) ?? null : null)
      const why = !address
        ? `no ${d.touch.channel === 'linkedin' ? 'LinkedIn profile' : 'email address'}`
        : c.pausedAt
          ? `paused — ${c.pausedReason ?? 'by a person'}`
          : declined
            ? 'declined this channel'
            : !zone
              ? 'no timezone on them or their company, so quiet hours cannot be checked'
              : null
      return { id: c.id, label: address ? `${name} <${address}>` : name, reachable: why === null, why }
    }),
  }))

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
        Anything that would leave the building waits here for a person. Two kinds of thing arrive:
        a message the agent drafted, which you address and approve — the worker then sends it after
        checking every rule again — and a tool the agent is asking to use right now, which a
        conversation is parked on.
      </p>

      <h2 style={{ fontSize: 15, margin: '18px 0 8px' }}>Messages to approve</h2>
      {draftViews.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>No drafts are waiting.</p>
      ) : (
        <DraftQueue
          drafts={draftViews}
          campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, channel: c.channel, autoSend: c.autoSend }))}
          canDecide={decidable}
          senderConnected={deployment().worker}
        />
      )}

      <h2 style={{ fontSize: 15, margin: '22px 0 8px' }}>Tools waiting on you</h2>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No conversation is parked. When the agent tries to do something that leaves the building
          mid-conversation, it waits here for your answer.
        </p>
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
