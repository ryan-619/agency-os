import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { type TranscriptEntry } from '@agency/core'
import { readCall, schema, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One call (PROMPT.md §8.5).
 *
 * The transcript verbatim, and above it the three facts somebody would be
 * asked to produce: that the AI disclosed itself, whether the caller opted
 * out, and who it was handed to. The summary is the deterministic,
 * extractive one from `packages/core` — it quotes the caller rather than
 * characterising them, so two people reading this read the same thing.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const db = getDb() as unknown as AgencyDb
  const call = await readCall(db, user.orgId, id)
  if (!call) notFound()

  const [company] = call.companyId
    ? await db
        .select({ domain: schema.companies.domain, name: schema.companies.name })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, call.companyId)))
        .limit(1)
    : []

  const transcript = (call.transcript ?? []) as TranscriptEntry[]
  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="calls" signOut={signOutAction}>
      <p className="crumb"><a href="/calls">← Calls</a></p>
      <h1>
        {company ? (company.name ?? company.domain) : 'Call from an unknown number'}
      </h1>
      <p className="lede">
        {call.startedAt ? <When iso={call.startedAt.toISOString()} /> : 'never started'}
        {' · '}<span className="mono">{call.direction === 'in' ? 'inbound' : 'outbound'}</span>
        {' · '}<span className={`tag${call.outcome === 'qualified' ? ' on' : call.outcome === 'opted_out' ? ' warn' : ''}`}>
          {(call.outcome ?? call.status).replace(/_/g, ' ')}
        </span>
        {call.durationS != null ? <> · {Math.floor(call.durationS / 60)}m {call.durationS % 60}s</> : null}
      </p>

      {!call.disclosedAiAt && call.answeredAt ? (
        <div className="note note-warn">
          <strong>This call has no AI disclosure recorded.</strong> §2.1 requires the AI to say it is an AI
          in the first utterance. Either it did not, or the record was not written — both need explaining.
        </div>
      ) : null}

      {call.optedOutAt ? (
        <div className="note note-warn">
          <strong>The caller asked to be left alone.</strong> Their number went on the suppression list at{' '}
          <When iso={call.optedOutAt.toISOString()} />, and nothing may contact it again on any channel.
        </div>
      ) : null}

      <div className="brief">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>What happened</h2>
          <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{call.summary ?? 'No summary was written.'}</p>
          <table>
            <tbody>
              <tr><th>AI disclosed</th><td className="mono">{call.disclosedAiAt ? <When iso={call.disclosedAiAt.toISOString()} /> : 'NOT RECORDED'}</td></tr>
              <tr><th>Sentiment</th><td className="mono">{call.sentiment ?? '—'}</td></tr>
              <tr><th>Handed off</th><td>{call.handoffReason ?? <span className="muted">no</span>}</td></tr>
              <tr><th>Recording</th><td className="muted">{call.recordingUrl ? 'stored with the provider' : 'none'}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Transcript</h2>
          {transcript.length === 0 ? (
            <p className="muted">Nothing was transcribed.</p>
          ) : (
            <div className="thread">
              {transcript.map((line, i) => (
                <div key={i} className={`touch touch-${line.role === 'caller' ? 'in' : 'out'}`}>
                  <div className="touch-head">
                    <span className="pill">{line.role}</span>
                    <span className="muted" style={{ fontSize: 12 }}><When iso={line.at} mode="time" /></span>
                  </div>
                  <div style={{ fontSize: 13 }}>{line.text}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Shell>
  )
}
