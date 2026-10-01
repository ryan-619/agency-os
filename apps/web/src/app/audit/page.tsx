import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import { eq } from 'drizzle-orm'
import {
  auditResolveActors, auditSubjectsToCompanies, listAudit, schema, type AgencyDb, type AuditRow,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { AuditLog, type AuditLineView } from '@/components/audit/log'
import { Shell } from '@/components/shell'
import {
  ACTOR_LITERALS, AUDIT_FAMILIES, AUDIT_SUBJECT_TYPES, actorLabel, detailForDisplay, isActorLiteral, isAlarm, sentenceFor,
  subjectHref,
} from '@/lib/audit-copy'
import { getDb } from '@/lib/db'
import { deployment } from '@/lib/deployment'

/**
 * The audit log (PROMPT.md §2.4, §4).
 *
 * "Approval decides, the audit log remembers" — and until this page nothing
 * read the memory back. Every route, the worker, the voice service and the
 * booking page write a line to `audit_log`; this is where a person sees them,
 * newest first, a hundred at a time, filtered by what happened, who did it,
 * or what it happened to.
 *
 * Paging is by keyset, not offset: new lines arrive at the top while somebody
 * reads, and an offset page would show a line twice or skip one. The cursor
 * is the last line's id and time, and `listAudit` reads that line's stored
 * microsecond rather than trusting the millisecond in the URL.
 *
 * Every filter arrives from a URL and is checked against the shape it must
 * have before it reaches a query. A value that fails is dropped and the page
 * says so, rather than silently showing the unfiltered log under a heading
 * that claims a filter.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PAGE = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim()

/** User ids a sentence may name: who approved, who decided, who a call went to, who was changed. */
function personIdsIn(row: AuditRow): string[] {
  const out: string[] = []
  if (row.subjectType === 'user' && row.subjectId) out.push(row.subjectId)
  const d = row.detail
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (/(By|UserId)$/.test(k) && typeof v === 'string' && UUID.test(v)) out.push(v)
    }
  }
  return out
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  if (!can(principal, 'audit:read')) {
    return (
      <Shell user={user} current="audit" signOut={signOutAction}>
        <h1>Audit log</h1>
        <div className="note note-warn">Your role cannot read the audit log.</div>
      </Shell>
    )
  }

  // --- the filters, each checked for shape before it reaches a query --------
  const sp = await searchParams
  const ignored: string[] = []
  const rawAction = one(sp['action'])
  const action = /^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{1,60})?$/.test(rawAction) ? rawAction : ''
  if (rawAction && !action) ignored.push('action')
  const rawActor = one(sp['actor'])
  const actor = UUID.test(rawActor) || isActorLiteral(rawActor) ? rawActor : ''
  if (rawActor && !actor) ignored.push('actor')
  const rawSubject = one(sp['subject'])
  const subjectType = /^[a-z_]{1,40}$/.test(rawSubject) ? rawSubject : ''
  if (rawSubject && !subjectType) ignored.push('subject')
  const rawSubjectId = one(sp['subjectId'])
  const subjectId = UUID.test(rawSubjectId) ? rawSubjectId : ''
  if (rawSubjectId && !subjectId) ignored.push('subjectId')
  const beforeId = one(sp['before'])
  const beforeAt = new Date(one(sp['at']))
  const before =
    UUID.test(beforeId) && !Number.isNaN(beforeAt.getTime()) ? { id: beforeId, createdAt: beforeAt } : null

  const [rows, team] = await Promise.all([
    listAudit(db, user.orgId, {
      limit: PAGE + 1,
      before,
      actionPrefix: action || null,
      actor: actor || null,
      subjectType: subjectType || null,
      subjectId: subjectId || null,
    }),
    // The team, for the "who" filter. Revoked people stay in it: they did
    // what they did while they had access, and a filter that hid them would
    // hide exactly the lines somebody offboarding would want to read.
    db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, revokedAt: schema.users.revokedAt })
      .from(schema.users)
      .where(eq(schema.users.orgId, user.orgId))
      .orderBy(schema.users.email),
  ])
  const shown = rows.slice(0, PAGE)
  const more = rows.length > PAGE

  const [companies, people] = await Promise.all([
    auditSubjectsToCompanies(db, user.orgId, shown),
    auditResolveActors(db, user.orgId, [...new Set(shown.flatMap((r) => [r.actor, ...personIdsIn(r)]))]),
  ])
  const personName = (id: string): string | null => {
    const p = people.get(id)
    return p ? p.name || p.email : null
  }

  const lines: AuditLineView[] = shown.map((r) => {
    const company = companies.get(r.id) ?? null
    const who = actorLabel(r.actor, people)
    return {
      id: r.id,
      at: r.createdAt.toISOString(),
      who: who.label,
      whoNote: who.note,
      isPerson: !isActorLiteral(r.actor),
      sentence: sentenceFor(r, { company, person: personName }),
      href: subjectHref(r, company),
      alarm: isAlarm(r),
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      detail: detailForDisplay(r.detail),
    }
  })

  const query = (over: Record<string, string>): string => {
    const q = new URLSearchParams()
    const base: Record<string, string> = { action, actor, subject: subjectType, subjectId, ...over }
    for (const [k, v] of Object.entries(base)) if (v) q.set(k, v)
    const s = q.toString()
    return s ? `/audit?${s}` : '/audit'
  }
  const last = shown[shown.length - 1]
  const olderHref = more && last ? query({ before: last.id, at: last.createdAt.toISOString() }) : null
  const filtered = Boolean(action || actor || subjectType || subjectId)
  const worker = deployment().worker

  return (
    <Shell user={user} current="audit" signOut={signOutAction}>
      <h1>Audit log</h1>
      <p className="lede">
        Everything that writes to this system writes a line here. It is append-only; nothing here can be
        edited or deleted.
      </p>

      <details className="note" style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer' }}>
          <strong>What this log shows, and four things it does not show the way you might expect</strong>
        </summary>
        <ul>
          <li>
            <strong>A deal moved automatically has a line of its own, from System</strong>, beside the{' '}
            <code>send.sent</code>, <code>contact.replied</code>, <code>meeting.booked</code> or{' '}
            <code>proposal.generated</code> line that caused it — so one event is two lines, and filtering to
            Deals shows both the board&apos;s moves and the automatic ones. Three moves have no deal line: a
            stage the agent set with <code>update_deal</code> (its line is filed under the chat), a proposal
            accepted as won (its <code>proposal.accepted</code> line), and any automatic move made before this
            release.
          </li>
          <li>
            <strong>An agent&apos;s approval appears twice.</strong> Once when a person decides it here, and
            once when the waiting turn in the worker receives the decision. Two lines, one decision, from two
            processes.
          </li>
          <li>
            <strong>Scans are not audited on their own.</strong> A scan leaves a line only when the scheduled
            rescan or the agent ran it. <code>npm run scan</code> from a terminal leaves none; the company
            page&apos;s scan history is the record of those.
          </li>
          <li>
            <strong>Suppressions added or removed on the suppressions page before this release are not
            here.</strong> Their audit lines were refused by the database and the failure was swallowed, so
            they were never written. They are now.
          </li>
          {!worker ? (
            <li>
              <strong>No agent worker is configured on this deployment.</strong> Sending, replies and the
              agent&apos;s lines appear only if a worker runs against this database somewhere else.
            </li>
          ) : null}
        </ul>
        <p className="fine" style={{ marginTop: 10 }}>
          The database refuses an edit to any line. A delete is permitted only so that removing a whole
          organisation can cascade; nothing in the app issues one. The raw detail under each line is shown
          through the same redaction the logs use, as a backstop — the writers already keep message bodies,
          recipients and credentials out of it.
        </p>
      </details>

      <form method="get" action="/audit" className="row-card slim" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'flex-end' }}>
          <label style={{ margin: 0 }}>
            What
            <select name="action" defaultValue={action}>
              <option value="">Everything</option>
              {AUDIT_FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
              {action && !AUDIT_FAMILIES.some((f) => f.value === action) ? (
                <option value={action}>{action}</option>
              ) : null}
            </select>
          </label>
          <label style={{ margin: 0 }}>
            Who
            <select name="actor" defaultValue={actor}>
              <option value="">Anyone</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                  {u.revokedAt ? ' (access revoked)' : ''}
                </option>
              ))}
              {Object.entries(ACTOR_LITERALS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {actor && UUID.test(actor) && !team.some((u) => u.id === actor) ? (
                <option value={actor}>a former teammate</option>
              ) : null}
            </select>
          </label>
          <label style={{ margin: 0 }}>
            About
            <select name="subject" defaultValue={subjectType}>
              <option value="">Anything</option>
              {AUDIT_SUBJECT_TYPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              {subjectType && !AUDIT_SUBJECT_TYPES.some((s) => s.value === subjectType) ? (
                <option value={subjectType}>{subjectType}</option>
              ) : null}
            </select>
          </label>
          {subjectId ? <input type="hidden" name="subjectId" value={subjectId} /> : null}
          <div className="row-actions">
            <button type="submit">Filter</button>
            {filtered ? <a href="/audit" style={{ fontSize: 13 }}>Clear</a> : null}
          </div>
        </div>
        {subjectId ? (
          <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
            Only the lines whose subject is <code>{subjectId.slice(0, 8)}</code>. For a deal, that includes the
            moves a send, a reply, a booking or a proposal made; what caused each is a line about that message,
            contact, meeting or proposal.{' '}
            <a href={query({ subjectId: '' })}>Drop this filter</a>
          </p>
        ) : null}
        {ignored.length > 0 ? (
          <div className="err-line">
            Ignored {ignored.join(', ')}: {ignored.length === 1 ? 'it is' : 'they are'} not a shape this log
            can filter on, so the lines below are not filtered by {ignored.length === 1 ? 'it' : 'them'}.
          </div>
        ) : null}
      </form>

      {lines.length === 0 ? (
        <div className="note">
          <strong>{filtered || before ? 'No lines match.' : 'Nothing has been recorded yet.'}</strong>
          {filtered ? (
            <p style={{ margin: '8px 0 0' }}>
              <a href="/audit">Show every line</a>
            </p>
          ) : null}
        </div>
      ) : (
        <AuditLog lines={lines} />
      )}

      <div className="row-actions" style={{ marginTop: 12, gap: 14 }}>
        {before ? <a href={query({})}>← Newest</a> : null}
        {olderHref ? <a href={olderHref}>Older →</a> : lines.length > 0 ? (
          <span className="muted" style={{ fontSize: 12.5 }}>That is the oldest line{filtered ? ' that matches' : ''}.</span>
        ) : null}
      </div>
    </Shell>
  )
}
