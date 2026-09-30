/**
 * The counts behind /compliance: the questions an auditor asks, as numbers
 * somebody can check (§2.1, §2.2).
 *
 * Every function here COUNTS ROWS. None of them re-derives a rule the send
 * path already applied, because a second implementation of a rule is a
 * second opinion, and the day the two disagree the page would be vouching
 * for the wrong one. Two recomputations are left out on purpose:
 *
 *   * quiet hours. Checking yesterday's send against TODAY's window and
 *     TODAY's zone on the contact is not an observation of anything — the
 *     campaign's window and the contact's zone may both have changed since.
 *     The send path decided at the moment of sending; that decision is on
 *     the row (`refusal_code = 'quiet_hours'`), and that is what is counted.
 *   * approvals decided after expiry are NOT a breach. `decideApproval`
 *     refuses a decision on a lapsed row and hands back a clean `expired`,
 *     so the count is informational and says so.
 *
 * Where a check CAN be restated as a query over today's rows it is — the
 * cold-channel check, the opted-out replies with no suppression row, the
 * auto-send CHECK — and each is labelled as being against today's rows,
 * because a ledger that keeps the current answer cannot say what the answer
 * was last Tuesday.
 *
 * Freshness is DERIVED from the scan's `ran_at` with `isStale()`, never read
 * from `findings.stale` (CLAUDE.md §2.2: that column is a cache). The page
 * shows how many stale companies the cache still calls fresh, so nobody is
 * tempted to count the column instead.
 *
 * Nothing here writes. `complianceSummary` is what the wave-3
 * `get_compliance_summary` tool reads, so the page and the tool cannot
 * disagree.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  isStale, normalisePhone, suppressionKeysFor, SUPPRESSION_SOURCES,
  type Channel, type SendRefusalCode, type SuppressionSource,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { callsThatDidNotDisclose } from './calls.js'

const MS_PER_DAY = 86_400_000

/** The window the "last 30 days" counts use, measured back from `now`. */
export const COMPLIANCE_WINDOW_DAYS = 30

// ---------------------------------------------------------------------------
// 1. Consent, per channel and by where it was recorded
// ---------------------------------------------------------------------------

/** Where a consent row came from, read off what its writer stamps. */
export type ComplianceConsentSource = 'booking_page' | 'contacts_page' | 'other'

export const COMPLIANCE_CONSENT_CHANNELS = ['email', 'sms', 'voice', 'whatsapp'] as const

export interface ComplianceTally {
  readonly granted: number
  readonly refused: number
}

export interface ComplianceConsents {
  /** Every consent channel, in a fixed order, zeros included. */
  readonly byChannel: readonly ({ readonly channel: string } & ComplianceTally)[]
  readonly bySource: readonly ({ readonly source: ComplianceConsentSource } & ComplianceTally)[]
  readonly total: ComplianceTally
}

/**
 * The writer's own stamp, not a guess at the wording. The booking page
 * writes `evidence.form = 'booking_page'` and a source beginning
 * `booking page, <date>`; the contacts page's form writes
 * `evidence.form = 'contacts_page'` and appends `(recorded by <who>)` to
 * whatever the person typed — the older route appended the same suffix and
 * no form, so the suffix is read as well.
 *
 * The contacts-page test runs FIRST: a person who types "booking page" into
 * that form produces `booking page (recorded by …)`, which is a person's
 * record of a booking, not the booking page's.
 */
const CONSENT_SOURCE_CLASS = sql<ComplianceConsentSource>`CASE
  WHEN ${schema.consents.evidence}->>'form' = 'contacts_page'
    OR ${schema.consents.source} LIKE '%(recorded by %)' THEN 'contacts_page'
  WHEN ${schema.consents.evidence}->>'form' = 'booking_page'
    OR ${schema.consents.source} LIKE 'booking page%' THEN 'booking_page'
  ELSE 'other' END`

export async function complianceConsentsByChannel(db: AgencyDb, orgId: string): Promise<ComplianceConsents> {
  const rows = await db
    .select({
      channel: schema.consents.channel,
      source: CONSENT_SOURCE_CLASS,
      granted: schema.consents.granted,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.consents)
    .where(eq(schema.consents.orgId, orgId))
    .groupBy(schema.consents.channel, CONSENT_SOURCE_CLASS, schema.consents.granted)

  const tally = () => ({ granted: 0, refused: 0 })
  const byChannel = new Map<string, { granted: number; refused: number }>(
    COMPLIANCE_CONSENT_CHANNELS.map((c) => [c, tally()]),
  )
  const bySource = new Map<ComplianceConsentSource, { granted: number; refused: number }>([
    ['booking_page', tally()],
    ['contacts_page', tally()],
    ['other', tally()],
  ])
  const total = tally()
  for (const r of rows) {
    const key = r.granted ? 'granted' : 'refused'
    const ch = byChannel.get(r.channel) ?? tally()
    ch[key] += r.n
    byChannel.set(r.channel, ch)
    const src = bySource.get(r.source) ?? tally()
    src[key] += r.n
    bySource.set(r.source, src)
    total[key] += r.n
  }
  return {
    byChannel: [...byChannel].map(([channel, t]) => ({ channel, ...t })),
    bySource: [...bySource].map(([source, t]) => ({ source, ...t })),
    total,
  }
}

// ---------------------------------------------------------------------------
// 2. Suppressions, by the path that recorded them
// ---------------------------------------------------------------------------

/** `unrecorded` is a NULL source: a row written before 0018 tracked it. */
export type ComplianceSuppressionSource = SuppressionSource | 'unrecorded'

export interface ComplianceSuppressions {
  /** Every source, in a fixed order, zeros included. */
  readonly bySource: readonly { readonly source: ComplianceSuppressionSource; readonly n: number }[]
  readonly total: number
}

/** `since: null` is all time. */
export async function complianceSuppressionsBySource(
  db: AgencyDb,
  orgId: string,
  since: Date | null,
): Promise<ComplianceSuppressions> {
  const rows = await db
    .select({ source: schema.suppressions.source, n: sql<number>`count(*)::int` })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.orgId, orgId),
        since ? gte(schema.suppressions.createdAt, since) : undefined,
      ),
    )
    .groupBy(schema.suppressions.source)

  const counts = new Map<ComplianceSuppressionSource, number>(
    [...SUPPRESSION_SOURCES, 'unrecorded' as const].map((s) => [s, 0]),
  )
  let total = 0
  for (const r of rows) {
    const key = (r.source ?? 'unrecorded') as ComplianceSuppressionSource
    counts.set(key, (counts.get(key) ?? 0) + r.n)
    total += r.n
  }
  return { bySource: [...counts].map(([source, n]) => ({ source, n })), total }
}

// ---------------------------------------------------------------------------
// 3. Refusals, by the rule that refused
// ---------------------------------------------------------------------------

/**
 * Whether a person could legitimately resolve each refusal by deciding —
 * `decideSend`'s own `humanCanResolve`, restated per code because the row
 * stores the code and not the decision. `compliance.test.ts` drives
 * `decideSend` into every code it can produce and asserts the two agree, so
 * this cannot drift from the rule it describes.
 *
 * `no_consent` is unreachable behind step 0 and refuses without a human, as
 * `decideSend` writes it. `bounced` is MASTER-PLAN §9.4's (wave 3): an address
 * that bounced is corrected by a person.
 */
export const COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE: Readonly<Record<SendRefusalCode | 'bounced', boolean>> = {
  unparseable_recipient: true,
  suppressed: false,
  cold_channel_forbidden: false,
  no_consent: false,
  consent_revoked: false,
  stale_evidence: false,
  quiet_hours: true,
  unknown_timezone: true,
  daily_cap: true,
  campaign_inactive: true,
  needs_approval: true,
  bounced: true,
}

/** True, false, or null for a code this revision does not know. */
export function complianceHumanCanResolve(code: string): boolean | null {
  return Object.prototype.hasOwnProperty.call(COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE, code)
    ? COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE[code as SendRefusalCode | 'bounced']
    : null
}

export interface ComplianceRefusalRow {
  readonly touchId: string
  readonly code: string
  readonly channel: string
  readonly companyDomain: string | null
  readonly at: Date
}

export interface ComplianceRefusals {
  readonly byCode: readonly { readonly code: string; readonly n: number; readonly humanCanResolve: boolean | null }[]
  readonly total: number
  /** Refusals a person could resolve by deciding (a zone, a cap, a draft). */
  readonly humanCanResolve: number
  /** Refusals nobody may approve past: an opt-out, a refusal, a cold channel. */
  readonly noOneCanOverride: number
  /** A code this revision has no entry for — shown, never folded into either. */
  readonly unknownCode: number
  /** The newest refused rows, for the page to link. */
  readonly recent: readonly ComplianceRefusalRow[]
}

/**
 * Refused touches by code. "When" is when the row was REFUSED — its last
 * update — not when it was drafted: a draft written in August and refused
 * yesterday is yesterday's refusal. `refused` is terminal, so nothing
 * updates the row afterwards.
 */
export async function complianceRefusalsByCode(
  db: AgencyDb,
  orgId: string,
  since: Date | null,
  recentLimit = 50,
): Promise<ComplianceRefusals> {
  const refusedAt = sql<Date>`coalesce(${schema.touches.updatedAt}, ${schema.touches.createdAt})`
  const where = and(
    eq(schema.touches.orgId, orgId),
    eq(schema.touches.status, 'refused'),
    since
      ? or(
          gte(schema.touches.updatedAt, since),
          and(isNull(schema.touches.updatedAt), gte(schema.touches.createdAt, since)),
        )
      : undefined,
  )
  const [rows, recent] = await Promise.all([
    db
      .select({ code: schema.touches.refusalCode, n: sql<number>`count(*)::int` })
      .from(schema.touches)
      .where(where)
      .groupBy(schema.touches.refusalCode),
    db
      .select({
        touchId: schema.touches.id,
        code: schema.touches.refusalCode,
        channel: schema.touches.channel,
        companyDomain: schema.companies.domain,
        createdAt: schema.touches.createdAt,
        updatedAt: schema.touches.updatedAt,
      })
      .from(schema.touches)
      .leftJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.touches.companyId), eq(schema.companies.orgId, orgId)),
      )
      .where(where)
      .orderBy(desc(refusedAt))
      .limit(recentLimit),
  ])

  let total = 0
  let resolvable = 0
  let final = 0
  let unknown = 0
  const byCode = rows
    .map((r) => {
      // touches_refusal_is_explained makes a NULL code on a refused row
      // impossible; the fallback is for the type, not for the data.
      const code = r.code ?? 'unexplained'
      const human = complianceHumanCanResolve(code)
      total += r.n
      if (human === true) resolvable += r.n
      else if (human === false) final += r.n
      else unknown += r.n
      return { code, n: r.n, humanCanResolve: human }
    })
    .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code))

  return {
    byCode,
    total,
    humanCanResolve: resolvable,
    noOneCanOverride: final,
    unknownCode: unknown,
    recent: recent.map((r) => ({
      touchId: r.touchId,
      code: r.code ?? 'unexplained',
      channel: r.channel,
      companyDomain: r.companyDomain ?? null,
      at: r.updatedAt ?? r.createdAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// 4. The AI disclosure on calls
// ---------------------------------------------------------------------------

export interface ComplianceDisclosure {
  /** Every call on record, answered or not — the denominator's denominator. */
  readonly calls: number
  /** Inbound calls that were answered: the calls that had to disclose. */
  readonly answeredInbound: number
  /** `callsThatDidNotDisclose()` — must be empty. */
  readonly undisclosed: readonly {
    readonly id: string
    readonly startedAt: Date | null
    readonly answeredAt: Date | null
    readonly outcome: string | null
    readonly status: string
  }[]
}

/**
 * The rows are `callsThatDidNotDisclose()`'s, not a second query for the
 * same thing: that function is the audit CLAUDE.md's Voice section says
 * could once never fire, and a restatement here would be one more place for
 * that to happen again.
 */
export async function complianceDisclosure(db: AgencyDb, orgId: string): Promise<ComplianceDisclosure> {
  const [undisclosed, counts] = await Promise.all([
    callsThatDidNotDisclose(db, orgId),
    db
      .select({
        calls: sql<number>`count(*)::int`,
        answeredInbound: sql<number>`(count(*) FILTER (WHERE ${schema.calls.direction} = 'in' AND ${schema.calls.answeredAt} IS NOT NULL))::int`,
      })
      .from(schema.calls)
      .where(eq(schema.calls.orgId, orgId)),
  ])
  return {
    calls: counts[0]?.calls ?? 0,
    answeredInbound: counts[0]?.answeredInbound ?? 0,
    undisclosed: undisclosed.map((c) => ({
      id: c.id,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      outcome: c.outcome,
      status: c.status,
    })),
  }
}

// ---------------------------------------------------------------------------
// 5. Evidence freshness
// ---------------------------------------------------------------------------

/**
 * Where a company's evidence stands, from its LATEST scan: none at all, a
 * scan that could not reach the site, one older than the ICP's threshold, or
 * one inside it. Four buckets that always add up to the company count.
 */
export type ComplianceEvidenceState = 'never_scanned' | 'unreachable' | 'stale' | 'fresh'

export interface ComplianceFreshness {
  readonly staleDays: number
  readonly total: number
  readonly neverScanned: number
  readonly unreachable: number
  readonly stale: number
  readonly fresh: number
  /**
   * Of the `stale` companies, how many have a latest scan whose findings
   * still carry `findings.stale = false`. The column is a cache written only
   * when somebody runs a scan; this is how far behind it is right now.
   */
  readonly staleColumnSaysFresh: number
  /** Every company that is not fresh, worst first, then by domain. */
  readonly notFresh: readonly {
    readonly companyId: string
    readonly domain: string
    readonly name: string | null
    readonly state: Exclude<ComplianceEvidenceState, 'fresh'>
    readonly lastScanAt: Date | null
  }[]
}

const STATE_ORDER: Readonly<Record<ComplianceEvidenceState, number>> = {
  never_scanned: 0, unreachable: 1, stale: 2, fresh: 3,
}

export async function complianceEvidenceFreshness(
  db: AgencyDb,
  orgId: string,
  staleDays: number,
  now: Date,
): Promise<ComplianceFreshness> {
  const [companies, latest] = await Promise.all([
    db
      .select({ id: schema.companies.id, domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.orgId, orgId))
      .orderBy(asc(schema.companies.domain)),
    db
      .selectDistinctOn([schema.scans.companyId], {
        companyId: schema.scans.companyId,
        scanId: schema.scans.id,
        ranAt: schema.scans.ranAt,
        ok: schema.scans.ok,
      })
      .from(schema.scans)
      .where(eq(schema.scans.orgId, orgId))
      .orderBy(schema.scans.companyId, desc(schema.scans.ranAt)),
  ])
  const latestFor = new Map(latest.map((s) => [s.companyId, s]))

  const counts: Record<ComplianceEvidenceState, number> = { never_scanned: 0, unreachable: 0, stale: 0, fresh: 0 }
  const notFresh: ComplianceFreshness['notFresh'][number][] = []
  const staleScanIds: string[] = []
  for (const c of companies) {
    const scan = latestFor.get(c.id)
    const state: ComplianceEvidenceState = !scan
      ? 'never_scanned'
      : !scan.ok
        ? 'unreachable'
        : isStale(scan.ranAt, staleDays, now)
          ? 'stale'
          : 'fresh'
    counts[state] += 1
    if (state === 'stale' && scan) staleScanIds.push(scan.scanId)
    if (state !== 'fresh') {
      notFresh.push({ companyId: c.id, domain: c.domain, name: c.name, state, lastScanAt: scan?.ranAt ?? null })
    }
  }
  notFresh.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.domain.localeCompare(b.domain))

  let staleColumnSaysFresh = 0
  if (staleScanIds.length > 0) {
    const cached = await db
      .selectDistinct({ scanId: schema.findings.scanId })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.orgId, orgId),
          eq(schema.findings.stale, false),
          inArray(schema.findings.scanId, staleScanIds),
        ),
      )
    staleColumnSaysFresh = cached.length
  }

  return {
    staleDays,
    total: companies.length,
    neverScanned: counts.never_scanned,
    unreachable: counts.unreachable,
    stale: counts.stale,
    fresh: counts.fresh,
    staleColumnSaysFresh,
    notFresh,
  }
}

// ---------------------------------------------------------------------------
// 6. Drafts awaiting approval on evidence that is stale or missing
// ---------------------------------------------------------------------------

export interface ComplianceDraftOnStaleEvidence {
  readonly touchId: string
  readonly companyId: string
  readonly domain: string
  readonly channel: string
  readonly createdAt: Date
  /** `no_evidence`: the company has no successful scan at all. */
  readonly why: 'stale' | 'no_evidence'
  readonly lastOkScanAt: Date | null
  /**
   * An answer to a reply (0018) — a person wrote it, in answer to what the
   * company said. Listed and tagged rather than left out: nothing marks
   * which of its words came from the scan.
   */
  readonly answersReply: boolean
}

export interface ComplianceDraftsOnStaleEvidence {
  /** Every outbound draft awaiting a person, about a company or not. */
  readonly awaiting: number
  readonly count: number
  readonly rows: readonly ComplianceDraftOnStaleEvidence[]
}

/**
 * §2.2: stale findings "must be re-verified before appearing in any outbound
 * draft". Measured the way `quotableFindings` measures it — the company's
 * most recent SUCCESSFUL scan, aged with `isStale()` from `ran_at` — so this
 * lists exactly the drafts whose company the draft generator could not quote
 * today. A draft names its company directly, or through its contact.
 */
export async function complianceDraftsOnStaleEvidence(
  db: AgencyDb,
  orgId: string,
  staleDays: number,
  now: Date,
): Promise<ComplianceDraftsOnStaleEvidence> {
  const companyId = sql<string | null>`coalesce(${schema.touches.companyId}, ${schema.contacts.companyId})`
  const drafts = await db
    .select({
      touchId: schema.touches.id,
      companyId,
      channel: schema.touches.channel,
      createdAt: schema.touches.createdAt,
      answersTouchId: schema.touches.answersTouchId,
    })
    .from(schema.touches)
    .leftJoin(
      schema.contacts,
      and(eq(schema.contacts.id, schema.touches.contactId), eq(schema.contacts.orgId, orgId)),
    )
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.status, 'awaiting_approval'),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))

  const companyIds = [...new Set(drafts.map((d) => d.companyId).filter((id): id is string => Boolean(id)))]
  if (companyIds.length === 0) return { awaiting: drafts.length, count: 0, rows: [] }

  const [companies, lastOk] = await Promise.all([
    db
      .select({ id: schema.companies.id, domain: schema.companies.domain })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), inArray(schema.companies.id, companyIds))),
    db
      .selectDistinctOn([schema.scans.companyId], { companyId: schema.scans.companyId, ranAt: schema.scans.ranAt })
      .from(schema.scans)
      .where(
        and(
          eq(schema.scans.orgId, orgId),
          eq(schema.scans.ok, true),
          inArray(schema.scans.companyId, companyIds),
        ),
      )
      .orderBy(schema.scans.companyId, desc(schema.scans.ranAt)),
  ])
  const domainOf = new Map(companies.map((c) => [c.id, c.domain]))
  const lastOkAt = new Map(lastOk.map((s) => [s.companyId, s.ranAt]))

  const rows: ComplianceDraftOnStaleEvidence[] = []
  for (const d of drafts) {
    if (!d.companyId) continue
    const domain = domainOf.get(d.companyId)
    if (!domain) continue
    const ranAt = lastOkAt.get(d.companyId) ?? null
    const why = ranAt === null ? 'no_evidence' : isStale(ranAt, staleDays, now) ? 'stale' : null
    if (!why) continue
    rows.push({
      touchId: d.touchId,
      companyId: d.companyId,
      domain,
      channel: d.channel,
      createdAt: d.createdAt,
      why,
      lastOkScanAt: ranAt,
      answersReply: d.answersTouchId !== null,
    })
  }
  return { awaiting: drafts.length, count: rows.length, rows }
}

// ---------------------------------------------------------------------------
// 7. Voice / SMS / WhatsApp that went out without a granted consent row
// ---------------------------------------------------------------------------

/** The channels §2.1 allows only with a recorded opt-in. */
const OPT_IN_CHANNELS = ['sms', 'voice', 'whatsapp'] as const

/**
 * A message "went out" when the row says so: a send time, or a status only
 * a provider's answer produces. `sending` (a claim in flight) and `failed`
 * are not counted as sent — and a REFUSED row is the send path doing its
 * job, counted apart as `stoppedBySendPath`, never as a breach.
 */
const WENT_OUT_STATUSES = ['sent', 'delivered', 'bounced', 'replied'] as const

export interface ComplianceColdOptInRow {
  readonly touchId: string
  readonly contactId: string | null
  readonly companyDomain: string | null
  readonly channel: string
  readonly status: string
  readonly sentAt: Date | null
  /**
   * The consent row as it stands TODAY. `refused` with a `consentRecordedAt`
   * after `sentAt` is a person who said no after the message — the ledger
   * keeps the current answer, not its history. `contact_erased`: the contact
   * row is gone and its consent rows with it, so nothing can be checked.
   */
  readonly consentNow: 'never_asked' | 'refused' | 'contact_erased'
  readonly consentRecordedAt: Date | null
}

export interface ComplianceColdOptIn {
  /** Distinct contacts still on file with such a touch. Must be zero. */
  readonly contacts: number
  readonly touches: number
  readonly rows: readonly ComplianceColdOptInRow[]
  /** Opt-in-only messages the send path REFUSED — the gate working. */
  readonly stoppedBySendPath: number
  /** The newest of those, for the page to link. */
  readonly stoppedRows: readonly ComplianceRefusalRow[]
}

export async function complianceColdOptInTouches(
  db: AgencyDb,
  orgId: string,
  stoppedLimit = 50,
): Promise<ComplianceColdOptIn> {
  const stoppedWhere = and(
    eq(schema.touches.orgId, orgId),
    eq(schema.touches.direction, 'out'),
    eq(schema.touches.status, 'refused'),
    inArray(schema.touches.refusalCode, ['cold_channel_forbidden', 'no_consent']),
  )
  const [rows, stopped, stoppedRows] = await Promise.all([
    db
      .select({
        touchId: schema.touches.id,
        contactId: schema.touches.contactId,
        companyDomain: schema.companies.domain,
        channel: schema.touches.channel,
        status: schema.touches.status,
        sentAt: schema.touches.sentAt,
        consentGranted: schema.consents.granted,
        consentRecordedAt: schema.consents.recordedAt,
      })
      .from(schema.touches)
      .leftJoin(
        schema.contacts,
        and(eq(schema.contacts.id, schema.touches.contactId), eq(schema.contacts.orgId, orgId)),
      )
      .leftJoin(
        schema.companies,
        and(
          eq(schema.companies.id, sql`coalesce(${schema.touches.companyId}, ${schema.contacts.companyId})`),
          eq(schema.companies.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.consents,
        and(
          eq(schema.consents.contactId, schema.touches.contactId),
          eq(schema.consents.channel, schema.touches.channel),
          eq(schema.consents.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(schema.touches.orgId, orgId),
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.channel, [...OPT_IN_CHANNELS]),
          or(isNotNull(schema.touches.sentAt), inArray(schema.touches.status, [...WENT_OUT_STATUSES])),
          or(isNull(schema.consents.id), eq(schema.consents.granted, false)),
        ),
      )
      .orderBy(desc(schema.touches.createdAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.touches).where(stoppedWhere),
    db
      .select({
        touchId: schema.touches.id,
        code: schema.touches.refusalCode,
        channel: schema.touches.channel,
        companyDomain: schema.companies.domain,
        createdAt: schema.touches.createdAt,
        updatedAt: schema.touches.updatedAt,
      })
      .from(schema.touches)
      .leftJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.touches.companyId), eq(schema.companies.orgId, orgId)),
      )
      .where(stoppedWhere)
      .orderBy(desc(sql`coalesce(${schema.touches.updatedAt}, ${schema.touches.createdAt})`))
      .limit(stoppedLimit),
  ])

  const out: ComplianceColdOptInRow[] = rows.map((r) => ({
    touchId: r.touchId,
    contactId: r.contactId,
    companyDomain: r.companyDomain ?? null,
    channel: r.channel,
    status: r.status,
    sentAt: r.sentAt,
    consentNow: r.contactId === null ? 'contact_erased' : r.consentGranted === false ? 'refused' : 'never_asked',
    consentRecordedAt: r.consentRecordedAt ?? null,
  }))
  const contacts = new Set(out.map((r) => r.contactId).filter((id): id is string => id !== null))
  return {
    contacts: contacts.size,
    touches: out.length,
    rows: out,
    stoppedBySendPath: stopped[0]?.n ?? 0,
    stoppedRows: stoppedRows.map((r) => ({
      touchId: r.touchId,
      code: r.code ?? 'unexplained',
      channel: r.channel,
      companyDomain: r.companyDomain ?? null,
      at: r.updatedAt ?? r.createdAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// Opt-outs that did not reach the suppression list
// ---------------------------------------------------------------------------

export interface ComplianceOptOutNotRecordedRow {
  readonly auditId: string
  readonly at: Date
  readonly channel: string | null
  /** The reason CLASS the writer recorded — never an address (§2.3). */
  readonly why: string | null
  readonly companyDomain: string | null
}

export interface ComplianceOptOutsNotRecorded {
  readonly count: number
  readonly rows: readonly ComplianceOptOutNotRecordedRow[]
}

/**
 * `contact.opt_out_not_recorded` audit rows: every time a writer knew an
 * opt-out had failed to store (§2.1's Phase 4 obligation). The count is
 * history — it stays after somebody records the suppression by hand; the
 * next block is what is still outstanding.
 */
export async function complianceOptOutsNotRecorded(
  db: AgencyDb,
  orgId: string,
  since: Date | null,
  limit = 50,
): Promise<ComplianceOptOutsNotRecorded> {
  const where = and(
    eq(schema.auditLog.orgId, orgId),
    eq(schema.auditLog.action, 'contact.opt_out_not_recorded'),
    since ? gte(schema.auditLog.createdAt, since) : undefined,
  )
  const [counted, rows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLog).where(where),
    db
      .select({
        auditId: schema.auditLog.id,
        at: schema.auditLog.createdAt,
        channel: sql<string | null>`${schema.auditLog.detail}->>'channel'`,
        why: sql<string | null>`coalesce(${schema.auditLog.detail}->>'why', ${schema.auditLog.detail}->>'path')`,
        companyDomain: schema.companies.domain,
      })
      .from(schema.auditLog)
      .leftJoin(
        schema.contacts,
        and(
          eq(schema.auditLog.subjectType, 'contact'),
          eq(schema.contacts.id, schema.auditLog.subjectId),
          eq(schema.contacts.orgId, orgId),
        ),
      )
      .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
      .where(where)
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit),
  ])
  return {
    count: counted[0]?.n ?? 0,
    rows: rows.map((r) => ({ ...r, companyDomain: r.companyDomain ?? null })),
  }
}

export interface ComplianceOptOutWithoutSuppressionRow {
  readonly kind: 'reply' | 'call'
  /** The touch id for a reply, the call id for a call. */
  readonly id: string
  readonly at: Date
  readonly channel: string
  /**
   * `unreadable`: the address or number could not be normalised, so NO
   * suppression row could ever match it — never "clear" (§2.1).
   */
  readonly why: 'no_matching_row' | 'unreadable'
  readonly companyDomain: string | null
}

export interface ComplianceOptOutsWithoutSuppression {
  readonly count: number
  readonly replies: number
  readonly calls: number
  readonly rows: readonly ComplianceOptOutWithoutSuppressionRow[]
}

const CHANNELS: ReadonlySet<string> = new Set<Channel>(['email', 'linkedin', 'sms', 'voice', 'whatsapp'])

/**
 * Every recorded opt-out — a reply the opt-out reader classed `opted_out`,
 * a call with `opted_out_at` — checked against the suppression list TODAY,
 * with the send path's own keys (`suppressionKeysFor`: an address is
 * matched by itself and by its domain). Must be zero. A row here is a person
 * who asked to be left alone and whom the send path would not stop.
 */
export async function complianceOptOutsWithoutSuppression(
  db: AgencyDb,
  orgId: string,
): Promise<ComplianceOptOutsWithoutSuppression> {
  const [replies, calls] = await Promise.all([
    db
      .select({
        id: schema.touches.id,
        at: schema.touches.createdAt,
        channel: schema.touches.channel,
        recipient: schema.touches.recipient,
        companyDomain: schema.companies.domain,
      })
      .from(schema.touches)
      .leftJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.touches.companyId), eq(schema.companies.orgId, orgId)),
      )
      .where(
        and(
          eq(schema.touches.orgId, orgId),
          eq(schema.touches.direction, 'in'),
          eq(schema.touches.replyKind, 'opted_out'),
        ),
      ),
    db
      .select({
        id: schema.calls.id,
        at: schema.calls.optedOutAt,
        direction: schema.calls.direction,
        fromNumber: schema.calls.fromNumber,
        toNumber: schema.calls.toNumber,
        companyDomain: schema.companies.domain,
      })
      .from(schema.calls)
      .leftJoin(
        schema.companies,
        and(eq(schema.companies.id, schema.calls.companyId), eq(schema.companies.orgId, orgId)),
      )
      .where(and(eq(schema.calls.orgId, orgId), isNotNull(schema.calls.optedOutAt))),
  ])

  type Candidate = Omit<ComplianceOptOutWithoutSuppressionRow, 'why'> & {
    readonly keys: readonly { kind: string; value: string }[] | null
  }
  const candidates: Candidate[] = [
    ...replies.map((r): Candidate => ({
      kind: 'reply',
      id: r.id,
      at: r.at,
      channel: r.channel,
      companyDomain: r.companyDomain ?? null,
      keys: CHANNELS.has(r.channel) ? suppressionKeysFor(r.recipient ?? '', r.channel as Channel) : null,
    })),
    ...calls.map((c): Candidate => {
      // The number that asked: the caller on an inbound call, the callee on
      // an outbound one — the same number `recordOptOut` was handed.
      const phone = normalisePhone((c.direction === 'in' ? c.fromNumber : c.toNumber) ?? '')
      return {
        kind: 'call',
        id: c.id,
        at: c.at ?? new Date(0),
        channel: 'voice',
        companyDomain: c.companyDomain ?? null,
        keys: phone ? [{ kind: 'phone', value: phone }] : null,
      }
    }),
  ]

  const values = [...new Set(candidates.flatMap((c) => (c.keys ?? []).map((k) => k.value)))]
  const onList = new Set<string>()
  if (values.length > 0) {
    const found = await db
      .select({ kind: schema.suppressions.kind, value: schema.suppressions.value })
      .from(schema.suppressions)
      .where(and(eq(schema.suppressions.orgId, orgId), inArray(schema.suppressions.value, values)))
    for (const s of found) onList.add(`${s.kind}\u0000${s.value}`)
  }

  const rows: ComplianceOptOutWithoutSuppressionRow[] = []
  for (const { keys, ...c } of candidates) {
    if (keys === null) {
      rows.push({ ...c, why: 'unreadable' })
    } else if (!keys.some((k) => onList.has(`${k.kind}\u0000${k.value}`))) {
      rows.push({ ...c, why: 'no_matching_row' })
    }
  }
  rows.sort((a, b) => b.at.getTime() - a.at.getTime())
  return {
    count: rows.length,
    replies: rows.filter((r) => r.kind === 'reply').length,
    calls: rows.filter((r) => r.kind === 'call').length,
    rows,
  }
}

// ---------------------------------------------------------------------------
// 8. Approvals decided after they expired — informational
// ---------------------------------------------------------------------------

export interface ComplianceLateApprovals {
  readonly count: number
  readonly rows: readonly {
    readonly id: string
    readonly toolName: string
    readonly status: string
    readonly decidedAt: Date | null
    readonly expiresAt: Date
  }[]
}

/**
 * Decided rows whose `decided_at` is past their `expires_at`. NOT a breach:
 * `decideApproval` refuses a lapsed row and answers a clean `expired`, and
 * 0004 deliberately leaves the state storable. Informational, against
 * today's rows.
 */
export async function complianceLateApprovals(db: AgencyDb, orgId: string): Promise<ComplianceLateApprovals> {
  const rows = await db
    .select({
      id: schema.approvals.id,
      toolName: schema.approvals.toolName,
      status: schema.approvals.status,
      decidedAt: schema.approvals.decidedAt,
      expiresAt: schema.approvals.expiresAt,
    })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, orgId),
        inArray(schema.approvals.status, ['approved', 'denied']),
        isNotNull(schema.approvals.decidedAt),
        gt(schema.approvals.decidedAt, schema.approvals.expiresAt),
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt))
  return { count: rows.length, rows }
}

// ---------------------------------------------------------------------------
// 9. auto_send on a channel other than email or LinkedIn
// ---------------------------------------------------------------------------

/**
 * The predicate, as text, so the page can print EXACTLY what ran. It is a
 * constant with no input in it, which is why `sql.raw` is safe here.
 */
export const COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE = "auto_send AND channel NOT IN ('email', 'linkedin')"

/** The CHECK that makes the answer zero (0004). */
export const COMPLIANCE_AUTO_SEND_CONSTRAINT = 'campaigns_no_auto_send_on_voice_or_sms'

export interface ComplianceAutoSendOffCold {
  readonly where: string
  readonly constraint: string
  readonly count: number
  readonly rows: readonly { readonly id: string; readonly name: string; readonly channel: string }[]
}

/**
 * The schema already makes this impossible; the page shows the query and
 * its zero anyway, because "impossible" is a claim and the query is the
 * check. `compliance.test.ts` evaluates the same predicate over rows that
 * WOULD match, so it is not a query that cannot report failure.
 */
export async function complianceAutoSendOffCold(db: AgencyDb, orgId: string): Promise<ComplianceAutoSendOffCold> {
  const rows = await db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name, channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, orgId), sql.raw(COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE)))
    .orderBy(asc(schema.campaigns.name))
  return {
    where: COMPLIANCE_AUTO_SEND_OFF_COLD_WHERE,
    constraint: COMPLIANCE_AUTO_SEND_CONSTRAINT,
    count: rows.length,
    rows,
  }
}

// ---------------------------------------------------------------------------
// Everything, once
// ---------------------------------------------------------------------------

export interface ComplianceSummary {
  readonly generatedAt: Date
  readonly windowDays: number
  readonly since: Date
  readonly disclosure: ComplianceDisclosure
  readonly optOuts: {
    readonly withoutSuppression: ComplianceOptOutsWithoutSuppression
    readonly notRecorded: { readonly lastWindow: ComplianceOptOutsNotRecorded; readonly allTime: number }
  }
  readonly coldOptIn: ComplianceColdOptIn
  readonly draftsOnStaleEvidence: ComplianceDraftsOnStaleEvidence
  readonly consents: ComplianceConsents
  readonly suppressions: { readonly lastWindow: ComplianceSuppressions; readonly allTime: ComplianceSuppressions }
  readonly refusals: ComplianceRefusals
  readonly freshness: ComplianceFreshness
  readonly lateApprovals: ComplianceLateApprovals
  readonly autoSendOffCold: ComplianceAutoSendOffCold
}

/**
 * Every block the page shows, for one org, as of `now`. The page and the
 * `get_compliance_summary` tool both read this, so they cannot disagree.
 */
export async function complianceSummary(
  db: AgencyDb,
  orgId: string,
  opts: { readonly staleDays: number; readonly now: Date },
): Promise<ComplianceSummary> {
  const since = new Date(opts.now.getTime() - COMPLIANCE_WINDOW_DAYS * MS_PER_DAY)
  const [
    disclosure, withoutSuppression, notRecordedWindow, notRecordedAll, coldOptIn, drafts,
    consents, suppressionsWindow, suppressionsAll, refusals, freshness, lateApprovals, autoSendOffCold,
  ] = await Promise.all([
    complianceDisclosure(db, orgId),
    complianceOptOutsWithoutSuppression(db, orgId),
    complianceOptOutsNotRecorded(db, orgId, since),
    complianceOptOutsNotRecorded(db, orgId, null, 0),
    complianceColdOptInTouches(db, orgId),
    complianceDraftsOnStaleEvidence(db, orgId, opts.staleDays, opts.now),
    complianceConsentsByChannel(db, orgId),
    complianceSuppressionsBySource(db, orgId, since),
    complianceSuppressionsBySource(db, orgId, null),
    complianceRefusalsByCode(db, orgId, since),
    complianceEvidenceFreshness(db, orgId, opts.staleDays, opts.now),
    complianceLateApprovals(db, orgId),
    complianceAutoSendOffCold(db, orgId),
  ])
  return {
    generatedAt: opts.now,
    windowDays: COMPLIANCE_WINDOW_DAYS,
    since,
    disclosure,
    optOuts: {
      withoutSuppression,
      notRecorded: { lastWindow: notRecordedWindow, allTime: notRecordedAll.count },
    },
    coldOptIn,
    draftsOnStaleEvidence: drafts,
    consents,
    suppressions: { lastWindow: suppressionsWindow, allTime: suppressionsAll },
    refusals,
    freshness,
    lateApprovals,
    autoSendOffCold,
  }
}
