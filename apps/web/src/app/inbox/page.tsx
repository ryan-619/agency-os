import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import {
  inboxKindFilter, inboxTouches, inboxUnhandledCount, listCampaigns, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { InboxQueue, type InboxRowView } from '@/components/inbox/queue'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'
import { inZone } from '@/lib/format'
import {
  INBOX_GROUP_LABELS, INBOX_GROUP_ORDER, INBOX_LEDE, groupInbox, inboxDeploymentNotes, inboxGroupOf, personName,
} from '@/lib/inbox-view'

/**
 * The inbox (PROMPT.md §8.4): every reply, its kind, and what a person did.
 *
 * A reply has already done four things by the time it is on this page
 * (`recordInboundReply`): it was logged, it paused the person in every
 * campaign, it cancelled what was queued for them, and it moved the deal
 * forward. What is left is for a person: read it, say it was dealt with,
 * disagree with its kind, and — if it deserves one — answer it. The answer
 * is a draft on /approvals like every other message; nothing leaves from here.
 *
 * The deployment is asked first. A page that lists replies on a deployment
 * that cannot receive any says so, rather than looking like an empty inbox.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[]; show?: string | string[] }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const params = await searchParams
  const kind = inboxKindFilter(typeof params.kind === 'string' ? params.kind : undefined) ?? undefined
  const unhandledOnly = params.show === 'unhandled'

  const db = getDb() as unknown as AgencyDb
  const [rows, unhandled, campaigns] = await Promise.all([
    inboxTouches(db, user.orgId, { kind, unhandledOnly }),
    inboxUnhandledCount(db, user.orgId),
    listCampaigns(db, user.orgId),
  ])

  const views: InboxRowView[] = rows.map((r) => {
    // Their time, in THEIR zone (or their company's) — never the viewer's
    // with a zone name beside it. With neither, the client shows the
    // viewer's and says so.
    const zone = r.contact?.timeZone ?? r.company?.timeZone ?? null
    return {
      id: r.touch.id,
      group: inboxGroupOf(r.touch.replyKind),
      channel: r.touch.channel,
      subject: r.touch.subject,
      body: r.touch.body,
      from: r.touch.recipient,
      receivedAt: r.touch.createdAt.toISOString(),
      localTime: zone ? inZone(r.touch.createdAt, zone) : null,
      company: r.company ? { domain: r.company.domain, name: r.company.name } : null,
      contact: r.contact
        ? {
            id: r.contact.id,
            name: personName(r.contact),
            email: r.contact.email,
            phone: r.contact.phone,
            paused: r.contact.pausedAt !== null,
            pausedReason: r.contact.pausedReason,
          }
        : null,
      parent: r.parent
        ? {
            subject: r.parent.subject,
            campaignId: r.parent.campaignId,
            campaignName: r.parent.campaignName,
            approvedBy: r.parent.approvedBy ? r.parent.approvedBy.name ?? r.parent.approvedBy.email : null,
            sentAt: r.parent.sentAt ? r.parent.sentAt.toISOString() : null,
          }
        : null,
      dealStage: r.dealStage,
      suppressed: r.suppressed,
      fromIsContact: r.fromIsContact,
      handled:
        r.handledBy && r.touch.handledAt
          ? { by: r.handledBy.name ?? r.handledBy.email, at: r.touch.handledAt.toISOString() }
          : null,
      answered: r.answered,
    }
  })

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const notes = inboxDeploymentNotes(deployment())
  const filterLink = (next: { kind?: string; show?: string }): string => {
    const q = new URLSearchParams()
    if (next.kind) q.set('kind', next.kind)
    if (next.show) q.set('show', next.show)
    const s = q.toString()
    return s ? `/inbox?${s}` : '/inbox'
  }
  const on = { fontWeight: 600, textDecoration: 'none' } as const

  return (
    <Shell user={user} current="inbox" signOut={signOutAction}>
      <h1>Inbox</h1>
      <p className="lede">{INBOX_LEDE}</p>

      {notes.map((n) => (
        <div key={n} className="note note-warn" style={{ marginBottom: 12 }}>
          {n}
        </div>
      ))}

      <p style={{ fontSize: 13, margin: '0 0 6px' }}>
        <a href={filterLink({ kind })} style={unhandledOnly ? undefined : on}>
          Every reply
        </a>
        {' · '}
        <a href={filterLink({ kind, show: 'unhandled' })} style={unhandledOnly ? on : undefined}>
          Not handled yet ({unhandled})
        </a>
      </p>
      <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
        {kind ? (
          <a href={filterLink({ show: unhandledOnly ? 'unhandled' : undefined })}>Every kind</a>
        ) : (
          <strong>Every kind</strong>
        )}
        {INBOX_GROUP_ORDER.map((g) => (
          <span key={g}>
            {' · '}
            {kind === g ? (
              <strong>{INBOX_GROUP_LABELS[g]}</strong>
            ) : (
              <a href={filterLink({ kind: g, show: unhandledOnly ? 'unhandled' : undefined })}>{INBOX_GROUP_LABELS[g]}</a>
            )}
          </span>
        ))}
      </p>

      {views.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          {unhandledOnly || kind
            ? 'Nothing matches that filter.'
            : 'No replies yet. When somebody answers a message this system sent, it lands here — paused, classified, and waiting for a person.'}
        </p>
      ) : (
        <InboxQueue
          groups={groupInbox(views, (v) => v.group)}
          campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, channel: c.channel, status: c.status }))}
          canWrite={can(principal, 'contacts:write')}
          canAnswer={can(principal, 'campaigns:write')}
        />
      )}

      {rows.length >= 100 ? (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
          Showing the first 100, the unread and urgent kinds first. Filter by kind to see the rest.
        </p>
      ) : null}
    </Shell>
  )
}
