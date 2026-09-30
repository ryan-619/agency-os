import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { tasksAssignableUsers, tasksIsOverdue, tasksList, type AgencyDb, type TaskListRow } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { NewTaskForm, TaskList, type TaskItem } from '@/components/tasks/list'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

/**
 * Every task in the org: mine, all open, overdue, and recently done.
 *
 * A task is a reminder to a person and nothing here sends anything — the
 * kickoff and renewal sets are created from a company page by a click, and
 * a to-do is typed here or there. LinkedIn steps are listed apart, because
 * finishing one is not ticking a box: it is sending a message, which goes
 * through the send rules at the moment it is sent.
 *
 * "Overdue" is decided here, on the server, by the same rule `tasksCounts`
 * uses for the dashboard and the digest, so the three never disagree about
 * how many there are.
 */
export const dynamic = 'force-dynamic'

const VIEWS = ['mine', 'all', 'overdue', 'done'] as const
type View = (typeof VIEWS)[number]
const VIEW_LABEL: Readonly<Record<View, string>> = {
  mine: 'Mine',
  all: 'All open',
  overdue: 'Overdue',
  done: 'Recently done',
}
const OPEN_LIMIT = 500

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  const canWrite = can(principal, 'deals:write')

  const { view: requested } = await searchParams
  const view: View = (VIEWS as readonly string[]).includes(requested ?? '') ? (requested as View) : 'mine'

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [open, done, team, icpRow] = await Promise.all([
    tasksList(db, user.orgId, { open: true, limit: OPEN_LIMIT }),
    view === 'done' ? tasksList(db, user.orgId, { open: false, limit: 100 }) : Promise.resolve([] as TaskListRow[]),
    tasksAssignableUsers(db, user.orgId),
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

  const steps = open.filter((t) => t.kind === 'linkedin_send')
  const work = open.filter((t) => t.kind !== 'linkedin_send')
  const lists: Readonly<Record<View, TaskListRow[]>> = {
    mine: work.filter((t) => t.assigneeUserId === user.id),
    all: work,
    overdue: work.filter((t) => tasksIsOverdue(t, now)),
    done: done.filter((t) => t.kind !== 'linkedin_send'),
  }
  const empty: Readonly<Record<View, string>> = {
    mine: 'Nothing is assigned to you.',
    all: 'No open tasks.',
    overdue: 'Nothing is overdue.',
    done: 'Nothing has been finished yet.',
  }

  const item = (t: TaskListRow): TaskItem => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    kind: t.kind,
    companyDomain: t.companyDomain,
    companyName: t.companyName,
    assigneeUserId: t.assigneeUserId,
    assigneeLabel: t.assigneeName ?? t.assigneeEmail,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
    overdue: tasksIsOverdue(t, now),
  })
  const members = team.map((u) => ({ id: u.id, label: u.name ?? u.email }))

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="tasks" signOut={signOutAction}>
      <h1>Tasks</h1>
      <p className="lede">
        Nothing here sends anything; a task is a reminder to a person. The kickoff and renewal sets are
        created from a company page when somebody presses the button — a deal reaching won creates
        nothing on its own.
      </p>

      <p className="row-actions" style={{ margin: '0 0 14px' }}>
        {VIEWS.map((v) => (
          <a
            key={v}
            href={`/tasks?view=${v}`}
            className={`pill${v === view ? ' pill-b' : ''}`}
            aria-current={v === view ? 'page' : undefined}
            style={{ textDecoration: 'none' }}
          >
            {VIEW_LABEL[v]}
            {v === 'done' ? '' : ` (${lists[v].length})`}
          </a>
        ))}
      </p>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>{VIEW_LABEL[view]}</h2>
        {open.length >= OPEN_LIMIT ? (
          <p className="hint" style={{ marginTop: 0 }}>Showing the first {OPEN_LIMIT} open tasks, soonest due first.</p>
        ) : null}
        <TaskList tasks={lists[view].map(item)} team={members} canWrite={canWrite} empty={empty[view]} />
        {canWrite && view !== 'done' ? <NewTaskForm team={members} currentUserId={user.id} /> : null}
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>LinkedIn steps</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          An approved LinkedIn message is sent by a person, from their own account — nothing here automates
          LinkedIn. These are listed read-only for now: the step&apos;s control lives here from the next revision.
        </p>
        <TaskList
          tasks={steps.map(item)}
          team={members}
          canWrite={false}
          empty="No LinkedIn steps are waiting."
        />
      </section>
    </Shell>
  )
}
