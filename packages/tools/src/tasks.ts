/**
 * The notes and tasks tools (0018's two tables).
 *
 * `add_note` and `create_task` write internal state (`medium`); `list_tasks`
 * is a READ (`low`). A note is a teammate's words and is never evidence —
 * nothing that writes a proposal or a brief may read it. A task is a thing
 * for a person to do; creating one sends nothing to anybody. Every write's
 * summary ends "Nothing was sent."
 *
 * Both writes go through the functions the web routes call — `notesAdd` and
 * `tasksCreate` — so a note the agent adds and a note a person types are the
 * same row, refused for the same reasons in the same sentences.
 *
 * Neither is written as if a person had written it. Any teammate may approve
 * the card (the decide route asks only `approvals:decide`), so the person
 * whose chat it is may never have seen the words.
 *
 *   - A task's `created_by` is NULL and its `task.created` row names the
 *     actor `agent` — what 0018's comment on the column and `tasksCreate`'s
 *     own doc say an agent-created task is. The `agent.create_task` row
 *     carries the turn.
 *   - A note has to name a person: `author_user_id` is NOT NULL, and the
 *     same-org key makes any id but a teammate's unstorable. So it is stored
 *     in the name of the person whose chat this is (`ctx.principal.id`), and
 *     its `note.added` row names the actor `agent` with that person as
 *     `authorUserId`. The note itself carries no mark — `notes` has no column
 *     for one, and this release adds no migration — so the company page and
 *     the timeline show it as theirs; the audit log is where it says
 *     otherwise, and the summary tells the model so.
 *
 * Every address the model hands in is resolved INSIDE this org before
 * anything is written: a contact at the named company, a teammate on this
 * team. An address that resolves to nobody here is `not_found` and nothing
 * is written — including an address that belongs to somebody in another
 * org, which is answered exactly like one that belongs to nobody.
 *
 * §2.3: audit rows carry ids only. A note's body and a task's title are what
 * somebody typed, and neither goes into `ctx.audit`.
 */
import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { can, normaliseEmail } from '@agency/core'
import { findCompanyByDomain, notesAdd, tasksCreate, tasksIsOverdue, tasksList, type AgencyDb } from '@agency/db'
import * as schema from '@agency/db/schema'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

const NOTHING_SENT = 'Nothing was sent.'

/** "2026-09-15 12:00 UTC". */
function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** The company by domain in this org, or the sentence to fail with. */
async function companyFor(
  ctx: ToolContext,
  raw: string,
): Promise<{ ok: true; id: string; domain: string } | { ok: false; message: string }> {
  const domain = normaliseDomain(raw)
  if (!domain) return { ok: false, message: `"${raw}" is not a domain.` }
  const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
  if (!company) return { ok: false, message: `No company with domain "${domain}" is in the CRM.` }
  return { ok: true, id: company.id, domain }
}

/**
 * A teammate by sign-in address, in THIS org. `users.email` is stored
 * normalised (`users_email_is_normalised`), so one equality is exact.
 * `assignable` leaves out a revoked teammate: a new task for somebody who
 * cannot sign in is a task nobody will see. Listing keeps them, because the
 * tasks already assigned to them still exist.
 */
async function teammate(
  db: AgencyDb,
  orgId: string,
  raw: string,
  opts: { readonly assignable: boolean },
): Promise<{ id: string; label: string } | null> {
  const email = normaliseEmail(raw)
  if (!email) return null
  const rows = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.orgId, orgId),
        eq(schema.users.email, email),
        ...(opts.assignable ? [isNull(schema.users.revokedAt)] : []),
      ),
    )
    .limit(1)
  const u = rows[0]
  return u ? { id: u.id, label: u.name?.trim() || u.email } : null
}

// ---------------------------------------------------------------------------
// add_note
// ---------------------------------------------------------------------------

const addNoteShape = {
  domain: z.string().min(1).max(253).describe('The company the note is about.'),
  body: z.string().min(1).max(4000).describe('The note, in the person’s own words.'),
  contactEmail: z.email().optional().describe('A person at the company the note is about, if one.'),
}

export const addNote: AgencyToolSpec<typeof addNoteShape> = {
  name: 'add_note',
  description:
    'Write a note on a company, optionally about one of its contacts, as the person you are helping ' +
    'would. A note is what somebody thinks; it is never evidence, and no proposal or brief reads it. ' +
    'It changes the CRM only — nothing leaves the building and nothing is sent.',
  shape: addNoteShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The notes route's own gate.
    if (!can(ctx.principal, 'companies:write')) {
      return fail('not_permitted', `The person you are helping cannot write notes. ${NOTHING_SENT}`)
    }
    const company = await companyFor(ctx, input.domain)
    if (!company.ok) return fail('not_found', company.message)

    let contactId: string | null = null
    let about = ''
    if (input.contactEmail) {
      const email = normaliseEmail(input.contactEmail)
      const rows = email
        ? await ctx.db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(
              and(
                eq(schema.contacts.orgId, ctx.orgId),
                eq(schema.contacts.companyId, company.id),
                sql`lower(${schema.contacts.email}) = ${email}`,
              ),
            )
            .limit(1)
        : []
      if (!rows[0]) {
        return fail('not_found', `Nobody with the address ${email ?? input.contactEmail} is recorded at ${company.domain}. Nothing was written.`)
      }
      contactId = rows[0].id
      about = ` about ${email}`
    }

    const r = await notesAdd(ctx.db, {
      orgId: ctx.orgId,
      companyId: company.id,
      contactId,
      authorUserId: ctx.principal.id,
      body: input.body,
      actor: 'agent',
    })
    if (!r.ok) return fail(r.reason === 'not_found' ? 'not_found' : 'invalid_state', `${r.message} Nothing was written.`)

    await ctx.audit('agent.add_note', { noteId: r.note.id, companyId: company.id, contactId })
    return ok(
      { noteId: r.note.id, domain: company.domain, contactId },
      `Added a note on ${company.domain}${about}, in the name of the person you are helping: it shows as ` +
        `theirs, and the audit log records that the agent wrote it. A note is not evidence: no proposal or ` +
        `brief reads it. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

const createTaskShape = {
  domain: z.string().optional().describe('The company the task is about, if one.'),
  title: z.string().min(1).max(200).describe('What needs doing, in one line.'),
  detail: z.string().max(2000).optional().describe('Anything the person doing it needs to know.'),
  dueAt: z.iso.datetime().optional().describe('When it is due, as an ISO 8601 instant.'),
  assigneeEmail: z.email().optional().describe('The teammate to assign it to, by their sign-in address.'),
  kind: z
    .enum(['todo', 'call', 'visit'])
    .optional()
    .describe(
      'todo (default); call — a teammate phones the company from their own phone (needs a phone on record, not ' +
        'on the suppression list); visit — a teammate goes there in person.',
    ),
}

export const createTask: AgencyToolSpec<typeof createTaskShape> = {
  name: 'create_task',
  description:
    'Create a task for a teammate — a to-do, a call for them to make from their own phone, or a visit — ' +
    'optionally about a company, with a due date and an assignee. It appears on their task list and nowhere ' +
    'else: no email, no message, no calendar event, and the system places no call. Nothing is sent to anyone ' +
    'inside or outside the company.',
  shape: createTaskShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    // The tasks route's own gate.
    if (!can(ctx.principal, 'deals:write')) {
      return fail('not_permitted', `The person you are helping cannot create tasks. ${NOTHING_SENT}`)
    }

    let company: { id: string; domain: string } | null = null
    if (input.domain !== undefined && input.domain.trim() !== '') {
      const found = await companyFor(ctx, input.domain)
      if (!found.ok) return fail('not_found', `${found.message} Nothing was written.`)
      company = found
    }

    let assignee: { id: string; label: string } | null = null
    if (input.assigneeEmail) {
      assignee = await teammate(ctx.db, ctx.orgId, input.assigneeEmail, { assignable: true })
      if (!assignee) {
        return fail('not_found', `Nobody with the address ${input.assigneeEmail} is on this team. Nothing was written.`)
      }
    }

    const dueAt = input.dueAt ? new Date(input.dueAt) : null
    const kind = input.kind ?? 'todo'
    const r = await tasksCreate(ctx.db, {
      orgId: ctx.orgId,
      kind,
      title: input.title,
      detail: input.detail ?? null,
      companyId: company?.id ?? null,
      assigneeUserId: assignee?.id ?? null,
      dueAt,
      // The agent has no users row; the audit row's actor says who created it.
      createdBy: null,
      actor: 'agent',
    })
    if (!r.ok) {
      const code = r.reason === 'not_found' || r.reason === 'assignee_not_in_org' ? 'not_found' : 'invalid_state'
      return fail(code, `${r.message} Nothing was written.`)
    }

    // Ids only; the kind is on the task's own `task.created` row.
    await ctx.audit('agent.create_task', {
      taskId: r.task.id, companyId: r.task.companyId, assigneeUserId: r.task.assigneeUserId,
    })
    const parts = [
      company ? ` about ${company.domain}` : '',
      assignee ? `, assigned to ${assignee.label}` : ', unassigned',
      dueAt ? `, due ${when(dueAt)}` : '',
    ].join('')
    return ok(
      {
        taskId: r.task.id,
        title: r.task.title,
        domain: company?.domain ?? null,
        assigneeUserId: r.task.assigneeUserId,
        dueAt: r.task.dueAt?.toISOString() ?? null,
      },
      `Created ${kind === 'call' ? 'a call task' : kind === 'visit' ? 'a visit task' : 'task'} ${r.task.id}, “${r.task.title}”${parts}. ` +
        `It is on the task list and nowhere else — no email, message or calendar event` +
        `${kind === 'call' ? ', and the system places no call: a teammate calls from their own phone, after the checks the task lists' : ''}. ${NOTHING_SENT}`,
    )
  },
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

const listTasksShape = {
  open: z.boolean().optional().describe('Only tasks not yet done. Default true.'),
  assigneeEmail: z.email().optional().describe('Only one teammate’s tasks.'),
  domain: z.string().optional().describe('Only tasks about one company.'),
  limit: z.number().int().min(1).max(100).optional().describe('How many, soonest due first. Default 50.'),
}

export const listTasks: AgencyToolSpec<typeof listTasksShape> = {
  name: 'list_tasks',
  description:
    'Read the task list: open tasks by default, soonest due first, with their company, assignee and ' +
    'due date — optionally one teammate’s or one company’s, or including done ones. A read; it ' +
    'changes nothing and sends nothing.',
  shape: listTasksShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:read')) {
      return fail('not_permitted', 'The person you are helping cannot read the task list.')
    }

    let companyId: string | undefined
    let domain: string | null = null
    if (input.domain !== undefined && input.domain.trim() !== '') {
      const found = await companyFor(ctx, input.domain)
      if (!found.ok) return fail('not_found', found.message)
      companyId = found.id
      domain = found.domain
    }

    let assignee: { id: string; label: string } | null = null
    if (input.assigneeEmail) {
      // Revoked teammates included: their tasks are still on the list.
      assignee = await teammate(ctx.db, ctx.orgId, input.assigneeEmail, { assignable: false })
      if (!assignee) return fail('not_found', `Nobody with the address ${input.assigneeEmail} is on this team.`)
    }

    // `open: false` is "including done ones", as the description says — not
    // "only done ones", which nobody asks for by leaving the default off.
    const openOnly = input.open ?? true
    const rows = await tasksList(ctx.db, ctx.orgId, {
      ...(openOnly ? { open: true } : {}),
      ...(assignee ? { assigneeUserId: assignee.id } : {}),
      ...(companyId ? { companyId } : {}),
      limit: input.limit ?? 50,
    })

    await ctx.audit('agent.list_tasks', {
      open: openOnly, assigneeUserId: assignee?.id ?? null, companyId: companyId ?? null, returned: rows.length,
    })
    const now = ctx.now()
    const scope = [
      openOnly ? 'open tasks' : 'tasks, open and done',
      assignee ? ` assigned to ${assignee.label}` : '',
      domain ? ` about ${domain}` : '',
    ].join('')
    const lines = rows.map((t) => {
      // A done call or visit says what came of it (0027), in its stored word.
      const state = t.doneAt ? `done ${when(t.doneAt)}${t.outcome ? `, ${t.outcome.replace(/_/g, ' ')}` : ''}` : tasksIsOverdue(t, now) ? 'OVERDUE' : 'open'
      const due = t.dueAt ? `due ${when(t.dueAt)}` : 'no due date'
      const who = t.assigneeUserId ? t.assigneeName?.trim() || t.assigneeEmail || 'a former teammate' : 'unassigned'
      const about = t.companyDomain ? ` — ${t.companyDomain}` : ''
      // The id is printed because only this summary reaches the model, and
      // complete_task names a task by it.
      return `[${state}] ${due} — “${t.title.replace(/\s+/g, ' ').trim()}”${about} — ${who} · task ${t.id}`
    })
    return ok(
      rows.map((t) => ({
        taskId: t.id,
        kind: t.kind,
        title: t.title,
        domain: t.companyDomain,
        assignee: t.assigneeUserId ? { id: t.assigneeUserId, name: t.assigneeName, email: t.assigneeEmail } : null,
        dueAt: t.dueAt?.toISOString() ?? null,
        overdue: tasksIsOverdue(t, now),
        doneAt: t.doneAt?.toISOString() ?? null,
        outcome: t.outcome ?? null,
      })),
      rows.length === 0 ? `No ${scope}.` : `${rows.length} ${scope}, soonest due first:\n${bounded(lines)}`,
    )
  },
}
