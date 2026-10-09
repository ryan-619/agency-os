import { redirect } from 'next/navigation'
import {
  PLAYBOOK_MAX_CHARS, heartbeatBrief, heartbeatSilentAfter, heartbeatStatus, latestBrief, readAssistantSettings,
  readLatestHeartbeat, usersList, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { mayReadAssistant, mayWriteAssistant } from '../../api/settings/assistant/rules'
import { AssistantPanel } from './panel'
import { ASSISTANT_LEDE, briefStatus, briefWorkerLine } from './words'

/**
 * Settings → Assistant (0020): the agency's playbook, which the AI reads with
 * every message, and the morning brief, which the worker writes once a day.
 *
 * Every member reads both; only an owner changes them (`agents:write`, as a
 * subagent's prompt is). The playbook is shown whole, because it is the
 * agency's own words and not a secret. Whether anything will write the brief
 * is read from the newest heartbeat — an observation, never configuration —
 * because the web app has no model and the worker's host is not visible here.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function AssistantPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!mayReadAssistant(principal)) redirect('/settings')

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [settings, members, latest, heartbeat] = await Promise.all([
    readAssistantSettings(db, user.orgId),
    usersList(db, user.orgId),
    latestBrief(db, user.orgId),
    // A missing heartbeat table is a deployment question for /settings/deployment, not a reason to 500 here.
    readLatestHeartbeat(db).catch(() => null),
  ])

  const byId = new Map(members.map((m) => [m.id, m]))
  const named = (id: string | null): string | null => {
    const m = id ? byId.get(id) : undefined
    return m ? (m.name ?? m.email) : null
  }
  const briefPerson = settings.briefUserId ? byId.get(settings.briefUserId) : undefined

  const status = briefStatus({
    enabled: settings.briefEnabled,
    at: settings.briefAt,
    timeZone: settings.briefTimeZone,
    person: named(settings.briefUserId),
    personCannotRun: !briefPerson || briefPerson.revokedAt !== null,
    lastRunOn: settings.briefLastRunOn,
    requested: settings.briefRequestedAt !== null,
  })
  const worker = briefWorkerLine(heartbeatStatus(heartbeat, now, heartbeatSilentAfter(heartbeat)), heartbeatBrief(heartbeat))

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="assistant" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Assistant</h1>
      <p className="lede">{ASSISTANT_LEDE}</p>

      <AssistantPanel
        canWrite={mayWriteAssistant(principal)}
        playbook={settings.playbook}
        playbookMax={PLAYBOOK_MAX_CHARS}
        playbookSavedBy={named(settings.playbookUpdatedBy)}
        playbookSavedAt={settings.playbookUpdatedAt?.toISOString() ?? null}
        brief={{
          enabled: settings.briefEnabled,
          at: settings.briefAt,
          timeZone: settings.briefTimeZone,
          runsAs: named(settings.briefUserId),
        }}
        status={status}
        worker={worker}
        latest={
          latest
            ? {
                // Only its owner can open a thread (`chatReadOwnSession`), so the link is theirs alone.
                href: latest.userId === user.id ? `/chat/${latest.chatSessionId}` : null,
                date: latest.date,
                startedAt: latest.startedAt.toISOString(),
                owner: named(latest.userId),
              }
            : null
        }
      />
    </Shell>
  )
}
