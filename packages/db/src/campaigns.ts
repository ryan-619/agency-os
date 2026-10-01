/**
 * Campaigns and the suppression list (PROMPT.md §8.4).
 *
 * "Campaign builder: ICP filter, channel, daily cap, quiet hours, auto-send
 * toggle (default off)."
 *
 * The validation here is the boundary the web form writes through. Note what
 * it does NOT do: none of it decides whether a message may be sent. That is
 * `decideSend`'s job, from the campaign's stored values, on every single
 * message — §2.1 is explicit that suppression is checked "in the send path,
 * not the campaign builder", and the same reasoning applies to every other
 * rule here. A campaign builder that validated compliance would be a second
 * place that could be right while the send path was wrong.
 */
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { normaliseSuppressionValue, type SuppressionKind, type SuppressionSource } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'

export type SuppressionRow = typeof schema.suppressions.$inferSelect

/** `HH:MM`, which is what a browser's `<input type="time">` produces. */
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a 24-hour time, like 21:00.')

export const campaignInput = z.object({
  name: z.string().min(1, 'Give the campaign a name.').max(120),
  /**
   * §2.1: cold outreach is email and LinkedIn. The other three exist as
   * channels for contacts who opted in, but a CAMPAIGN is by definition a
   * sequence of cold messages — so they are not offered here at all, and the
   * send path refuses them independently.
   */
  channel: z.enum(['email', 'linkedin']),
  icpProfileId: z.uuid().nullable().default(null),
  /**
   * A cap, not a target. The upper bound is a deliverability judgement rather
   * than a rule: a warmed mailbox sending 500 cold emails in a day stops being
   * a warmed mailbox. The LOWER bound is the database's
   * (`campaigns_daily_cap_check`, 0004): a campaign is paused by its status,
   * not by a cap of zero, and a form that accepted zero would be a 500.
   */
  dailyCap: z.number().int().min(1).max(200),
  quietStart: clock,
  quietEnd: clock,
  /** §2.4. Default off, and turning it on is owner-only at the route. */
  autoSend: z.boolean().default(false),
  status: z.enum(['draft', 'active', 'paused', 'done']).default('draft'),
})

export type CampaignInput = z.infer<typeof campaignInput>
export type CampaignRow = typeof schema.campaigns.$inferSelect
export type CampaignStatus = CampaignInput['status']

/**
 * An EDIT: the campaign as the form will save it, and the status the form
 * LOADED (`expectStatus`), which `updateCampaign` puts in its predicate.
 * Optional, so a caller that never read a status writes as before. Review
 * round 3, finding 13: the form sent back the status it loaded, so a save
 * made after the worker paused a bouncing campaign re-activated it.
 */
export const campaignEditInput = campaignInput.extend({
  expectStatus: z.enum(['draft', 'active', 'paused', 'done']).optional(),
})

/** The statuses of a message still waiting to go — the ones a channel switch would strand. */
const LIVE_STATUSES = ['queued', 'awaiting_approval', 'approved', 'sending'] as const

/**
 * What a save did. Each refusal is something that changed, or waits, since
 * the form was read — never an error — and the route words each one.
 */
export type CampaignUpdate =
  | { readonly ok: true; readonly row: CampaignRow }
  | { readonly ok: false; readonly reason: 'not_found' }
  /** Auto-send is no longer what the caller read (`expect.autoSend`). */
  | { readonly ok: false; readonly reason: 'auto_send_changed'; readonly autoSend: boolean }
  /** The status is no longer what the form loaded (`expect.status`). */
  | { readonly ok: false; readonly reason: 'status_changed'; readonly status: string }
  /** A channel switch, refused while `live` messages written for `channel` wait. */
  | { readonly ok: false; readonly reason: 'channel_has_live_messages'; readonly live: number; readonly channel: string }
  /** Something moved between the save and the read that explains it; saving again settles it. */
  | { readonly ok: false; readonly reason: 'changed' }

export async function listCampaigns(db: AgencyDb, orgId: string): Promise<CampaignRow[]> {
  return db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.orgId, orgId))
    .orderBy(desc(schema.campaigns.createdAt))
}

export async function readCampaign(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<CampaignRow | null> {
  const rows = await db
    .select()
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function createCampaign(
  db: AgencyDb,
  orgId: string,
  input: CampaignInput,
): Promise<CampaignRow> {
  const rows = await db
    .insert(schema.campaigns)
    .values({
      orgId,
      name: input.name,
      channel: input.channel,
      icpProfileId: input.icpProfileId,
      dailyCap: input.dailyCap,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
      autoSend: input.autoSend,
      status: input.status,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('campaign insert returned no row')
  return row
}

export async function updateCampaign(
  db: AgencyDb,
  orgId: string,
  id: string,
  input: CampaignInput,
  /**
   * What the caller READ before deciding what to write, each put in the
   * UPDATE's own predicate so a save built on a stale read matches nothing
   * instead of undoing what changed since. Null or absent skips that check.
   */
  expect: {
    /**
     * The auto-send value the caller read before deciding it was allowed to
     * write: a member's save built on a stale read — auto-send was on when
     * they opened the form and an owner turned it off since — must not turn
     * it back on. Null for a caller allowed to set it either way.
     */
    readonly autoSend?: boolean | null
    /**
     * The status the edit form LOADED (r4, review round 3, finding 13). The
     * form sends every field back, status included, so a teammate who
     * changed only the cap re-activated a campaign the worker had paused
     * for bouncing in between.
     */
    readonly status?: CampaignStatus | null
  } = {},
): Promise<CampaignUpdate> {
  // r4 (review round 3, finding 2): the channel may not move under messages
  // still waiting to go. Each was written for the campaign's channel, and a
  // campaign switched from LinkedIn to email while it held approved
  // messages used to have them addressed by the email keys. The sender
  // refuses such a message too (`channelMismatch`); this stops the edit that
  // would strand it. Raw SQL names `campaigns` itself: the subquery must
  // read the row being updated, never its own `touches` row.
  const live = sql.join(LIVE_STATUSES.map((s) => sql`${s}`), sql`, `)
  const rows = await db
    .update(schema.campaigns)
    .set({
      name: input.name,
      channel: input.channel,
      icpProfileId: input.icpProfileId,
      dailyCap: input.dailyCap,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
      autoSend: input.autoSend,
      status: input.status,
    })
    .where(
      and(
        eq(schema.campaigns.orgId, orgId),
        eq(schema.campaigns.id, id),
        ...(expect.autoSend == null ? [] : [eq(schema.campaigns.autoSend, expect.autoSend)]),
        ...(expect.status == null ? [] : [eq(schema.campaigns.status, expect.status)]),
        sql`(campaigns.channel = ${input.channel} OR NOT EXISTS (
          SELECT 1 FROM touches t
           WHERE t.org_id = campaigns.org_id AND t.campaign_id = campaigns.id
             AND t.direction = 'out' AND t.status IN (${live})
        ))`,
      ),
    )
    .returning()
  const row = rows[0]
  if (row) return { ok: true, row }

  // Nothing matched: say which expectation failed, from a fresh read. The
  // order is the predicate's, so the answer names the first thing that
  // stopped the save.
  const current = await readCampaign(db, orgId, id)
  if (!current) return { ok: false, reason: 'not_found' }
  if (expect.autoSend != null && current.autoSend !== expect.autoSend) {
    return { ok: false, reason: 'auto_send_changed', autoSend: current.autoSend }
  }
  if (expect.status != null && current.status !== expect.status) {
    return { ok: false, reason: 'status_changed', status: current.status }
  }
  if (current.channel !== input.channel) {
    const [waiting] = await db
      .select({ n: count() })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.orgId, orgId),
          eq(schema.touches.campaignId, id),
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.status, [...LIVE_STATUSES]),
        ),
      )
    const n = waiting?.n ?? 0
    if (n > 0) return { ok: false, reason: 'channel_has_live_messages', live: n, channel: current.channel }
  }
  return { ok: false, reason: 'changed' }
}

/**
 * What a campaign has actually done.
 *
 * Sent, refused and why — the counts that answer "why did a campaign of 40
 * send 12?". Read from `touches` rather than kept on the campaign row: a
 * counter is a second source of truth, and its drift always favours sending.
 */
export async function campaignActivity(
  db: AgencyDb,
  orgId: string,
  campaignId: string,
): Promise<{ sent: number; awaitingApproval: number; waitingToSend: number; refusals: { code: string; n: number }[] }> {
  const rows = await db
    .select({
      status: schema.touches.status,
      refusalCode: schema.touches.refusalCode,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.campaignId, campaignId)))
    .groupBy(schema.touches.status, schema.touches.refusalCode)

  let sent = 0
  let awaitingApproval = 0
  // Approved, queued and mid-send were counted by NOTHING — so a message a
  // person had approved showed up in no number on any screen, and a
  // deployment with no worker to drain the queue looked identical to one
  // that had sent everything.
  let waitingToSend = 0
  const refusals: { code: string; n: number }[] = []
  for (const row of rows) {
    if (row.status === 'sent' || row.status === 'delivered' || row.status === 'replied') sent += row.n
    else if (row.status === 'awaiting_approval') awaitingApproval += row.n
    else if (row.status === 'approved' || row.status === 'queued' || row.status === 'sending') waitingToSend += row.n
    else if (row.status === 'refused' && row.refusalCode) {
      refusals.push({ code: row.refusalCode, n: row.n })
    }
  }
  refusals.sort((a, b) => b.n - a.n)
  return { sent, awaitingApproval, waitingToSend, refusals }
}

// ---------------------------------------------------------------------------
// A campaign that bounces pauses itself
// ---------------------------------------------------------------------------

/**
 * One campaign's bounce rate: of the people it wrote to, how many addresses
 * have since bounced permanently.
 *
 * Counted in PEOPLE, not messages — a follow-up to a dead address is the
 * same dead address — and a person counts as bounced only when their mark
 * came AFTER this campaign wrote to them, so an address that was already
 * dead (and so refused, never sent) cannot count against a campaign that
 * never reached it.
 */
export interface CampaignBounceRate {
  readonly orgId: string
  readonly campaignId: string
  readonly sentTo: number
  readonly bounced: number
  /** `bounced ÷ sentTo × 100`, to one decimal. For display; the decision uses the counts. */
  readonly pct: number
}

/**
 * Bounce rates for every ACTIVE email campaign, across every org — the
 * worker's view, like `dueTouches`.
 *
 * The window is `since` (the caller passes thirty days ago), moved forward
 * to the campaign's last `campaign.auto_paused` row when there is one. That
 * is what lets a person re-activate a campaign after fixing its list: the
 * people it bounced on before the pause were the reason for the pause, and
 * counting them again would pause it on the next tick for the problem the
 * person just fixed. After re-activation it needs `minSentTo` NEW people
 * before it can be judged again.
 *
 * Campaigns with fewer than `minSentTo` people in the window are left out:
 * two bounces in five sends is not a rate, it is two bounces.
 */
export async function campaignBounceRates(
  db: AgencyDb,
  args: { readonly since: Date; readonly minSentTo: number },
): Promise<CampaignBounceRate[]> {
  const since = args.since.toISOString()
  const res: unknown = await db.execute(sql`
    SELECT k.org_id AS "orgId", k.id AS "campaignId", s.sent_to AS "sentTo", s.bounced AS "bounced"
      FROM campaigns k
     CROSS JOIN LATERAL (
       SELECT max(a.created_at) AS at
         FROM audit_log a
        WHERE a.subject_type = 'campaign' AND a.subject_id = k.id
          AND a.org_id = k.org_id AND a.action = 'campaign.auto_paused'
     ) p
     CROSS JOIN LATERAL (
       SELECT count(DISTINCT t.contact_id)::int AS sent_to,
              count(DISTINCT t.contact_id) FILTER (WHERE c.email_bounced_at >= t.sent_at)::int AS bounced
         FROM touches t
         JOIN contacts c ON c.id = t.contact_id AND c.org_id = t.org_id
        WHERE t.campaign_id = k.id AND t.org_id = k.org_id
          AND t.direction = 'out' AND t.channel = 'email' AND t.sent_at IS NOT NULL
          AND t.sent_at >= greatest(${since}::timestamptz, coalesce(p.at, ${since}::timestamptz))
     ) s
     WHERE k.status = 'active' AND k.channel = 'email' AND s.sent_to >= ${Math.max(1, Math.trunc(args.minSentTo))}
     ORDER BY k.org_id, k.id`)
  // node-postgres and PGlite both answer `{ rows }` (see enrolment.ts).
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] } | null)?.rows ?? [])) as {
    orgId: string
    campaignId: string
    sentTo: number
    bounced: number
  }[]
  return rows.map((r) => ({
    orgId: r.orgId,
    campaignId: r.campaignId,
    sentTo: Number(r.sentTo),
    bounced: Number(r.bounced),
    pct: Math.round((Number(r.bounced) / Number(r.sentTo)) * 1000) / 10,
  }))
}

/** What the audit row records, and what the campaigns page reads back. */
export interface CampaignAutoPauseDetail {
  readonly bouncePct: number
  readonly threshold: number
  readonly sentTo: number
  readonly bounced: number
}

/**
 * Pause a campaign because its addresses are bouncing — once.
 *
 * One UPDATE whose predicate carries `status = 'active'`, so a second tick,
 * a second worker, or a person who paused it by hand a moment ago all match
 * nothing, and only the pause that actually happened is audited. The pause
 * IS the existing refusal: `campaign_inactive` defers every message in it,
 * and a person sets it active again from the campaigns page. Nothing here
 * can re-activate anything.
 *
 * The update and its audit row are one transaction, because the row is load
 * bearing: it is what the campaigns page quotes, and it is where
 * `campaignBounceRates` restarts its window after a person re-activates.
 */
export async function campaignAutoPause(
  db: AgencyDb,
  args: { readonly orgId: string; readonly campaignId: string; readonly detail: CampaignAutoPauseDetail },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.campaigns)
      .set({ status: 'paused', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.campaigns.orgId, args.orgId),
          eq(schema.campaigns.id, args.campaignId),
          eq(schema.campaigns.status, 'active'),
        ),
      )
      .returning({ id: schema.campaigns.id })
    if (rows.length === 0) return false
    await appendAudit(tx, {
      orgId: args.orgId,
      actor: 'system',
      action: 'campaign.auto_paused',
      subjectType: 'campaign',
      subjectId: args.campaignId,
      // Counts and the threshold. Never who bounced.
      detail: {
        bouncePct: args.detail.bouncePct,
        threshold: args.detail.threshold,
        sentTo: args.detail.sentTo,
        bounced: args.detail.bounced,
      },
    })
    return true
  })
}

/**
 * The campaigns in one org that are paused BECAUSE they bounced, with the
 * numbers the pause was made on — for the sentence on the campaigns page.
 *
 * The latest `campaign.auto_paused` row per campaign that no person has
 * re-activated since. A save that set the campaign active is the end of the
 * automatic pause; a save that only renamed it while paused is not. The
 * caller shows it only while the campaign's status is still `paused`.
 */
export async function campaignAutoPauses(
  db: AgencyDb,
  orgId: string,
): Promise<Map<string, CampaignAutoPauseDetail & { readonly at: Date }>> {
  const rows = await db
    .selectDistinctOn([schema.auditLog.subjectId], {
      campaignId: schema.auditLog.subjectId,
      detail: schema.auditLog.detail,
      at: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.subjectType, 'campaign'),
        eq(schema.auditLog.action, 'campaign.auto_paused'),
        // The route's save writes one of these three actions with the
        // campaign's resulting status in `detail`.
        sql`NOT EXISTS (
          SELECT 1 FROM audit_log later
           WHERE later.org_id = ${schema.auditLog.orgId}
             AND later.subject_type = 'campaign'
             AND later.subject_id = ${schema.auditLog.subjectId}
             AND later.action IN ('campaign.updated', 'campaign.auto_send_on', 'campaign.auto_send_off')
             AND later.detail->>'status' = 'active'
             AND later.created_at > ${schema.auditLog.createdAt}
        )`,
      ),
    )
    .orderBy(schema.auditLog.subjectId, desc(schema.auditLog.createdAt))

  const out = new Map<string, CampaignAutoPauseDetail & { readonly at: Date }>()
  for (const r of rows) {
    if (!r.campaignId) continue
    const d = (r.detail ?? {}) as Record<string, unknown>
    const n = (k: string): number | null => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : null)
    const bouncePct = n('bouncePct')
    const threshold = n('threshold')
    const sentTo = n('sentTo')
    const bounced = n('bounced')
    // A row missing its numbers is not quoted: a sentence with a blank in it
    // is worse than the plain "paused" the card already shows.
    if (bouncePct === null || threshold === null || sentTo === null || bounced === null) continue
    out.set(r.campaignId, { bouncePct, threshold, sentTo, bounced, at: r.at })
  }
  return out
}

// ---------------------------------------------------------------------------
// The suppression list
// ---------------------------------------------------------------------------

export async function listSuppressions(
  db: AgencyDb,
  orgId: string,
  limit = 500,
): Promise<SuppressionRow[]> {
  return db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.orgId, orgId))
    .orderBy(desc(schema.suppressions.createdAt))
    .limit(limit)
}

/**
 * Add a suppression, or say why it could not be added.
 *
 * A returned error is an opt-out that was NOT recorded, which is the worst
 * outcome this table has — so the caller must show it to a person rather than
 * logging it. That is why this returns a result instead of throwing: a thrown
 * error becomes a 500 and a 500 becomes a retry nobody performs.
 *
 * Adding one that already exists is a success, not a conflict. Somebody
 * pasting a list of opt-outs twice should not have to work out which line the
 * duplicate was.
 */
export async function addSuppression(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly kind: SuppressionKind
    readonly value: string
    readonly reason: string
    /**
     * WHICH path recorded the opt-out (0018): a person on the suppressions
     * page, a reply, a spoken opt-out, the one-click link, an erasure. A fact
     * an auditor asks for, so it is a column and not a prefix on the reason.
     * Null when the caller predates the column; never invented.
     */
    readonly source?: SuppressionSource | null
  },
): Promise<{ ok: true; value: string; alreadyPresent: boolean } | { ok: false; message: string }> {
  const reason = args.reason.trim()
  if (!reason) {
    // `suppressions_source_is_not_blank`'s sibling rule, and the same
    // reasoning: a suppression nobody can explain gets deleted by whoever
    // finds it, and deleting one means contacting somebody who opted out.
    return { ok: false, message: 'Say why this is suppressed — a row nobody can explain gets removed.' }
  }

  const value = normaliseSuppressionValue(args.kind, args.value)
  if (!value) {
    // Each message names what to type instead. A suppression that fails to
    // store is an opt-out nobody recorded, so the operator has to be able to
    // fix it on the spot rather than be told it was invalid.
    const why: Record<SuppressionKind, string> = {
      phone:
        `"${args.value}" is not a number in international form. Include the country code, ` +
        'like +1 415 555 0100 — without one it cannot be matched reliably and the opt-out ' +
        'would not be honoured.',
      linkedin:
        `"${args.value}" could not be read as a LinkedIn profile. Paste the full URL, like ` +
        'linkedin.com/in/jane-doe or linkedin.com/company/acme — a bare handle does not say ' +
        'whether it is a person or a company, and the wrong one would never match.',
      email: `"${args.value}" could not be read as an email address.`,
      domain: `"${args.value}" could not be read as a domain.`,
    }
    return { ok: false, message: why[args.kind] }
  }

  // ON CONFLICT on the unique index, not select-then-insert: two replies
  // saying "stop" in the same second are two inserts, and the loser used to
  // throw — out of `recordInboundReply`, after the pause and before the
  // audit row. A duplicate is the outcome the caller wanted.
  const inserted = await db
    .insert(schema.suppressions)
    .values({ orgId: args.orgId, kind: args.kind, value, reason, source: args.source ?? null })
    .onConflictDoNothing({
      target: [schema.suppressions.orgId, schema.suppressions.kind, schema.suppressions.value],
    })
    .returning({ id: schema.suppressions.id })
  return { ok: true, value, alreadyPresent: inserted.length === 0 }
}

/**
 * Remove a suppression.
 *
 * Deliberately possible — a suppression added by mistake has to be removable,
 * and a list that can only grow becomes a list nobody trusts. The audit row
 * the caller writes is what makes it accountable, and it is the one audit
 * entry in this module the caller must not skip.
 */
export async function removeSuppression(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<SuppressionRow | null> {
  const rows = await db
    .delete(schema.suppressions)
    .where(and(eq(schema.suppressions.orgId, orgId), eq(schema.suppressions.id, id)))
    .returning()
  return rows[0] ?? null
}

/** Contacts currently paused, for the screen that explains why nothing is going out. */
export async function pausedContacts(
  db: AgencyDb,
  orgId: string,
): Promise<{ id: string; email: string | null; pausedAt: Date | null; pausedReason: string | null }[]> {
  return db
    .select({
      id: schema.contacts.id,
      email: schema.contacts.email,
      pausedAt: schema.contacts.pausedAt,
      pausedReason: schema.contacts.pausedReason,
    })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), sql`${schema.contacts.pausedAt} IS NOT NULL`))
    .orderBy(asc(schema.contacts.pausedAt))
}
