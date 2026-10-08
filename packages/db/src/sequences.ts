/**
 * Follow-up sequences (0024): a campaign's steps after its opener, and the
 * advancer that takes each person through them until they reply.
 *
 * The decision about a run is core's (`sequenceNext`); this file gathers the
 * facts and obeys. A run starts when a campaign with steps has SENT its first
 * message to a person — within `SEQUENCE_START_WINDOW_DAYS`, so adding steps
 * to an old campaign does not wake everyone it ever wrote to — and every step
 * is claimed in ONE statement over the position and the message it read, so
 * two advancers (the worker's tick and the daily cron) take each step once.
 *
 * A message step is a draft like any other — `awaiting_approval`, or `queued`
 * when the campaign auto-sends — on the campaign's channel, judged by the one
 * send path at the moment of sending. A call or a visit is a task for the
 * deal's owner, or nobody; a call only where there is a number nobody asked
 * us to stop calling (`tasksCreate`), and a step whose task cannot be made is
 * skipped and recorded, never retried for ever.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  SEQUENCE_STOP_REASONS, followUpSubject, renderStepWords, sequenceNext, sequenceStepsProblem,
  type SequenceStep, type SequenceStepKind, type SequenceStopReason,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { tasksCreate } from './tasks.js'

/** A message step goes on its campaign's channel; SMS and WhatsApp are a registered template filled for one person. */
export const SEQUENCE_CHANNELS = ['email', 'linkedin'] as const
/** Runs start only for openers sent within this many days of the advancer's look. */
export const SEQUENCE_START_WINDOW_DAYS = 30
/** How many live runs one pass reads. */
export const SEQUENCE_ADVANCE_LIMIT = 200

export type SequenceRunRow = typeof schema.sequenceRuns.$inferSelect

const stepOf = (r: typeof schema.campaignSteps.$inferSelect): SequenceStep => ({
  position: r.position,
  kind: r.kind as SequenceStepKind,
  afterDays: r.afterDays,
  subject: r.subject,
  body: r.body,
})

export async function campaignStepsRead(db: AgencyDb, orgId: string, campaignId: string): Promise<SequenceStep[]> {
  const rows = await db
    .select()
    .from(schema.campaignSteps)
    .where(and(eq(schema.campaignSteps.orgId, orgId), eq(schema.campaignSteps.campaignId, campaignId)))
    .orderBy(asc(schema.campaignSteps.position))
  return rows.map(stepOf)
}

export type StepsSaveOutcome =
  | { readonly ok: true; readonly steps: readonly SequenceStep[] }
  | { readonly ok: false; readonly reason: 'not_found' | 'channel' | 'invalid'; readonly message: string }

/**
 * Replace a campaign's steps, in one transaction with its audit row (counts
 * by kind, never the words). A run already under way carries on from its
 * position through whatever steps there are now.
 */
export async function campaignStepsSave(
  db: AgencyDb,
  args: { readonly orgId: string; readonly campaignId: string; readonly steps: readonly SequenceStep[]; readonly actor: string },
): Promise<StepsSaveOutcome> {
  const [campaign] = await db
    .select({ channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, args.orgId), eq(schema.campaigns.id, args.campaignId)))
    .limit(1)
  if (!campaign) return { ok: false, reason: 'not_found', message: 'That campaign does not exist.' }
  const steps = args.steps.map((s) => ({
    ...s,
    subject: s.kind === 'message' && s.subject?.trim() ? s.subject.trim() : null,
    body: s.kind === 'message' ? s.body?.trim() ?? '' : null,
  }))
  if (steps.some((s) => s.kind === 'message') && !(SEQUENCE_CHANNELS as readonly string[]).includes(campaign.channel)) {
    return {
      ok: false,
      reason: 'channel',
      message: `A ${campaign.channel} campaign takes calls and visits as follow-ups, never another message: each text is drafted for one person from a registered template.`,
    }
  }
  const problem = sequenceStepsProblem(steps)
  if (problem) return { ok: false, reason: 'invalid', message: problem }
  await db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await t.delete(schema.campaignSteps).where(and(eq(schema.campaignSteps.orgId, args.orgId), eq(schema.campaignSteps.campaignId, args.campaignId)))
    if (steps.length > 0) {
      await t.insert(schema.campaignSteps).values(
        steps.map((s) => ({ orgId: args.orgId, campaignId: args.campaignId, position: s.position, kind: s.kind, afterDays: s.afterDays, subject: s.subject, body: s.body })),
      )
    }
    await appendAudit(t, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'campaign.steps_saved',
      subjectType: 'campaign',
      subjectId: args.campaignId,
      detail: {
        steps: steps.length,
        messages: steps.filter((s) => s.kind === 'message').length,
        calls: steps.filter((s) => s.kind === 'call').length,
        visits: steps.filter((s) => s.kind === 'visit').length,
      },
    })
  })
  return { ok: true, steps }
}

/** How a campaign's runs stand: live, and stopped by why. */
export async function sequenceRunsSummary(
  db: AgencyDb,
  orgId: string,
  campaignId: string,
): Promise<{ readonly live: number; readonly stopped: Readonly<Record<SequenceStopReason, number>> }> {
  const rows = await db
    .select({ reason: schema.sequenceRuns.stopReason, n: sql<number>`count(*)::int` })
    .from(schema.sequenceRuns)
    .where(and(eq(schema.sequenceRuns.orgId, orgId), eq(schema.sequenceRuns.campaignId, campaignId)))
    .groupBy(schema.sequenceRuns.stopReason)
  const stopped = Object.fromEntries(SEQUENCE_STOP_REASONS.map((r) => [r, 0])) as Record<SequenceStopReason, number>
  let live = 0
  for (const r of rows) {
    if (r.reason === null) live += r.n
    else if ((SEQUENCE_STOP_REASONS as readonly string[]).includes(r.reason)) stopped[r.reason as SequenceStopReason] += r.n
  }
  return { live, stopped }
}

export interface AdvanceResult {
  readonly started: number
  readonly messages: number
  readonly tasks: number
  readonly skipped: number
  readonly stopped: Readonly<Partial<Record<SequenceStopReason, number>>>
  readonly waiting: number
}

/**
 * One pass: start the runs that are due to start, then take, wait on or stop
 * each live run — at most `limit`, oldest anchor first. Safe to run from two
 * places at once: every write is claimed over what was read.
 */
export async function advanceSequences(
  db: AgencyDb,
  args: { readonly now: Date; readonly limit?: number; readonly orgId?: string },
): Promise<AdvanceResult> {
  const { now } = args
  const since = new Date(now.getTime() - SEQUENCE_START_WINDOW_DAYS * 86_400_000)
  const started = await db.execute(sql`
    INSERT INTO sequence_runs (org_id, campaign_id, contact_id, started_at, anchor_at)
    SELECT t.org_id, t.campaign_id, t.contact_id, min(t.sent_at), min(t.sent_at)
      FROM touches t
      JOIN campaigns c ON c.id = t.campaign_id AND c.org_id = t.org_id
     WHERE t.direction = 'out'
       AND t.status IN ('sent', 'delivered')
       AND t.sent_at IS NOT NULL
       AND t.sent_at >= ${since.toISOString()}::timestamptz
       AND t.contact_id IS NOT NULL
       AND t.answers_touch_id IS NULL
       AND t.channel = c.channel
       AND EXISTS (SELECT 1 FROM campaign_steps s WHERE s.campaign_id = t.campaign_id)
       ${args.orgId ? sql`AND t.org_id = ${args.orgId}::uuid` : sql``}
     GROUP BY t.org_id, t.campaign_id, t.contact_id
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
    RETURNING id`)
  const startedRows = Array.isArray(started) ? started : ((started as { rows?: unknown[] }).rows ?? [])

  const runs = await db
    .select({
      run: schema.sequenceRuns,
      campaignStatus: schema.campaigns.status,
      channel: schema.campaigns.channel,
      autoSend: schema.campaigns.autoSend,
      campaignName: schema.campaigns.name,
      pausedAt: schema.contacts.pausedAt,
      firstName: schema.contacts.firstName,
      companyId: schema.contacts.companyId,
    })
    .from(schema.sequenceRuns)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.sequenceRuns.campaignId))
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.sequenceRuns.contactId))
    .where(and(isNull(schema.sequenceRuns.stoppedAt), ...(args.orgId ? [eq(schema.sequenceRuns.orgId, args.orgId)] : [])))
    .orderBy(asc(schema.sequenceRuns.anchorAt))
    .limit(args.limit ?? SEQUENCE_ADVANCE_LIMIT)

  const steps = new Map<string, SequenceStep[]>()
  for (const id of [...new Set(runs.map((r) => r.run.campaignId))]) {
    const rows = await db.select().from(schema.campaignSteps).where(eq(schema.campaignSteps.campaignId, id)).orderBy(asc(schema.campaignSteps.position))
    steps.set(id, rows.map(stepOf))
  }
  const agencies = new Map<string, string>()
  const agencyOf = async (orgId: string) => {
    if (!agencies.has(orgId)) {
      const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).limit(1)
      agencies.set(orgId, org?.name ?? '')
    }
    return agencies.get(orgId)!
  }

  let messages = 0
  let tasks = 0
  let skipped = 0
  let waiting = 0
  const stopped: Partial<Record<SequenceStopReason, number>> = {}

  for (const r of runs) {
    const run = r.run
    const [waitingMessage] = run.waitingTouchId
      ? await db.select({ status: schema.touches.status, sentAt: schema.touches.sentAt }).from(schema.touches).where(eq(schema.touches.id, run.waitingTouchId)).limit(1)
      : []
    const [replied] = await db
      .select({ id: schema.touches.id })
      .from(schema.touches)
      .where(and(
        eq(schema.touches.orgId, run.orgId),
        eq(schema.touches.contactId, run.contactId),
        eq(schema.touches.direction, 'in'),
        sql`${schema.touches.createdAt} >= ${run.startedAt.toISOString()}::timestamptz`,
        sql`${schema.touches.replyKind} IS DISTINCT FROM 'auto_reply'`,
      ))
      .limit(1)
    const deals = r.companyId
      ? await db.select({ closedAt: schema.deals.closedAt }).from(schema.deals).where(and(eq(schema.deals.orgId, run.orgId), eq(schema.deals.companyId, r.companyId)))
      : []
    const decision = sequenceNext({
      nextPosition: run.nextPosition,
      anchorAt: run.anchorAt,
      waiting: waitingMessage ?? null,
      steps: steps.get(run.campaignId) ?? [],
      campaignStatus: r.campaignStatus,
      repliedSince: replied !== undefined,
      contactPaused: r.pausedAt !== null,
      dealClosed: deals.length > 0 && deals.every((d) => d.closedAt !== null),
      now,
    })

    // Every write below matches only the run as it was read: another advancer that got there first wins.
    const asRead = and(
      eq(schema.sequenceRuns.id, run.id),
      isNull(schema.sequenceRuns.stoppedAt),
      eq(schema.sequenceRuns.nextPosition, run.nextPosition),
      run.waitingTouchId === null ? isNull(schema.sequenceRuns.waitingTouchId) : eq(schema.sequenceRuns.waitingTouchId, run.waitingTouchId),
    )

    if (decision.kind === 'stop') {
      const done = await db.transaction(async (tx) => {
        const t = tx as unknown as AgencyDb
        const rows = await t
          .update(schema.sequenceRuns)
          .set({ stoppedAt: now, stopReason: decision.reason, waitingTouchId: null, updatedAt: now })
          .where(asRead)
          .returning({ id: schema.sequenceRuns.id })
        if (rows.length === 0) return false
        await appendAudit(t, {
          orgId: run.orgId, actor: 'system', action: 'sequence.stopped', subjectType: 'contact', subjectId: run.contactId,
          detail: { campaignId: run.campaignId, reason: decision.reason, position: run.nextPosition },
        })
        return true
      })
      if (done) stopped[decision.reason] = (stopped[decision.reason] ?? 0) + 1
      continue
    }
    if (decision.kind === 'wait') {
      waiting += 1
      if (decision.settled) {
        await db.update(schema.sequenceRuns).set({ anchorAt: decision.anchorAt, waitingTouchId: null, updatedAt: now }).where(asRead)
      }
      continue
    }

    const step = decision.step
    // Read before the transaction opens: inside it, every read goes through `t`, never `db`.
    const agency = await agencyOf(run.orgId)
    const outcome = await db.transaction(async (tx) => {
      const t = tx as unknown as AgencyDb
      const claimed = await t
        .update(schema.sequenceRuns)
        .set({
          nextPosition: step.position + 1,
          anchorAt: step.kind === 'message' ? decision.anchorAt : now,
          waitingTouchId: null,
          updatedAt: now,
        })
        .where(asRead)
        .returning({ id: schema.sequenceRuns.id })
      if (claimed.length === 0) return null
      const [company] = r.companyId
        ? await t.select({ name: schema.companies.name, domain: schema.companies.domain }).from(schema.companies).where(eq(schema.companies.id, r.companyId)).limit(1)
        : []
      const companyName = company?.name || company?.domain || 'your business'

      if (step.kind === 'message') {
        const vars = { firstName: r.firstName, company: companyName, agency }
        const [opener] = await t
          .select({ subject: schema.touches.subject })
          .from(schema.touches)
          .where(and(
            eq(schema.touches.orgId, run.orgId), eq(schema.touches.campaignId, run.campaignId),
            eq(schema.touches.contactId, run.contactId), eq(schema.touches.direction, 'out'), eq(schema.touches.status, 'sent'),
          ))
          .orderBy(asc(schema.touches.sentAt))
          .limit(1)
        const subject = step.subject ? renderStepWords(step.subject, vars) : followUpSubject(opener?.subject ?? null)
        const [touch] = await t
          .insert(schema.touches)
          .values({
            orgId: run.orgId,
            campaignId: run.campaignId,
            contactId: run.contactId,
            companyId: r.companyId,
            channel: r.channel,
            direction: 'out',
            status: r.autoSend ? 'queued' : 'awaiting_approval',
            subject: subject ?? `A follow-up from ${vars.agency}`.slice(0, 200),
            body: renderStepWords(step.body ?? '', vars),
          })
          .returning({ id: schema.touches.id })
        await t.update(schema.sequenceRuns).set({ waitingTouchId: touch!.id }).where(eq(schema.sequenceRuns.id, run.id))
        await appendAudit(t, {
          orgId: run.orgId, actor: 'system', action: 'sequence.step_taken', subjectType: 'contact', subjectId: run.contactId,
          detail: { campaignId: run.campaignId, position: step.position, kind: 'message', touchId: touch!.id },
        })
        return 'message' as const
      }

      const [deal] = r.companyId
        ? await t
            .select({ id: schema.deals.id, ownerUserId: schema.deals.ownerUserId })
            .from(schema.deals)
            .where(and(eq(schema.deals.orgId, run.orgId), eq(schema.deals.companyId, r.companyId), isNull(schema.deals.closedAt)))
            .orderBy(desc(schema.deals.createdAt))
            .limit(1)
        : []
      const who = r.firstName?.trim() ? `${[...r.firstName.trim()].slice(0, 40).join('')} at ` : ''
      const name = [...companyName].slice(0, 60).join('')
      const title = step.kind === 'call' ? `Call ${who}${name} — follow-up step ${step.position}` : `Visit ${name} — follow-up step ${step.position}`
      const detail =
        `Step ${step.position} of the campaign “${[...r.campaignName].slice(0, 80).join('')}”: no reply since the first message on ` +
        `${run.startedAt.toISOString().slice(0, 10)}. Check /inbox first — a reply stops the sequence, and this task is yours to close.`
      // A task the rules refuse (no number, a number on the suppression list) is skipped in a savepoint, so the
      // refusal does not abort the claim — the run moves on and the skip is recorded.
      const made = r.companyId
        ? await t
            .transaction((sp) =>
              tasksCreate(sp as unknown as AgencyDb, {
                orgId: run.orgId, kind: step.kind as 'call' | 'visit', title, detail, companyId: r.companyId, dealId: deal?.id ?? null,
                assigneeUserId: deal?.ownerUserId ?? null, dueAt: now, createdBy: null, actor: 'system',
              }).then((res) => {
                if (!res.ok) throw new SkippedStep(res.reason)
                return res
              }),
            )
            .catch((e: unknown) => (e instanceof SkippedStep ? e : new SkippedStep('fault')))
        : new SkippedStep('no_company')
      if (made instanceof SkippedStep) {
        await appendAudit(t, {
          orgId: run.orgId, actor: 'system', action: 'sequence.step_skipped', subjectType: 'contact', subjectId: run.contactId,
          detail: { campaignId: run.campaignId, position: step.position, kind: step.kind, why: made.why },
        })
        return 'skipped' as const
      }
      await appendAudit(t, {
        orgId: run.orgId, actor: 'system', action: 'sequence.step_taken', subjectType: 'contact', subjectId: run.contactId,
        detail: { campaignId: run.campaignId, position: step.position, kind: step.kind, taskId: made.task.id },
      })
      return 'task' as const
    })
    if (outcome === 'message') messages += 1
    else if (outcome === 'task') tasks += 1
    else if (outcome === 'skipped') skipped += 1
  }
  return { started: startedRows.length, messages, tasks, skipped, stopped, waiting }
}

class SkippedStep extends Error {
  constructor(readonly why: string) {
    super(`step skipped: ${why}`)
    this.name = 'SkippedStep'
  }
}

/** The live runs of one person, for a screen that says what is still to come. */
export async function sequenceRunsFor(db: AgencyDb, orgId: string, contactIds: readonly string[]): Promise<SequenceRunRow[]> {
  if (contactIds.length === 0) return []
  return db
    .select()
    .from(schema.sequenceRuns)
    .where(and(eq(schema.sequenceRuns.orgId, orgId), inArray(schema.sequenceRuns.contactId, [...contactIds]), isNull(schema.sequenceRuns.stoppedAt)))
}
