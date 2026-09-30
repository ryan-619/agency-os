import { notFound, redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { briefForMeeting, meetingRescheduleLinks, type AgencyDb, type MeetingLink } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { MeetingActions } from '@/components/pipeline/meeting-actions'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { inZone } from '@/lib/format'
import { icpForOrg } from '@/lib/queries'

/**
 * The brief for one meeting (PROMPT.md §8.6, §7).
 *
 * Generated on the way in, from the rows as they are now: a brief read
 * two minutes before the call should reflect the reply that arrived an hour
 * ago. Findings that have aged out are not quoted — the caveat says so and
 * says what to do (§2.2).
 *
 * It is also where a meeting's outcome is recorded — held, no-show,
 * rescheduled — and where it is called off, and where the `.ics` download
 * lives. That file is for the reader's OWN calendar: nobody is invited by
 * it, and the page says so beside the link, because "calendar file" reads
 * as "invitation" to anyone who has not been told otherwise.
 */
export const dynamic = 'force-dynamic'

/** Beside the download link, verbatim. */
const ICS_NOTE = 'Adds this meeting to your own calendar. Nobody is invited by this file — send the invitation from your calendar.'

/** A meeting at the other end of a reschedule, in ITS zone. */
function MeetingAt({ link }: { link: MeetingLink }) {
  return <a href={`/meetings/${link.id}`}>{inZone(link.startsAt, link.timeZone)}</a>
}

export default async function MeetingBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()

  const db = getDb() as unknown as AgencyDb
  const [result, icpRow, links] = await Promise.all([
    briefForMeeting(db, user.orgId, id),
    icpForOrg(user.orgId),
    meetingRescheduleLinks(db, user.orgId, id),
  ])
  if (!result) notFound()
  const { meeting, company, brief } = result
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  // Rendered per request (force-dynamic), so "now" is the reader's now; the
  // route re-checks it in the same UPDATE that writes the outcome.
  const started = meeting.startsAt.getTime() <= Date.now()

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
    <Shell user={user} orgName={orgLabel} current="pipeline" signOut={signOutAction}>
      <p className="crumb"><a href="/pipeline">← Pipeline</a></p>
      <h1>{brief.headline}</h1>
      <p className="lede">
        <span className="mono">{inZone(meeting.startsAt, meeting.timeZone)}</span>
        {' · '}
        <a href={`/companies/${encodeURIComponent(company.domain)}`}>{company.name ?? company.domain}</a>
        {meeting.cancelledAt ? <> · <span className="tag warn">cancelled</span></> : null}
        {meeting.outcome === 'held' ? <> · <span className="tag on">held</span></> : null}
        {meeting.outcome === 'no_show' ? <> · <span className="tag warn">no-show</span></> : null}
        {meeting.outcome === 'rescheduled' ? (
          <> · <span className="tag">rescheduled{links.to ? <> → <MeetingAt link={links.to} /></> : null}</span></>
        ) : null}
        {links.from ? <> · <span className="muted">rescheduled from <MeetingAt link={links.from} /></span></> : null}
        {' · '}<span className="mono muted">{meeting.source.replace(/_/g, ' ')}</span>
        {can(principal, 'deals:read') ? (
          <>
            {' · '}<a href={`/api/meetings/${meeting.id}/ics`} download title={ICS_NOTE}>Download .ics</a>
            <span className="hint">{ICS_NOTE}</span>
          </>
        ) : null}
      </p>

      <MeetingActions
        id={meeting.id}
        timeZone={meeting.timeZone}
        started={started}
        cancelled={meeting.cancelledAt !== null}
        outcome={meeting.outcome}
        canWrite={can(principal, 'deals:write')}
      />

      {brief.posture.caveat ? (
        <div className="note note-warn"><strong>Before you quote anything:</strong> {brief.posture.caveat}</div>
      ) : null}

      <div className="brief">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Who</h2>
          {brief.who.length === 0 ? <p className="muted">No contacts recorded for this company.</p> : (
            <ul>{brief.who.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
          <h2>Where the deal is</h2>
          <p>{brief.deal}</p>
          {meeting.notes ? (<><h2>Notes from booking</h2><p style={{ whiteSpace: 'pre-wrap' }}>{meeting.notes}</p></>) : null}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Posture, from the outside</h2>
          <p className="muted" style={{ fontSize: 13 }}>{brief.posture.summary}</p>
          {brief.posture.gaps.length > 0 ? (
            <table>
              <thead><tr><th>Gap</th><th>Why it matters</th><th>Observed</th></tr></thead>
              <tbody>
                {brief.posture.gaps.map((g) => (
                  <tr key={g.signalKey}>
                    <td className="mono">{g.signalKey}</td>
                    <td>{g.why}</td>
                    <td className="muted">{g.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {brief.posture.strengths.length > 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>
              Observed and not a gap: <span className="mono">{brief.posture.strengths.join(' · ')}</span>
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>What has been said</h2>
          {brief.conversation.length === 0 ? <p className="muted">Nothing yet.</p> : (
            <ul className="brief-lines">{brief.conversation.map((line, i) => <li key={i}>{line}</li>)}</ul>
          )}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Agenda</h2>
          <ol>{brief.agenda.map((a) => <li key={a}>{a}</li>)}</ol>
          <h2>Questions worth asking</h2>
          <ul>{brief.questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </section>
      </div>
    </Shell>
  )
}
