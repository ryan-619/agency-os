/**
 * Tasks with owners and due dates (0018), and the kickoff and renewal
 * templates applied by a click.
 *
 * A task is a reminder to a person. Nothing in this module sends anything,
 * schedules anything or moves a deal: the one send path stays the one send
 * path (§8.4), and a task that says "send the authorisation letter" is a
 * person's job to do from their own mailbox.
 *
 * Four kinds: a plain `todo`; a `linkedin_send`, which names the approved
 * touch a person is asked to send by hand (one OPEN task per touch, by unique
 * index — two callers materialising one step produce one task and the loser
 * re-reads through `tasksOpenForTouch`); and the `kickoff` and `renewal` sets
 * the templates in `@agency/core` produce. Templates are applied ONLY when
 * somebody presses the button, never by a stage change — a board that fills
 * itself with work nobody asked for is a board people stop reading.
 *
 * Every write is scoped by org in its own predicate, and every id that
 * crosses in (company, deal, touch, assignee) is checked against THIS org
 * before anything is written. 0018 makes the assignee, creator and completer
 * same-org by composite key; the company, deal and touch keys are plain, so
 * the checks here are what keep one agency's task off another's company.
 *
 * Audit rows carry ids only (§2.3). A title can quote a person.
 */
import { and, asc, desc, eq, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { TASK_TEMPLATES, tasksFromTemplate, type TaskTemplateName } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from './pg-errors.js'

export type TaskRow = typeof schema.tasks.$inferSelect

export type TaskKind = 'todo' | 'linkedin_send' | 'kickoff' | 'renewal'
export const TASK_KINDS: readonly TaskKind[] = Object.freeze(['todo', 'linkedin_send', 'kickoff', 'renewal'] as const)

/** 0018's `tasks_title_is_bounded`, counted in characters as Postgres counts them. */
export const TASK_TITLE_MAX = 200
/** Not a column CHECK; a bound so a pasted email thread does not become a task. */
export const TASK_DETAIL_MAX = 2000

const DAY_MS = 86_400_000

/** A task with the names a list needs. */
export interface TaskListRow extends TaskRow {
  readonly companyDomain: string | null
  readonly companyName: string | null
  readonly assigneeName: string | null
  readonly assigneeEmail: string | null
}

export type TasksCreateResult =
  | { ok: true; task: TaskRow }
  | {
      ok: false
      reason: 'blank_title' | 'title_too_long' | 'invalid' | 'duplicate_open_for_touch' | 'assignee_not_in_org' | 'not_found'
      message: string
    }

type Fail<R extends string> = { ok: false; reason: R; message: string }

function charCount(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

const NOT_ON_TEAM = 'That person is not on this team.'

/**
 * Is this user someone a task may be assigned to: in THIS org, and not
 * revoked. A revoked teammate keeps every row that already names them
 * (0018), but a new task handed to somebody who cannot sign in is a task
 * nobody will see.
 */
async function assignable(db: AgencyDb, orgId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.id, userId), isNull(schema.users.revokedAt)))
    .limit(1)
  return rows.length > 0
}

/**
 * The people a task may be assigned to, for a picker. Read here rather than
 * from the team module so the task screens depend on nothing but tasks.
 */
export async function tasksAssignableUsers(
  db: AgencyDb,
  orgId: string,
): Promise<{ id: string; name: string | null; email: string }[]> {
  return db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), isNull(schema.users.revokedAt)))
    .orderBy(asc(schema.users.email))
}

/**
 * Create one task.
 *
 * A deal or a touch names its company, so a task given either without a
 * company is filed under that company; given both, they must agree. A
 * second OPEN task for one touch is refused by `tasks_one_open_per_touch`
 * and answered `duplicate_open_for_touch` — the caller re-reads with
 * `tasksOpenForTouch` rather than treating it as a failure.
 *
 * `createdBy` is null when the agent creates the task (it has no users row);
 * `actor` is what the audit row names either way.
 */
export async function tasksCreate(
  db: AgencyDb,
  input: {
    readonly orgId: string
    readonly kind: TaskKind
    readonly title: string
    readonly detail?: string | null
    readonly companyId?: string | null
    readonly dealId?: string | null
    readonly touchId?: string | null
    readonly assigneeUserId?: string | null
    readonly dueAt?: Date | null
    readonly createdBy: string | null
    /** A users.id, or 'agent' / 'system'. */
    readonly actor: string
  },
): Promise<TasksCreateResult> {
  const title = input.title.trim()
  if (title === '') return { ok: false, reason: 'blank_title', message: 'A task needs a title.' }
  if (charCount(title) > TASK_TITLE_MAX) {
    return { ok: false, reason: 'title_too_long', message: `A task title is at most ${TASK_TITLE_MAX} characters. Put the rest in the detail.` }
  }
  if (!(TASK_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: 'invalid', message: `A task's kind is one of ${TASK_KINDS.join(', ')}.` }
  }
  if (input.kind === 'linkedin_send' && !input.touchId) {
    return { ok: false, reason: 'invalid', message: 'A LinkedIn step has to name the message it is for.' }
  }
  if (input.dueAt && Number.isNaN(input.dueAt.getTime())) {
    return { ok: false, reason: 'invalid', message: 'The due date could not be read.' }
  }
  const detail = input.detail?.trim().slice(0, TASK_DETAIL_MAX) || null

  let companyId = input.companyId ?? null
  const notFound = (message: string): Fail<'not_found'> => ({ ok: false, reason: 'not_found', message })
  const disagree = (what: string): Fail<'invalid'> => ({
    ok: false, reason: 'invalid', message: `That ${what} is with a different company from the one this task is for.`,
  })

  if (companyId) {
    const company = await db
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, input.orgId), eq(schema.companies.id, companyId)))
      .limit(1)
    if (company.length === 0) return notFound('That company is not in the CRM.')
  }
  if (input.dealId) {
    const deal = await db
      .select({ companyId: schema.deals.companyId })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, input.orgId), eq(schema.deals.id, input.dealId)))
      .limit(1)
    if (deal.length === 0) return notFound('That deal is not in the CRM.')
    if (companyId && deal[0]!.companyId !== companyId) return disagree('deal')
    companyId = deal[0]!.companyId
  }
  if (input.touchId) {
    const touch = await db
      .select({ companyId: schema.touches.companyId })
      .from(schema.touches)
      .where(and(eq(schema.touches.orgId, input.orgId), eq(schema.touches.id, input.touchId)))
      .limit(1)
    if (touch.length === 0) return notFound('That message is not in the CRM.')
    const touchCompany = touch[0]!.companyId
    if (companyId && touchCompany && touchCompany !== companyId) return disagree('message')
    companyId = companyId ?? touchCompany
  }
  if (input.assigneeUserId && !(await assignable(db, input.orgId, input.assigneeUserId))) {
    return { ok: false, reason: 'assignee_not_in_org', message: NOT_ON_TEAM }
  }

  let task: TaskRow | undefined
  try {
    const rows = await db
      .insert(schema.tasks)
      .values({
        orgId: input.orgId,
        kind: input.kind,
        title,
        detail,
        companyId,
        dealId: input.dealId ?? null,
        touchId: input.touchId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        createdBy: input.createdBy,
        dueAt: input.dueAt ?? null,
      })
      .returning()
    task = rows[0]
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'duplicate_open_for_touch', message: 'There is already an open task for that message.' }
    }
    if (isCheckViolation(err, 'tasks_title_is_not_blank')) return { ok: false, reason: 'blank_title', message: 'A task needs a title.' }
    if (isCheckViolation(err, 'tasks_title_is_bounded')) {
      return { ok: false, reason: 'title_too_long', message: `A task title is at most ${TASK_TITLE_MAX} characters.` }
    }
    if (isCheckViolation(err)) return { ok: false, reason: 'invalid', message: 'That task does not fit the rules a task has to follow.' }
    // The same-org keys on assignee and creator: the pre-check covers the
    // assignee, so this is the creator (or a user removed mid-request).
    if (isForeignKeyViolation(err)) return notFound('Something this task names is not on this team or in the CRM.')
    throw err
  }
  if (!task) throw new Error('task insert returned no row')

  await appendAudit(db, {
    orgId: input.orgId,
    actor: input.actor,
    action: 'task.created',
    subjectType: 'task',
    subjectId: task.id,
    detail: { taskId: task.id, kind: task.kind, companyId: task.companyId },
  })
  return { ok: true, task }
}

/**
 * Tasks in an org, with the company and the assignee named.
 *
 * `open` true is not-done, false is done, absent is both. `assigneeUserId`
 * null means UNASSIGNED — a different question from "anybody", which is
 * leaving it out. `dueBefore` excludes tasks with no due date: a task with
 * none is not overdue, however long it has been open.
 *
 * Open tasks come first, soonest due first with undated ones after, then
 * newest.
 */
export async function tasksList(
  db: AgencyDb,
  orgId: string,
  filter: {
    readonly open?: boolean
    readonly assigneeUserId?: string | null
    readonly companyId?: string
    readonly kind?: TaskKind
    readonly dueBefore?: Date
    readonly limit?: number
  } = {},
): Promise<TaskListRow[]> {
  const where: SQL[] = [eq(schema.tasks.orgId, orgId)]
  if (filter.open === true) where.push(isNull(schema.tasks.doneAt))
  if (filter.open === false) where.push(isNotNull(schema.tasks.doneAt))
  if (filter.assigneeUserId === null) where.push(isNull(schema.tasks.assigneeUserId))
  else if (filter.assigneeUserId !== undefined) where.push(eq(schema.tasks.assigneeUserId, filter.assigneeUserId))
  if (filter.companyId) where.push(eq(schema.tasks.companyId, filter.companyId))
  if (filter.kind) where.push(eq(schema.tasks.kind, filter.kind))
  if (filter.dueBefore) where.push(lt(schema.tasks.dueAt, filter.dueBefore))
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 200)))

  const rows = await db
    .select({
      task: schema.tasks,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      assigneeName: schema.users.name,
      assigneeEmail: schema.users.email,
    })
    .from(schema.tasks)
    .leftJoin(schema.companies, and(eq(schema.companies.id, schema.tasks.companyId), eq(schema.companies.orgId, schema.tasks.orgId)))
    .leftJoin(schema.users, and(eq(schema.users.id, schema.tasks.assigneeUserId), eq(schema.users.orgId, schema.tasks.orgId)))
    .where(and(...where))
    .orderBy(
      sql`${schema.tasks.doneAt} IS NOT NULL`,
      sql`${schema.tasks.dueAt} ASC NULLS LAST`,
      desc(schema.tasks.doneAt),
      desc(schema.tasks.createdAt),
      desc(schema.tasks.id),
    )
    .limit(limit)
  return rows.map((r) => ({
    ...r.task,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
    assigneeName: r.assigneeName,
    assigneeEmail: r.assigneeEmail,
  }))
}

/** The one open task for a touch, or null — how a caller that lost the unique race re-reads. */
export async function tasksOpenForTouch(db: AgencyDb, orgId: string, touchId: string): Promise<TaskRow | null> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.touchId, touchId), isNull(schema.tasks.doneAt)))
    .limit(1)
  return rows[0] ?? null
}

async function taskById(db: AgencyDb, orgId: string, id: string): Promise<TaskRow | null> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.id, id)))
    .limit(1)
  return rows[0] ?? null
}

const NO_SUCH_TASK: Fail<'not_found'> = { ok: false, reason: 'not_found', message: 'No such task.' }

/**
 * Mark a task done.
 *
 * One UPDATE with `done_at IS NULL` in its predicate, so two people pressing
 * Done at once produce one completion and one audit row; the second is told
 * `alreadyDone` and shown the first one's row, not an error.
 */
export async function tasksComplete(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly byUserId: string; readonly actor: string; readonly now?: Date },
): Promise<{ ok: true; alreadyDone: boolean; task: TaskRow } | Fail<'not_found'>> {
  let rows: TaskRow[]
  try {
    rows = await db
      .update(schema.tasks)
      .set({ doneAt: args.now ?? new Date(), doneBy: args.byUserId })
      .where(and(eq(schema.tasks.orgId, args.orgId), eq(schema.tasks.id, args.id), isNull(schema.tasks.doneAt)))
      .returning()
  } catch (err) {
    // `tasks_done_by_is_in_the_same_org`: a completer from another org.
    if (isForeignKeyViolation(err)) return { ok: false, reason: 'not_found', message: NOT_ON_TEAM }
    throw err
  }
  const task = rows[0]
  if (!task) {
    const existing = await taskById(db, args.orgId, args.id)
    return existing ? { ok: true, alreadyDone: true, task: existing } : NO_SUCH_TASK
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'task.completed',
    subjectType: 'task',
    subjectId: task.id,
    detail: { taskId: task.id, companyId: task.companyId },
  })
  return { ok: true, alreadyDone: false, task }
}

/**
 * Reopen a done task. For a `linkedin_send`, the unique index refuses a
 * reopen while another task for the same touch is open — one open step per
 * message holds in both directions.
 */
export async function tasksReopen(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly actor: string },
): Promise<{ ok: true; alreadyOpen: boolean; task: TaskRow } | Fail<'not_found' | 'duplicate_open_for_touch'>> {
  let rows: TaskRow[]
  try {
    rows = await db
      .update(schema.tasks)
      .set({ doneAt: null, doneBy: null })
      .where(and(eq(schema.tasks.orgId, args.orgId), eq(schema.tasks.id, args.id), isNotNull(schema.tasks.doneAt)))
      .returning()
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'duplicate_open_for_touch', message: 'There is already an open task for that message.' }
    }
    throw err
  }
  const task = rows[0]
  if (!task) {
    const existing = await taskById(db, args.orgId, args.id)
    return existing ? { ok: true, alreadyOpen: true, task: existing } : NO_SUCH_TASK
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'task.reopened',
    subjectType: 'task',
    subjectId: task.id,
    detail: { taskId: task.id, companyId: task.companyId },
  })
  return { ok: true, alreadyOpen: false, task }
}

/** Hand a task to a teammate in THIS org, or unassign it with null. */
export async function tasksAssign(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly assigneeUserId: string | null; readonly actor: string },
): Promise<{ ok: true; task: TaskRow } | Fail<'not_found' | 'assignee_not_in_org'>> {
  if (args.assigneeUserId !== null && !(await assignable(db, args.orgId, args.assigneeUserId))) {
    return { ok: false, reason: 'assignee_not_in_org', message: NOT_ON_TEAM }
  }
  let rows: TaskRow[]
  try {
    rows = await db
      .update(schema.tasks)
      .set({ assigneeUserId: args.assigneeUserId })
      .where(and(eq(schema.tasks.orgId, args.orgId), eq(schema.tasks.id, args.id)))
      .returning()
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, reason: 'assignee_not_in_org', message: NOT_ON_TEAM }
    throw err
  }
  const task = rows[0]
  if (!task) return NO_SUCH_TASK
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'task.assigned',
    subjectType: 'task',
    subjectId: task.id,
    detail: { taskId: task.id, assigneeUserId: args.assigneeUserId },
  })
  return { ok: true, task }
}

/** Set a task's due date, or clear it with null. */
export async function tasksSetDue(
  db: AgencyDb,
  args: { readonly orgId: string; readonly id: string; readonly dueAt: Date | null; readonly actor: string },
): Promise<{ ok: true; task: TaskRow } | Fail<'not_found' | 'invalid'>> {
  if (args.dueAt && Number.isNaN(args.dueAt.getTime())) {
    return { ok: false, reason: 'invalid', message: 'The due date could not be read.' }
  }
  const rows = await db
    .update(schema.tasks)
    .set({ dueAt: args.dueAt })
    .where(and(eq(schema.tasks.orgId, args.orgId), eq(schema.tasks.id, args.id)))
    .returning()
  const task = rows[0]
  if (!task) return NO_SUCH_TASK
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.actor,
    action: 'task.due_set',
    subjectType: 'task',
    subjectId: task.id,
    detail: { taskId: task.id, dueAt: args.dueAt ? args.dueAt.toISOString() : null },
  })
  return { ok: true, task }
}

/**
 * Open, overdue and due-soon counts, for the dashboard and the digest.
 *
 * `dueToday` is due in the NEXT 24 HOURS from `now`, not "on today's date":
 * the org has no timezone of its own, and a calendar day computed in the
 * server's zone would be a day nobody on the team lives in. Overdue is
 * strictly before `now`; a done task is neither.
 */
export async function tasksCounts(
  db: AgencyDb,
  orgId: string,
  now: Date,
): Promise<{ open: number; overdue: number; dueToday: number }> {
  const until = new Date(now.getTime() + DAY_MS)
  const rows = await db
    .select({
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${schema.tasks.dueAt} < ${now})::int`,
      dueToday: sql<number>`count(*) FILTER (WHERE ${schema.tasks.dueAt} >= ${now} AND ${schema.tasks.dueAt} < ${until})::int`,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, orgId), isNull(schema.tasks.doneAt)))
  const r = rows[0]
  return { open: Number(r?.open ?? 0), overdue: Number(r?.overdue ?? 0), dueToday: Number(r?.dueToday ?? 0) }
}

/**
 * What the template buttons on a company page need to know before they are
 * pressed: the won deal they would hang off, and how many of each set are
 * still open. The page says why a button is disabled from the same facts
 * `tasksApplyTemplate` refuses on.
 */
export async function tasksTemplateReadiness(
  db: AgencyDb,
  orgId: string,
  companyId: string,
): Promise<{ wonDealId: string | null; openKickoff: number; openRenewal: number }> {
  const [deal, counts] = await Promise.all([
    wonDealFor(db, orgId, companyId),
    db
      .select({
        kickoff: sql<number>`count(*) FILTER (WHERE ${schema.tasks.kind} = 'kickoff')::int`,
        renewal: sql<number>`count(*) FILTER (WHERE ${schema.tasks.kind} = 'renewal')::int`,
      })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.companyId, companyId), isNull(schema.tasks.doneAt))),
  ])
  return {
    wonDealId: deal?.id ?? null,
    openKickoff: Number(counts[0]?.kickoff ?? 0),
    openRenewal: Number(counts[0]?.renewal ?? 0),
  }
}

/** The company's most recently won deal in this org, if it has one. */
async function wonDealFor(db: AgencyDb, orgId: string, companyId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: schema.deals.id })
    .from(schema.deals)
    .where(and(eq(schema.deals.orgId, orgId), eq(schema.deals.companyId, companyId), eq(schema.deals.stage, 'won')))
    .orderBy(sql`${schema.deals.closedAt} DESC NULLS LAST`, desc(schema.deals.updatedAt), desc(schema.deals.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Apply the kickoff or renewal template to a company, because a person
 * pressed the button.
 *
 * Both hang off a WON deal: kickoff is how an engagement starts and renewal
 * is how one is followed up, and neither means anything for a company that
 * never engaged. A named deal must be this company's and won; otherwise the
 * most recently won one is used.
 *
 * A set whose tasks are still open is not applied again — a double click, or
 * a second teammate pressing the same button, would otherwise double the
 * list. The check and the inserts run in one transaction under an advisory
 * lock keyed on the company and the template, so two presses at once still
 * produce one set on a real Postgres.
 *
 * Nothing is sent. The audit row `task.template_applied` names the template,
 * the company and the count.
 */
export async function tasksApplyTemplate(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly template: TaskTemplateName
    readonly companyId: string
    readonly dealId?: string | null
    /** Who the new tasks are assigned to; null leaves them unassigned. */
    readonly assigneeUserId?: string | null
    readonly createdBy: string | null
    readonly actor: string
    readonly now?: Date
  },
): Promise<{ ok: true; tasks: TaskRow[] } | Fail<'not_found' | 'deal_not_won' | 'already_applied' | 'assignee_not_in_org'>> {
  const template = TASK_TEMPLATES[args.template]
  if (!template) return { ok: false, reason: 'not_found', message: 'There is no such template.' }

  const company = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (company.length === 0) return { ok: false, reason: 'not_found', message: 'That company is not in the CRM.' }

  let dealId: string
  if (args.dealId) {
    const deal = await db
      .select({ id: schema.deals.id, companyId: schema.deals.companyId, stage: schema.deals.stage })
      .from(schema.deals)
      .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.id, args.dealId)))
      .limit(1)
    if (deal.length === 0 || deal[0]!.companyId !== args.companyId) {
      return { ok: false, reason: 'not_found', message: 'That deal is not one of this company’s.' }
    }
    if (deal[0]!.stage !== 'won') {
      return { ok: false, reason: 'deal_not_won', message: `The ${args.template} tasks are for a won deal; this one is at ${deal[0]!.stage}.` }
    }
    dealId = deal[0]!.id
  } else {
    const won = await wonDealFor(db, args.orgId, args.companyId)
    if (!won) {
      return { ok: false, reason: 'deal_not_won', message: `The ${args.template} tasks are for a won deal, and this company has none.` }
    }
    dealId = won.id
  }

  const assigneeUserId = args.assigneeUserId ?? null
  if (assigneeUserId && !(await assignable(db, args.orgId, assigneeUserId))) {
    return { ok: false, reason: 'assignee_not_in_org', message: NOT_ON_TEAM }
  }

  const planned = tasksFromTemplate(template, args.now ?? new Date())
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tasks.template:${args.companyId}:${args.template}`}))`)
    const open = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.orgId, args.orgId),
        eq(schema.tasks.companyId, args.companyId),
        eq(schema.tasks.kind, args.template),
        isNull(schema.tasks.doneAt),
      ))
    const n = Number(open[0]?.n ?? 0)
    if (n > 0) {
      return {
        ok: false as const,
        reason: 'already_applied' as const,
        message: `This company already has ${n} open ${args.template} task${n === 1 ? '' : 's'}. Finish or reopen those rather than starting a second set.`,
      }
    }

    const tasks = await t
      .insert(schema.tasks)
      .values(planned.map((p) => ({
        orgId: args.orgId,
        kind: p.kind,
        title: p.title,
        detail: p.detail,
        companyId: args.companyId,
        dealId,
        assigneeUserId,
        createdBy: args.createdBy,
        dueAt: p.dueAt,
      })))
      .returning()

    for (const task of tasks) {
      await appendAudit(t, {
        orgId: args.orgId,
        actor: args.actor,
        action: 'task.created',
        subjectType: 'task',
        subjectId: task.id,
        detail: { taskId: task.id, kind: task.kind, companyId: task.companyId },
      })
    }
    await appendAudit(t, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'task.template_applied',
      subjectType: 'company',
      subjectId: args.companyId,
      detail: { template: args.template, companyId: args.companyId, dealId, count: tasks.length },
    })
    return { ok: true as const, tasks }
  })
}

/** Overdue exactly as `tasksCounts` counts it, for a page marking one row. */
export function tasksIsOverdue(task: Pick<TaskRow, 'doneAt' | 'dueAt'>, now: Date): boolean {
  return task.doneAt === null && task.dueAt !== null && task.dueAt.getTime() < now.getTime()
}
