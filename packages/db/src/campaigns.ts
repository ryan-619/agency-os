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
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { normaliseSuppressionValue } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

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
   * The auto-send value the caller READ before deciding it was allowed to
   * write. Put in the predicate, so a member's save built on a stale read —
   * auto-send was on when they opened the form and an owner turned it off
   * since — matches nothing instead of turning it back on. Null skips the
   * check, for a caller allowed to set it either way.
   */
  expectAutoSend: boolean | null = null,
): Promise<CampaignRow | null> {
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
        ...(expectAutoSend === null ? [] : [eq(schema.campaigns.autoSend, expectAutoSend)]),
      ),
    )
    .returning()
  return rows[0] ?? null
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
): Promise<{ sent: number; awaitingApproval: number; refusals: { code: string; n: number }[] }> {
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
  const refusals: { code: string; n: number }[] = []
  for (const row of rows) {
    if (row.status === 'sent' || row.status === 'delivered' || row.status === 'replied') sent += row.n
    else if (row.status === 'awaiting_approval') awaitingApproval += row.n
    else if (row.status === 'refused' && row.refusalCode) {
      refusals.push({ code: row.refusalCode, n: row.n })
    }
  }
  refusals.sort((a, b) => b.n - a.n)
  return { sent, awaitingApproval, refusals }
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
    readonly kind: 'email' | 'domain' | 'phone'
    readonly value: string
    readonly reason: string
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
    return {
      ok: false,
      message:
        args.kind === 'phone'
          ? `"${args.value}" is not a number in international form. Include the country code, ` +
            'like +1 415 555 0100 — without one it cannot be matched reliably and the opt-out ' +
            'would not be honoured.'
          : `"${args.value}" could not be read as ${args.kind === 'email' ? 'an email address' : 'a domain'}.`,
    }
  }

  // ON CONFLICT on the unique index, not select-then-insert: two replies
  // saying "stop" in the same second are two inserts, and the loser used to
  // throw — out of `recordInboundReply`, after the pause and before the
  // audit row. A duplicate is the outcome the caller wanted.
  const inserted = await db
    .insert(schema.suppressions)
    .values({ orgId: args.orgId, kind: args.kind, value, reason })
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
