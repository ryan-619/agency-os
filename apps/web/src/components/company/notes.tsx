import { and, eq } from 'drizzle-orm'
import { can, ROLES, type Role } from '@agency/core'
import {
  listContactsForCompany, notesAuthorLabel, notesFor, schema, tasksAssignableUsers, tasksIsOverdue, tasksList,
  tasksTemplateReadiness, type AgencyDb,
} from '@agency/db/queries'
import { NewTaskForm, TaskList, TemplateButtons, type TemplateState } from '@/components/tasks/list'
import { NotesPanel } from '@/components/tasks/notes-panel'
import { getDb } from '@/lib/db'
import type { CompanySlotProps } from './slot'

/**
 * Notes on a company and the open tasks that hang off it, mounted after the
 * contacts panel and before the conversation.
 *
 * The two are kept in separate cards on purpose. A note is a teammate's
 * words and is never evidence (§2.2) — it sits beside the findings, is
 * headed with who wrote it, and nothing that writes a proposal or a brief
 * reads it. A task is a reminder to a person. Neither sends anything.
 *
 * `canWrite` from the page is `companies:write`, which is what notes need.
 * Tasks are `deals:write`, re-derived here from the signed-in person's own
 * row rather than borrowed from the page's answer to a different question.
 */
export async function NotesSlot(props: CompanySlotProps): Promise<React.ReactNode> {
  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [notes, tasks, readiness, team, contacts, meRows] = await Promise.all([
    notesFor(db, props.orgId, props.companyId),
    tasksList(db, props.orgId, { companyId: props.companyId, open: true, limit: 100 }),
    tasksTemplateReadiness(db, props.orgId, props.companyId),
    tasksAssignableUsers(db, props.orgId),
    listContactsForCompany(db, props.orgId, props.companyId),
    db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.id, props.userId), eq(schema.users.orgId, props.orgId)))
      .limit(1),
  ])
  const role = meRows[0] && (ROLES as readonly string[]).includes(meRows[0].role) ? (meRows[0].role as Role) : null
  const principal = role ? { id: props.userId, orgId: props.orgId, role } : null
  const canWriteTasks = can(principal, 'deals:write')

  const templateState = (template: 'kickoff' | 'renewal', open: number): TemplateState => ({
    blockedBecause: !readiness.wonDealId
      ? 'For a won deal — this company has none yet.'
      : open > 0
        ? `${open} ${template} task${open === 1 ? ' is' : 's are'} still open.`
        : null,
  })

  return (
    <>
      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>Notes</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          A note is a teammate&apos;s words. It is never quoted as evidence and never reaches a proposal or a brief.
        </p>
        <NotesPanel
          companyId={props.companyId}
          notes={notes.map((n) => ({
            id: n.id,
            body: n.body,
            pinned: n.pinned,
            authorUserId: n.authorUserId,
            authorLabel: notesAuthorLabel(n),
            contactName: n.contactName,
            createdAt: n.createdAt.toISOString(),
          }))}
          contacts={contacts.map((c) => ({
            id: c.id,
            name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed',
          }))}
          currentUserId={props.userId}
          isOwner={role === 'owner'}
          canWrite={props.canWrite}
        />
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>Tasks</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Nothing here sends anything; a task is a reminder to a person. <a href="/tasks">All tasks →</a>
        </p>
        <TaskList
          tasks={tasks.map((t) => ({
            id: t.id,
            title: t.title,
            detail: t.detail,
            kind: t.kind,
            companyDomain: t.companyDomain,
            companyName: t.companyName,
            assigneeUserId: t.assigneeUserId,
            assigneeLabel: t.assigneeName ?? t.assigneeEmail,
            dueAt: t.dueAt ? t.dueAt.toISOString() : null,
            doneAt: null,
            overdue: tasksIsOverdue(t, now),
          }))}
          team={team.map((u) => ({ id: u.id, label: u.name ?? u.email }))}
          canWrite={canWriteTasks}
          showCompany={false}
          empty="No open tasks for this company."
        />
        {canWriteTasks ? (
          <>
            <NewTaskForm
              team={team.map((u) => ({ id: u.id, label: u.name ?? u.email }))}
              currentUserId={props.userId}
              companyId={props.companyId}
            />
            <TemplateButtons
              companyId={props.companyId}
              dealId={readiness.wonDealId}
              kickoff={templateState('kickoff', readiness.openKickoff)}
              renewal={templateState('renewal', readiness.openRenewal)}
            />
          </>
        ) : null}
      </section>
    </>
  )
}
