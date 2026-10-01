import { redirect } from 'next/navigation'
import { parseIcpDefinition } from '@agency/core'
import { callsThatDidNotDisclose, listCalls, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

/**
 * Calls (PROMPT.md §8.5).
 *
 * The record of every conversation on the phone. Two columns here are not
 * statistics, they are evidence: whether the AI disclosed itself, and
 * whether the caller asked to be left alone. The page leads with the first
 * one going wrong, because a call that did not disclose is the only §2.1
 * failure that is invisible from everywhere else.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const OUTCOME_TONE: Readonly<Record<string, string>> = {
  qualified: ' on',
  handoff: '',
  opted_out: ' warn',
  not_qualified: '',
  incomplete: '',
  no_answer: '',
  failed: ' warn',
}

export default async function CallsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const [calls, undisclosed, icpRow] = await Promise.all([
    listCalls(db, user.orgId, 100),
    callsThatDidNotDisclose(db, user.orgId),
    icpForOrg(user.orgId),
  ])

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
    <Shell user={user} orgName={orgLabel} current="calls" signOut={signOutAction}>
      <h1>Calls</h1>
      <p className="lede">
        Inbound only. The AI says it is an AI before anything else, a caller who asks to be left alone is
        added to the suppression list during the call, and anyone who wants a person gets one. Nothing here
        places a call — cold voice is structurally impossible, and the dialling code does not exist.
      </p>

      {undisclosed.length > 0 ? (
        <div className="note note-warn">
          <strong>
            {undisclosed.length} answered {undisclosed.length === 1 ? 'call has' : 'calls have'} no AI
            disclosure recorded.
          </strong>{' '}
          That is a TCPA obligation (§2.1), not a preference. Every one of these needs explaining — start
          with the voice service&apos;s logs for the period.
        </div>
      ) : null}

      {calls.length === 0 ? (
        <div className="note">
          <strong>No calls yet.</strong>
          <p style={{ margin: '8px 0 0' }}>
            Voice runs in a separate service (<code>apps/voice</code>) holding a WebSocket to Twilio&apos;s
            ConversationRelay — it cannot run on a serverless host, so it is not part of this deployment.
            It also should not be switched on until A2P 10DLC registration has cleared.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Outcome</th>
              <th>Sentiment</th>
              <th style={{ textAlign: 'right' }}>Length</th>
              <th>Disclosed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className={c.optedOutAt ? 'row-stale' : undefined}>
                <td className="mono">
                  {c.startedAt ? <When iso={c.startedAt.toISOString()} /> : '—'}
                </td>
                <td>
                  {c.companyDomain ? (
                    <a href={`/companies/${encodeURIComponent(c.companyDomain)}`}>
                      {c.contactName ?? c.companyName ?? c.companyDomain}
                    </a>
                  ) : (
                    <span className="muted">unknown number</span>
                  )}
                </td>
                <td>
                  <span className={`tag${OUTCOME_TONE[c.outcome ?? ''] ?? ''}`}>
                    {(c.outcome ?? c.status).replace(/_/g, ' ')}
                  </span>
                  {c.handoffReason ? <span className="pill" style={{ marginLeft: 6 }}>handed off</span> : null}
                </td>
                <td className="muted">{c.sentiment ?? '—'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {c.durationS != null ? `${Math.floor(c.durationS / 60)}m ${c.durationS % 60}s` : '—'}
                </td>
                <td>
                  {c.disclosedAiAt ? (
                    <span className="consent yes">yes</span>
                  ) : c.answeredAt ? (
                    <span className="consent no">NO</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td><a href={`/calls/${c.id}`}>Transcript →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}
