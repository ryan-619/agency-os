import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import { listSuppressions, pausedContacts, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { SuppressionsPanel } from '@/components/outreach/suppressions'
import { SUPPRESSION_SOURCE_WORDS, UNRECORDED_SOURCE, suppressionSource } from '@/lib/audit-copy'
import { getDb } from '@/lib/db'

/**
 * The suppression list and the paused contacts (PROMPT.md §2.1, §8.4).
 *
 * Two lists that both mean "do not write to these people", with different
 * strengths. A suppression is permanent until an owner removes it, and it is
 * checked by the send path before anything else. A pause is what a reply
 * does — every campaign, immediately — and it ends when a person resumes.
 *
 * Each suppression says how it got there (0018's `source`): added here, a
 * reply, a call, the unsubscribe link, or an erasure. A row from before the
 * column existed says "unrecorded" — inventing `manual` for it would be a
 * claim about who did what, which is the one thing the column is for. The
 * words are mapped here, on the server, so the browser bundle carries a tag
 * and a sentence rather than the vocabulary module.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="suppressions" signOut={signOutAction}>
      <h1>Suppressions</h1>
      <p className="lede">
        One row here and no channel may ever contact that address, number or domain again. It is
        checked first, before consent and before anything a campaign says, on every message. Values
        are normalised on the way in so that a lookup is an exact match — a value that cannot be
        normalised is refused rather than stored in a form that would never match. Every row says how it
        got here, and an addition or removal made on this page is on the{' '}
        <a href="/audit?action=suppression">audit log</a> — a removal with everything the row said.
      </p>
      <SuppressionsPanel
        suppressions={suppressions.map((s) => ({
          id: s.id,
          kind: s.kind,
          value: s.value,
          reason: s.reason,
          source: suppressionSource(s.source),
          createdAt: s.createdAt.toISOString(),
        }))}
        sources={[...Object.values(SUPPRESSION_SOURCE_WORDS), UNRECORDED_SOURCE]}
        paused={paused.map((p) => ({
          id: p.id,
          // Who they are, on every row (review round 10, [7]) — /contacts' own fallback.
          name: [p.firstName, p.lastName].filter(Boolean).join(' ') || '(no name recorded)',
          email: p.email,
          phone: p.phone,
          pausedAt: p.pausedAt ? p.pausedAt.toISOString() : null,
          pausedReason: p.pausedReason,
        }))}
        canWrite={can(principal, 'contacts:write')}
        canRemove={can(principal, 'users:write')}
      />
    </Shell>
  )
}
