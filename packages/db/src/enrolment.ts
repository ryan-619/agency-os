/**
 * Enrolling a campaign: one draft per enrollable contact, the first
 * production caller of `draftOpener` (§8.4).
 *
 * Enrolment QUEUES; the single send path decides. Every row written here is
 * `awaiting_approval` — or `queued` when the campaign auto-sends — and never
 * `approved`: a person approves the words (§2.4), and 0011 makes an approval
 * without an approver unstorable anyway. Whichever it is, the worker runs it
 * through `decideSend` at the moment of sending, so a rule that changed in
 * the hour since (an opt-out, a pause, the cap) still wins.
 *
 * What it deliberately does NOT read is the suppression list. §2.1 says
 * suppression is checked "in the send path, not the campaign builder": a
 * builder that also checked would be a second opinion that could be right
 * while the sender was wrong. A suppressed contact is therefore enrolled, and
 * refused `suppressed` by `dispatchTouch` — recorded on the row, counted on
 * the campaign card. The one exception is a dry run, which reports a HINT —
 * how many of the drafts the sender would refuse as suppressed today — read
 * through `previewSend`, which reads exactly what the sender reads and
 * decides nothing about the plan.
 *
 * The rules — who may be drafted to, what the draft says, what an earlier row
 * means — are pure and live in `packages/core/src/enrolment.ts`. This file
 * gathers the rows and writes the drafts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_STALE_AFTER_DAYS, ENROL_LIMIT_DEFAULT, ENROL_LIMIT_MAX, enrolCompanyGate, enrolIgnoredStatuses,
  enrolPriorSkip, enrolSkipCounts, enrollableContact, enrolmentDraft, isStale, parseIcpDefinition,
  type EnrolChannel, type EnrolSkip, type IcpDefinition,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { activeIcpProfile, companyList, latestScanWithFindings } from './repository.js'
import { appendAudit } from './approvals.js'
import { readCampaign } from './campaigns.js'
import { listContactsForCompany } from './contacts.js'
import { previewSend } from './send-preview.js'

export interface EnrolQueued {
  /** The draft written, or null in a dry run, which writes nothing. */
  readonly touchId: string | null
  readonly contactId: string
  readonly companyId: string
}

export interface EnrolSkipped {
  readonly companyId: string
  /** Null when the whole company was skipped before its people were read. */
  readonly contactId: string | null
  readonly why: EnrolSkip
}

export type EnrolOutcome =
  | {
      readonly ok: true
      readonly dryRun: boolean
      /** What every draft was (or would be) written as. Never `approved`. */
      readonly status: 'queued' | 'awaiting_approval'
      readonly queued: readonly EnrolQueued[]
      readonly skipped: readonly EnrolSkipped[]
      /**
       * True when at least one more person would have been drafted to but the
       * limit was reached. Enrolling again continues: everyone drafted this
       * time is `already_enrolled` next time.
       */
      readonly truncated: boolean
      readonly limit: number
      /**
       * Dry run only: how many of the planned drafts the send path would
       * refuse as suppressed if they were sent now. A hint read through
       * `previewSend`; the plan does not change because of it. Null when
       * drafts were actually written.
       */
      readonly suppressedHint: number | null
    }
  | {
      readonly ok: false
      readonly reason: 'no_such_campaign' | 'campaign_done' | 'campaign_channel_unsupported' | 'no_icp'
      readonly message: string
    }

/**
 * Queue one draft per enrollable contact of every qualifying, fresh,
 * reachable company — or, with `dryRun`, say what that would do and write
 * nothing at all.
 *
 * Companies are taken highest score first, so the limit keeps the best leads.
 * Freshness is decided from the scan's `ran_at` through `isStale`, never from
 * `findings.stale`, which is a cache as of the last scan (§2.2).
 */
export async function enrolCampaign(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly campaignId: string
    /** A users.id, for the audit row. */
    readonly actor: string
    /** Who signs the drafts. Null leaves them unsigned, as `draftOpener` does. */
    readonly senderName?: string | null
    readonly dryRun?: boolean
    readonly limit?: number
    readonly now?: Date
  },
): Promise<EnrolOutcome> {
  const now = args.now ?? new Date()
  const dryRun = args.dryRun === true
  const limit = boundedLimit(args.limit)

  const campaign = await readCampaign(db, args.orgId, args.campaignId)
  if (!campaign) {
    return { ok: false, reason: 'no_such_campaign', message: 'No campaign with that id is in this org. Nothing was queued.' }
  }
  if (campaign.status === 'done') {
    return {
      ok: false,
      reason: 'campaign_done',
      message: `${campaign.name} is marked done, so nothing is enrolled into it. Set it back to draft or active first.`,
    }
  }
  // §2.1: a campaign is cold outreach, and cold is email and LinkedIn only.
  // `campaignInput` offers nothing else, but the column's CHECK allows five
  // channels, and a row written some other way must not become cold SMS here.
  if (campaign.channel !== 'email' && campaign.channel !== 'linkedin') {
    return {
      ok: false,
      reason: 'campaign_channel_unsupported',
      message: `${campaign.name} is on ${campaign.channel}, which is not a cold channel. Enrolment writes email and LinkedIn drafts only.`,
    }
  }
  const channel: EnrolChannel = campaign.channel

  const icpRow = await activeIcpProfile(db, args.orgId)
  let icp: IcpDefinition | null = null
  try {
    icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  } catch {
    icp = null
  }
  if (!icp) {
    return {
      ok: false,
      reason: 'no_icp',
      message: 'There is no readable active ICP profile, so nothing can say which companies qualify or what their gaps mean.',
    }
  }
  const staleAfter = icp.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS

  const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, args.orgId)).limit(1)
  const agencyName = org?.name ?? ''

  // The contact's zone falls back to the company's, as the sender's does.
  const zoneRows = await db
    .select({ id: schema.companies.id, timeZone: schema.companies.timeZone })
    .from(schema.companies)
    .where(eq(schema.companies.orgId, args.orgId))
  const companyZone = new Map(zoneRows.map((r) => [r.id, r.timeZone]))

  // Highest score first; `companyList` is already by domain, and the sort is
  // stable, so ties stay alphabetical.
  const companies = [...(await companyList(db, args.orgId))].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))

  const status = campaign.autoSend ? ('queued' as const) : ('awaiting_approval' as const)
  const ignored = enrolIgnoredStatuses(campaign.autoSend)
  const queued: EnrolQueued[] = []
  const skipped: EnrolSkipped[] = []
  let truncated = false

  companies: for (const c of companies) {
    // A cheap first pass from the list's own scan and score, so findings are
    // read only for companies that could qualify. The decision that counts is
    // the one below, over the rows `latestScanWithFindings` returns.
    const early = enrolCompanyGate(
      c.lastScanAt ? { ok: c.lastScanOk === true, stale: isStale(c.lastScanAt, staleAfter, now) } : null,
      c.lastScanAt ? { score: c.score ?? 0, tier: c.tier, qualified: c.qualified, disqualifiedReason: c.disqualifiedReason } : null,
    )
    if (early) {
      skipped.push({ companyId: c.companyId, contactId: null, why: early })
      continue
    }

    const found = await latestScanWithFindings(db, args.orgId, c.companyId)
    const verdict = enrolmentDraft({
      company: { domain: c.domain, name: c.name },
      icp,
      findings: (found?.findings ?? []).map((f) => ({
        signalKey: f.signalKey,
        observed: f.observed,
        gap: f.gap,
        weight: f.weight,
        detail: f.detail,
        evidence: (f.evidence ?? {}) as Record<string, unknown>,
        scored: f.scored,
      })),
      scan: found
        ? { ranAt: found.scan.ranAt, ok: found.scan.ok, error: found.scan.error, stale: isStale(found.scan.ranAt, staleAfter, now) }
        : null,
      score: found?.score
        ? {
            score: found.score.score,
            tier: found.score.tier,
            qualified: found.score.qualified,
            disqualifiedReason: found.score.disqualifiedReason,
          }
        : null,
      agencyName,
      senderName: args.senderName ?? null,
    })
    if (!verdict.ok) {
      skipped.push({ companyId: c.companyId, contactId: null, why: verdict.why })
      continue
    }

    const people = await listContactsForCompany(db, args.orgId, c.companyId)
    if (people.length === 0) {
      skipped.push({ companyId: c.companyId, contactId: null, why: 'no_contact' })
      continue
    }

    const prior = await db
      .select({ contactId: schema.touches.contactId, status: schema.touches.status })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.orgId, args.orgId),
          eq(schema.touches.campaignId, campaign.id),
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.contactId, people.map((p) => p.id)),
        ),
      )

    for (const p of people) {
      const who = enrollableContact(p, companyZone.get(c.companyId) ?? null, channel)
      if (!who.ok) {
        skipped.push({ companyId: c.companyId, contactId: p.id, why: who.why })
        continue
      }
      const earlier = enrolPriorSkip(
        prior.filter((t) => t.contactId === p.id).map((t) => t.status),
        campaign.autoSend,
      )
      if (earlier) {
        skipped.push({ companyId: c.companyId, contactId: p.id, why: earlier })
        continue
      }
      if (queued.length >= limit) {
        truncated = true
        break companies
      }
      if (dryRun) {
        queued.push({ touchId: null, contactId: p.id, companyId: c.companyId })
        continue
      }

      const touchId = await insertDraft(db, {
        orgId: args.orgId,
        campaignId: campaign.id,
        contactId: p.id,
        companyId: c.companyId,
        channel,
        status,
        subject: verdict.draft.subject,
        body: verdict.draft.body,
        ignored,
      })
      // No row means another enrolment wrote one for this pair between the
      // read above and this statement — its NOT EXISTS saw that row.
      if (touchId) queued.push({ touchId, contactId: p.id, companyId: c.companyId })
      else skipped.push({ companyId: c.companyId, contactId: p.id, why: 'already_enrolled' })
    }
  }

  let suppressedHint: number | null = null
  if (dryRun) {
    suppressedHint = 0
    for (const q of queued) {
      const preview = await previewSend(db, { orgId: args.orgId, contactId: q.contactId, campaignId: campaign.id, now })
      if (preview.ok && preview.facts.suppressed) suppressedHint++
    }
  } else {
    // Counts only: never an id list, an address, a subject or a body (§2.3).
    await appendAudit(db, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'campaign.enrolled',
      subjectType: 'campaign',
      subjectId: campaign.id,
      detail: {
        campaignId: campaign.id,
        queued: queued.length,
        skipped: enrolSkipCounts(skipped),
        status,
        limit,
        truncated,
      },
    }).catch(() => {})
  }

  return { ok: true, dryRun, status, queued, skipped, truncated, limit, suppressedHint }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ENROL_LIMIT_DEFAULT
  return Math.min(Math.max(Math.trunc(limit), 1), ENROL_LIMIT_MAX)
}

/**
 * One draft, written only if the pair has no earlier row that counts.
 *
 * The check lives in the INSERT's own SELECT rather than in a read before it,
 * so it is one statement: two people pressing Enrol at once can still both
 * pass (neither sees the other's uncommitted row), which leaves at most one
 * extra draft per person — visible in /approvals and deniable. It is not a
 * constraint on purpose: the table legitimately holds several rows for one
 * pair (`sender.test.ts`'s batch-order test inserts five approved rows for
 * one), and
 * a partial unique index would be a migration this feature does not own.
 *
 * Raw SQL because the typed builder's INSERT … SELECT must list every column
 * of `touches` in table order; naming only the columns written leaves the
 * rest to their defaults, as `.values()` would.
 */
async function insertDraft(
  db: AgencyDb,
  d: {
    readonly orgId: string
    readonly campaignId: string
    readonly contactId: string
    readonly companyId: string
    readonly channel: EnrolChannel
    readonly status: 'queued' | 'awaiting_approval'
    readonly subject: string
    readonly body: string
    readonly ignored: readonly string[]
  },
): Promise<string | null> {
  const res: unknown = await db.execute(sql`
    INSERT INTO touches (org_id, campaign_id, contact_id, company_id, channel, direction, status, subject, body)
    SELECT ${d.orgId}::uuid, ${d.campaignId}::uuid, ${d.contactId}::uuid, ${d.companyId}::uuid,
           ${d.channel}, 'out', ${d.status}, ${d.subject}, ${d.body}
    WHERE NOT EXISTS (
      SELECT 1 FROM touches t
       WHERE t.org_id = ${d.orgId}::uuid
         AND t.campaign_id = ${d.campaignId}::uuid
         AND t.contact_id = ${d.contactId}::uuid
         AND t.direction = 'out'
         AND t.status NOT IN (${sql.join(d.ignored.map((s) => sql`${s}`), sql`, `)})
    )
    RETURNING id`)
  // node-postgres and PGlite both answer `{ rows }`; an array is accepted too
  // so a driver that returns rows bare cannot read as "nothing inserted".
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] } | null)?.rows ?? [])
  const first = rows[0] as { id?: unknown } | undefined
  return typeof first?.id === 'string' ? first.id : null
}
