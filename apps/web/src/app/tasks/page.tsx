import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import {
  linkedinStepsDue, tasksAssignableUsers, tasksIsOverdue, tasksList,
  type AgencyDb, type LinkedinStep, type TaskListRow,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { LinkedinSteps, type LinkedinStepItem } from '@/components/tasks/linkedin-steps'
import { NewTaskForm, TaskList, type TaskItem } from '@/components/tasks/list'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'
import { refusalWords } from '@/lib/refusal-words'

/**
 * Every task in the org: mine, all open, overdue, and recently done.
 *
 * A task is a reminder to a person — the kickoff and renewal sets are
 * created from a company page by a click, and a to-do is typed here or
 * there. LinkedIn steps are listed apart, because finishing one is not
 * ticking a box: the person IS the LinkedIn provider, and Start runs the
 * message through the one send path before they are shown a word of it.
 * Reading this page is also what gives each approved LinkedIn message its
 * step, so it works with no worker running.
 *
 * "Overdue" is decided here, on the server, by the same rule `tasksCounts`
 * uses for the dashboard and the digest, so the three never disagree about
 * how many there are.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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
  const canSend = can(principal, 'approvals:decide')

  const { view: requested } = await searchParams
  const view: View = (VIEWS as readonly string[]).includes(requested ?? '') ? (requested as View) : 'mine'

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  // The steps first: reading them materialises their tasks, and the counts
  // below should not be one read behind them.
  const steps = await linkedinStepsDue(db, user.orgId, now)
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
        A task is a reminder to a person. The kickoff and renewal sets are created from a company page when
        somebody presses the button — a deal reaching won creates nothing on its own. The one thing here that
        sends is a LinkedIn step, below, and it goes through the same rules as every email.
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
          The LinkedIn provider is you. Press Start: every rule is checked at that moment, exactly as the worker
          does for email, and the message is shown only if they all pass. Copy it, send it from your own
          account, then press I sent it. Nothing here automates LinkedIn.
        </p>
        <LinkedinSteps steps={steps.map(stepItem)} canAct={canSend} />
      </section>
    </Shell>
  )
}

/** "08:00" from Postgres's "08:00:00". */
function clock(t: string): string {
  return t.slice(0, 5)
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/**
 * The send path's dry run, in words, for the line above Start. A clock
 * refusal leaves Start enabled — by the time it is pressed the clock may have
 * moved, and a deferral hands nothing over. Anything else disables it.
 */
function checkOf(step: LinkedinStep): LinkedinStepItem['check'] {
  const p = step.preview
  if (!p) {
    return { kind: 'blocked', text: 'This message has no recipient or no campaign, so the rules cannot be checked — Start would refuse it.' }
  }
  if (!p.ok) return { kind: 'blocked', text: p.message }
  const d = p.decision
  if (d.allowed) return { kind: 'clear', text: 'Every rule passes right now.' }
  switch (d.code) {
    case 'suppressed':
      return { kind: 'blocked', text: 'On the suppression list — do not send.' }
    case 'quiet_hours':
      return {
        kind: 'clock',
        text: `Inside their quiet hours — after ${clock(p.facts.quietEnd)} their time (${p.facts.recipientTimeZone ?? 'their zone'}).`,
      }
    case 'daily_cap':
      return { kind: 'clock', text: `This campaign has used today's cap of ${p.facts.dailyCap} — Start would wait for tomorrow.` }
    case 'campaign_inactive':
      return { kind: 'clock', text: `The campaign is ${p.facts.campaignStatus} — Start would wait until it is active.` }
    default:
      return { kind: 'blocked', text: `${capitalise(refusalWords(d.code))} — Start would refuse it.` }
  }
}

/** Why a stopped step stopped, in a person's words. */
function stoppedBecause(step: LinkedinStep): string {
  if (step.status === 'refused' && step.refusalCode) {
    return step.refusalCode === 'suppressed'
      ? 'Refused: on the suppression list — do not send. Nothing was sent.'
      : `Refused: ${refusalWords(step.refusalCode)}. Nothing was sent.`
  }
  if (step.status === 'failed') return step.error ?? 'This message failed.'
  if (step.status === 'awaiting_approval') {
    return 'Waiting for approval in Approvals. It comes back here as a step once somebody approves it.'
  }
  return `This message is ${step.status}, so there is nothing to send.`
}

function stepItem(step: LinkedinStep): LinkedinStepItem {
  // A handed step's rules, re-asked when `linkedinStepsDue` read the list —
  // the person sends when they get to it, not when Start was pressed.
  const again = step.recheck?.ok ? step.recheck : null
  const recheck = (): LinkedinStepItem['recheck'] => {
    if (step.state !== 'handed' || step.withheld !== null || !again) return null
    const d = again.decision
    // The cap already counts this message: it was sent when it was handed.
    if (d.allowed || d.code === 'daily_cap') {
      return { kind: 'clear', text: 'Checked again just now: nothing about this person has changed that stops it.' }
    }
    switch (d.code) {
      case 'quiet_hours':
        return {
          kind: 'hold',
          text: `Checked again just now: it is inside their quiet hours — send it after ${clock(again.facts.quietEnd)} their time (${again.facts.recipientTimeZone ?? 'their zone'}).`,
        }
      case 'campaign_inactive':
        return {
          kind: 'hold',
          text: `Checked again just now: the campaign is ${again.facts.campaignStatus}. Pausing a campaign is how the team stops its messages — check before sending.`,
        }
      default:
        return { kind: 'hold', text: `Checked again just now: ${refusalWords(d.code)} — sort that out before sending.` }
    }
  }
  const withheld = (): string | null => {
    switch (step.withheld) {
      case null:
        return null
      case 'expired':
        return 'Handed over more than a day ago; the rules were checked then, not now, so the words are no longer shown.'
      case 'paused':
        return 'This person is paused now — a reply, an unsubscribe or a teammate stopped their messages after the hand-over — so the words are no longer shown.'
      case 'unchecked':
        return 'The contact or the campaign is no longer in the CRM, so the rules cannot be checked again, and the words are no longer shown.'
      case 'refused': {
        const d = again?.decision
        const why = d && !d.allowed
          ? d.code === 'suppressed' ? 'they are on the suppression list and asked to be left alone' : refusalWords(d.code)
          : 'a rule nobody may approve past'
        return `The send rules now refuse this message — ${why} — so the words are no longer shown.`
      }
    }
  }
  return {
    touchId: step.touchId,
    state: step.state,
    contactName: step.contactName,
    companyDomain: step.companyDomain,
    companyName: step.companyName,
    campaignName: step.campaignName,
    profileUrl: step.profileUrl,
    scheduledFor: step.scheduledFor ? step.scheduledFor.toISOString() : null,
    deferred: step.deferred,
    check: step.state === 'ready' ? checkOf(step) : null,
    words: step.words ? { subject: step.words.subject, body: step.words.body } : null,
    handedTo: step.handedTo ? (step.handedTo.label ?? 'a former teammate') : null,
    handedAt: step.handedAt ? step.handedAt.toISOString() : null,
    recheck: recheck(),
    withheld: withheld(),
    stoppedBecause: step.state === 'stopped' ? stoppedBecause(step) : null,
  }
}
