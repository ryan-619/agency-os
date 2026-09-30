/**
 * The kickoff and renewal task templates, as data.
 *
 * A won deal is the start of an engagement, and every engagement this agency
 * runs begins with the same five things done by a person before any work
 * starts; every one that finishes has the same two follow-ups. These are those
 * lists. They are applied ONLY when somebody presses the button — never by a
 * stage change — because a board that fills itself with work nobody asked for
 * is a board people stop reading.
 *
 * Nothing in either list sends anything. A task is a reminder to a person;
 * the kickoff items that involve the client (the letter, the accounts, the
 * allow-list) are things a person arranges, from their own mailbox or call.
 *
 * Due dates are whole days after the moment the template is applied, counted
 * as 24-hour steps on the instant rather than as calendar days anywhere: the
 * org has no timezone of its own, and a due date that moved by an hour across
 * a DST change is a smaller surprise than one computed in the server's zone.
 */

export type TemplateTaskKind = 'kickoff' | 'renewal'

export interface TemplateTask {
  readonly title: string
  readonly kind: TemplateTaskKind
  /** Days after the template is applied. */
  readonly dueAfterDays: number
  /** Why the task exists, shown under its title. */
  readonly detail: string
}

const DAY_MS = 86_400_000

function frozen(items: readonly TemplateTask[]): readonly TemplateTask[] {
  return Object.freeze(items.map((t) => Object.freeze({ ...t })))
}

/** The five things an engagement starts with. */
export const KICKOFF_TEMPLATE: readonly TemplateTask[] = frozen([
  {
    title: 'Signed authorisation letter on file',
    kind: 'kickoff',
    dueAfterDays: 2,
    detail: 'No work starts without it: the letter is what makes the engagement authorised, and it names the scope.',
  },
  {
    title: 'Test accounts for each role in scope',
    kind: 'kickoff',
    dueAfterDays: 5,
    detail: 'One account per role the scope covers, created by the client, never shared with a real user.',
  },
  {
    title: 'Source IPs on the client allow-list',
    kind: 'kickoff',
    dueAfterDays: 5,
    detail: 'Send the addresses the work will come from, and confirm the client has allowed them.',
  },
  {
    title: 'Escalation contacts agreed on both sides',
    kind: 'kickoff',
    dueAfterDays: 2,
    detail: 'Who to call, on each side, if something breaks or something serious is found — with out-of-hours numbers.',
  },
  {
    title: 'Out-of-band channel for credentials agreed',
    kind: 'kickoff',
    dueAfterDays: 2,
    detail: 'Credentials for the test accounts travel on a channel agreed in advance — never in the same thread as the scope.',
  },
])

/** The two follow-ups an engagement ends with. */
export const RENEWAL_TEMPLATE: readonly TemplateTask[] = frozen([
  {
    title: 'Retest the fixed findings',
    kind: 'renewal',
    dueAfterDays: 42,
    detail: 'Six weeks on: confirm what the client says is fixed is fixed, and say so in writing.',
  },
  {
    title: 'Re-engagement conversation',
    kind: 'renewal',
    dueAfterDays: 335,
    detail: 'Eleven months on: ask whether the next year’s work is worth scoping, before the anniversary rather than after it.',
  },
])

export type TaskTemplateName = 'kickoff' | 'renewal'

export const TASK_TEMPLATES: Readonly<Record<TaskTemplateName, readonly TemplateTask[]>> = Object.freeze({
  kickoff: KICKOFF_TEMPLATE,
  renewal: RENEWAL_TEMPLATE,
})

export function isTaskTemplateName(value: unknown): value is TaskTemplateName {
  return value === 'kickoff' || value === 'renewal'
}

/**
 * The tasks a template produces, due relative to `from`.
 *
 * Deterministic: the same template and the same instant give the same list,
 * in the template's order. An invalid `from` is a programming error rather
 * than a person's input (the routes pass their own clock), so it throws
 * instead of producing tasks due at `NaN`.
 */
export function tasksFromTemplate(
  template: readonly TemplateTask[],
  from: Date,
): { title: string; kind: TemplateTaskKind; detail: string; dueAt: Date }[] {
  const at = from.getTime()
  if (Number.isNaN(at)) throw new RangeError('tasksFromTemplate needs a valid date to count from')
  return template.map((t) => ({
    title: t.title,
    kind: t.kind,
    detail: t.detail,
    dueAt: new Date(at + t.dueAfterDays * DAY_MS),
  }))
}
