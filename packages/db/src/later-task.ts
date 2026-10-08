/**
 * A reply that asks to be contacted later becomes a task on that day
 * (2026-10-08): "call me next month" is a call on the 1st at 10:00 where the
 * person is, for the deal's owner — or nobody — instead of a note somebody
 * has to remember.
 *
 * `recordInboundReply` calls this in a savepoint after the deal move, for a
 * reply that is neither an opt-out nor an auto-reply, so a task that cannot
 * be written never costs the reply its record. The reading is core's
 * (`laterAsk`, on the sender's own words); the task carries OUR phrase for
 * when — never the reply's words — and says to read the reply first.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { instantAtWallClock, laterAsk, localDateIn, ownWords } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { tasksCreate } from './tasks.js'

/** The zone a reply is read in when neither the contact nor the company names one. */
export const LATER_ASK_DEFAULT_ZONE = 'Asia/Kolkata'
/** When on the day the follow-up falls due, where the person is. */
export const LATER_ASK_AT = '10:00'

export async function laterAskTask(
  db: AgencyDb,
  args: { readonly orgId: string; readonly contactId: string; readonly companyId: string; readonly body: string; readonly now: Date },
): Promise<{ readonly phrase: string; readonly taskId: string } | null> {
  const [row] = await db
    .select({
      contactZone: schema.contacts.timeZone,
      companyZone: schema.companies.timeZone,
      name: schema.companies.name,
      domain: schema.companies.domain,
    })
    .from(schema.contacts)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
    .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
    .limit(1)
  if (!row) return null
  const zone = row.contactZone ?? row.companyZone ?? LATER_ASK_DEFAULT_ZONE
  const today = localDateIn(args.now, zone)
  if (!today) return null
  const ask = laterAsk(ownWords(args.body), today)
  if (!ask) return null
  const dueAt = instantAtWallClock(ask.day, LATER_ASK_AT, zone)
  if (!dueAt) return null

  const [deal] = await db
    .select({ id: schema.deals.id, ownerUserId: schema.deals.ownerUserId })
    .from(schema.deals)
    .where(and(eq(schema.deals.orgId, args.orgId), eq(schema.deals.companyId, args.companyId), isNull(schema.deals.closedAt)))
    .orderBy(desc(schema.deals.createdAt))
    .limit(1)
  const name = [...(row.name || row.domain)].slice(0, 60).join('')
  const detail =
    `Their reply on ${today} named a time for the next contact — ${ask.phrase} — so this is due ${ask.day} at ${LATER_ASK_AT} ` +
    'their time. Read the reply in /inbox before you get in touch.'
  const base = {
    orgId: args.orgId,
    companyId: args.companyId,
    dealId: deal?.id ?? null,
    dueAt,
    createdBy: null,
    actor: 'system',
  } as const
  const make = async (kind: 'call' | 'todo', assignee: string | null) =>
    tasksCreate(db, {
      ...base,
      kind,
      assigneeUserId: assignee,
      title: `${kind === 'call' ? `Call ${name}` : `Follow up with ${name}`} ${ask.phrase}, as their reply said`,
      detail,
    })
  // A call when there is a number on record that nobody asked us to stop calling; a to-do otherwise.
  // The deal's owner when they still have access; nobody otherwise.
  for (const assignee of deal?.ownerUserId ? [deal.ownerUserId, null] : [null]) {
    for (const kind of ['call', 'todo'] as const) {
      const r = await make(kind, assignee)
      if (r.ok) return { phrase: ask.phrase, taskId: r.task.id }
      if (r.reason === 'assignee_not_in_org') break
    }
  }
  return null
}
