import { redirect } from 'next/navigation'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { can } from '@agency/core'
import { schema, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { VisitsPlanner, type VisitView } from './planner'

/**
 * Today's visits (2026-10-08): the open visit tasks that are yours or
 * nobody's, put in an order that drives sensibly from where you are, with the
 * Google Maps link that drives it. A visit is a person's act; this page only
 * orders them. A business with no location on record — filed before the map
 * gave one — is listed apart, to find on the map in Chat.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function VisitsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')) redirect('/')
  const db = getDb() as unknown as AgencyDb
  const rows = await db
    .select({
      taskId: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt, companyId: schema.tasks.companyId,
      name: schema.companies.name, domain: schema.companies.domain, address: schema.companies.address, phone: schema.companies.phone,
      lat: schema.companies.latitude, lng: schema.companies.longitude,
    })
    .from(schema.tasks)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.tasks.companyId))
    .where(and(
      eq(schema.tasks.orgId, user.orgId),
      eq(schema.tasks.kind, 'visit'),
      isNull(schema.tasks.doneAt),
      or(eq(schema.tasks.assigneeUserId, user.id), isNull(schema.tasks.assigneeUserId)),
    ))
    .orderBy(sql`${schema.tasks.dueAt} ASC NULLS LAST`, asc(schema.tasks.createdAt))
    .limit(60)
  const located: VisitView[] = rows
    .filter((r) => r.lat !== null && r.lng !== null)
    .map((r) => ({
      id: r.taskId, taskId: r.taskId, label: r.name || r.domain, title: r.title, lat: r.lat!, lng: r.lng!, address: r.address,
      phone: r.phone, domain: r.domain, due: r.dueAt ? r.dueAt.toISOString().slice(0, 10) : null,
    }))
  const unplaced = rows.filter((r) => r.lat === null || r.lng === null)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="visits" signOut={signOutAction}>
      <h1>Visits</h1>
      <p className="lede">
        Your open visit tasks — and anybody&apos;s that nobody has taken — in an order that drives sensibly, with the route
        to open in Google Maps. Where you are is used only in this page, when you ask.
      </p>
      {located.length === 0 ? (
        <p className="muted">No open visit with a location on record. Ask Chat for a visit task for a business it found on the map.</p>
      ) : (
        <VisitsPlanner visits={located} />
      )}
      {unplaced.length > 0 ? (
        <>
          <h2>No location on record</h2>
          <p className="muted" style={{ fontSize: 13 }}>Filed before the map gave a location. Find each on the map in Chat to place it.</p>
          <ul>
            {unplaced.map((r) => (
              <li key={r.taskId}>
                <a href={`/companies/${encodeURIComponent(r.domain)}`}>{r.name || r.domain}</a>
                {r.address ? <span className="muted"> · {r.address}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Shell>
  )
}
