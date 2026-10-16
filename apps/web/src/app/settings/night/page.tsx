import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import {
  heartbeatNight, heartbeatSilentAfter, heartbeatStatus, lookalikeSearches, nightReportLatest, nightSearchesList, nightShiftRead, readLatestHeartbeat,
  type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { NightPanel } from './panel'
import { NIGHT_LEDE, lastNightLine, nightWorkerLine } from './words'

/**
 * Settings → Night shift (0025): whether it runs, when in which zone, the
 * saved searches, and what the last night did. Every member reads it; only
 * an owner changes it. Whether the running worker can do it is read from its
 * heartbeat — an observation, never configuration.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function NightShiftPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!can(principal, 'agents:read')) redirect('/settings')
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [night, searches, report, heartbeat, suggestions] = await Promise.all([
    nightShiftRead(db, user.orgId),
    nightSearchesList(db, user.orgId),
    nightReportLatest(db, user.orgId),
    readLatestHeartbeat(db).catch(() => null),
    lookalikeSearches(db, user.orgId),
  ])
  const worker = nightWorkerLine(heartbeatStatus(heartbeat, now, heartbeatSilentAfter(heartbeat)), heartbeatNight(heartbeat))
  const last = lastNightLine(report ? { ...report, top: report.top.length } : null)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="night" signOut={signOutAction}>
      <h1>Night shift</h1>
      <p className="lede">{NIGHT_LEDE}</p>
      <div className={worker.tone === 'ok' ? 'note' : 'note note-warn'}>{worker.text}</div>
      {last ? <p className="muted" style={{ fontSize: 13.5 }}>{last} <a href="/">The dashboard →</a></p> : null}
      <NightPanel
        enabled={night.enabled}
        runAt={night.runAt}
        timeZone={night.timeZone}
        searches={searches.map((s) => ({
          id: s.id, query: s.query, region: s.region, city: s.city, active: s.active, lastRunAt: s.lastRunAt?.toISOString() ?? null,
        }))}
        suggestions={suggestions}
        canWrite={can(principal, 'agents:write')}
      />
    </Shell>
  )
}
