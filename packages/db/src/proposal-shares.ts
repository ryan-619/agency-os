/**
 * Buyer links to a proposal (0018, PROMPT.md §8.6).
 *
 * A share link is the proposal's own stored document behind an unguessable,
 * revocable address, and an Accept that is the same `setProposalStatus` a
 * person clicks on the proposal page. It is the second place a stranger
 * writes to the database — the booking page is the first — and it keeps the
 * booking page's rules: nothing about the org is revealed beyond its display
 * name, nothing enumerable is returned, and every write is bounded.
 *
 * ## The token (§2.3)
 *
 * 32 random bytes, base64url. It is a bearer credential: whoever holds it can
 * read the proposal and accept it. So it is returned ONCE, by `shareMint`, and
 * never stored — the row holds its sha256, and `proposal_shares_token_hash_shape`
 * makes a raw token unstorable. A lookup hashes what it was given, finds the
 * row by the hash and then compares the two hashes in constant time; the
 * token itself is never logged, audited or echoed.
 *
 * ## What may be minted (§2.4, §2.2)
 *
 * Only a proposal a person has already marked `sent`. The human act that
 * makes a proposal outbound is that explicit decision, and minting a link is
 * not allowed to be a second, implicit way of making it — a draft is refused
 * rather than promoted. And only while the evidence is fresh: stale findings
 * are re-verified before they appear in anything outbound.
 *
 * Freshness is checked at mint AND on every read. A link lives up to thirty
 * days and a scan goes stale after the ICP's `stale_after_days` (fourteen by
 * default), so a link minted on day 13 would otherwise show — and accept — a
 * document whose evidence aged out a day later. Two things close that:
 * `expires_at` is capped at the moment the evidence goes stale, and the read
 * and the accept re-derive `isStale(scan.ran_at)` regardless, because the
 * ICP's threshold can be lowered after a link was minted. A buyer arriving
 * after either is told the proposal is being re-verified; the word "stale" is
 * the team's, never the buyer's.
 *
 * ## Views
 *
 * A count and two instants. Never an IP, never a user agent. A view is a
 * fetch of the page, so a mail client's link preview counts as one: the
 * number says the link was opened, not that a person read it.
 *
 * Nothing here sends anything. The link reaches the buyer in a message a
 * person writes, from their own mail.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { activeIcpProfile } from './repository.js'
import { appendAudit } from './approvals.js'
import { setProposalStatus } from './proposals.js'

/** The longest a link lives, and the default. */
export const SHARE_TTL_DAYS = 30

/** The most an accepting name may be — the booking page's bound for a name. */
export const SHARE_NAME_MAX = 120

/**
 * What a token looks like: 32 bytes as unpadded base64url is 43 characters.
 * Anything else is answered as unknown without a query.
 */
export const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

const MS_PER_DAY = 86_400_000

/** A share as the team sees it. The hash stays in this module. */
export interface ShareSummary {
  readonly id: string
  readonly proposalId: string
  readonly createdBy: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
  readonly viewCount: number
  readonly firstViewedAt: Date | null
  readonly lastViewedAt: Date | null
  readonly acceptedAt: Date | null
  readonly acceptedByName: string | null
}

const summary = {
  id: schema.proposalShares.id,
  proposalId: schema.proposalShares.proposalId,
  createdBy: schema.proposalShares.createdBy,
  createdAt: schema.proposalShares.createdAt,
  expiresAt: schema.proposalShares.expiresAt,
  revokedAt: schema.proposalShares.revokedAt,
  viewCount: schema.proposalShares.viewCount,
  firstViewedAt: schema.proposalShares.firstViewedAt,
  lastViewedAt: schema.proposalShares.lastViewedAt,
  acceptedAt: schema.proposalShares.acceptedAt,
  acceptedByName: schema.proposalShares.acceptedByName,
} as const

/** sha256 of the token, lower-case hex — the only form of it a row may hold. */
export function shareHashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The two hashes compared in constant time, after the index found the row. */
function hashesMatch(stored: string, given: string): boolean {
  const a = Buffer.from(stored, 'hex')
  const b = Buffer.from(given, 'hex')
  return a.length === 32 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The org's `stale_after_days`, read the way the proposal page reads it: the
 * active ICP's, or the default when there is none or it will not parse.
 */
async function staleAfterDaysFor(db: AgencyDb, orgId: string): Promise<number> {
  const row = await activeIcpProfile(db, orgId)
  if (!row) return DEFAULT_STALE_AFTER_DAYS
  try {
    return parseIcpDefinition(row.definition).freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS
  } catch {
    return DEFAULT_STALE_AFTER_DAYS
  }
}

async function scanRanAt(db: AgencyDb, orgId: string, scanId: string): Promise<Date | null> {
  const [scan] = await db
    .select({ ranAt: schema.scans.ranAt })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.id, scanId)))
    .limit(1)
  return scan?.ranAt ?? null
}

/**
 * A typed name, as it may be stored: control characters out, runs of
 * whitespace collapsed, trimmed, and cut at a code point rather than a
 * UTF-16 unit, so the bound never leaves half a character behind.
 */
export function shareNormaliseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const bounded = Array.from(cleaned).slice(0, SHARE_NAME_MAX).join('').trim()
  return bounded || null
}

// ---------------------------------------------------------------------------
// The team's side
// ---------------------------------------------------------------------------

export type ShareMintRefusal = 'not_found' | 'not_sent' | 'stale' | 'decided'
export type ShareMintResult =
  | {
      ok: true
      share: ShareSummary
      /** The bearer credential. Returned here ONCE and never stored; show it and forget it. */
      token: string
      /** True when the link ends when the evidence goes stale, before the full thirty days. */
      cappedByEvidence: boolean
    }
  | { ok: false; reason: ShareMintRefusal; message: string }

/**
 * Create a link for a proposal a person has already sent.
 *
 * Refuses a draft (`not_sent` — the link is not the send), a proposal that
 * has been decided (`decided`), and one whose evidence has aged out
 * (`stale`). The link expires after `ttlDays` or when the evidence goes
 * stale, whichever is first. The row and its audit line are written in one
 * transaction: a credential nobody can account for is not handed out.
 */
export async function shareMint(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly proposalId: string
    /** A users.id in the same org — the composite FK refuses anybody else. */
    readonly createdBy: string
    readonly actor: string
    readonly ttlDays?: number
    /** Defaults to the org's ICP, which is what every read re-derives from. */
    readonly staleAfterDays?: number
    readonly now?: Date
  },
): Promise<ShareMintResult> {
  const now = args.now ?? new Date()
  const ttlDays = args.ttlDays ?? SHARE_TTL_DAYS
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > SHARE_TTL_DAYS) {
    throw new Error(`ttlDays must be in (0, ${SHARE_TTL_DAYS}], got ${String(ttlDays)}`)
  }

  const [proposal] = await db
    .select({ id: schema.proposals.id, status: schema.proposals.status, scanId: schema.proposals.scanId, companyId: schema.proposals.companyId })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.orgId, args.orgId), eq(schema.proposals.id, args.proposalId)))
    .limit(1)
  if (!proposal) return { ok: false, reason: 'not_found', message: 'No such proposal.' }
  if (proposal.status === 'draft') {
    return {
      ok: false,
      reason: 'not_sent',
      message:
        'Mark the proposal as sent first. A link is a copy of what you sent, not the send — it cannot be the thing that makes a draft outbound.',
    }
  }
  if (proposal.status !== 'sent') {
    return {
      ok: false,
      reason: 'decided',
      message: `This proposal is ${proposal.status}. A new link would offer a decision that has already been made.`,
    }
  }

  const staleAfter = args.staleAfterDays ?? (await staleAfterDaysFor(db, args.orgId))
  const ranAt = await scanRanAt(db, args.orgId, proposal.scanId)
  // isStale is strict (`now - ran_at > stale_after`), so at exactly the
  // deadline it still says fresh — but a link that expires as it is created
  // is refused by `proposal_shares_expires_after_created`, so here that edge
  // counts as stale.
  const evidenceDeadline = ranAt ? new Date(ranAt.getTime() + staleAfter * MS_PER_DAY) : null
  if (!evidenceDeadline || isStale(ranAt, staleAfter, now) || evidenceDeadline.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: 'stale',
      message:
        'The evidence under this proposal has aged out: re-verify before it appears in anything outbound (§2.2). Re-scan the company and generate a fresh proposal; no link was created.',
    }
  }

  const byTtl = new Date(now.getTime() + ttlDays * MS_PER_DAY)
  const cappedByEvidence = evidenceDeadline.getTime() < byTtl.getTime()
  const expiresAt = cappedByEvidence ? evidenceDeadline : byTtl
  const token = randomBytes(32).toString('base64url')

  const share = await db.transaction(async (tx) => {
    const txDb = tx as unknown as AgencyDb
    const [row] = await txDb
      .insert(schema.proposalShares)
      .values({
        orgId: args.orgId,
        proposalId: proposal.id,
        tokenHash: shareHashToken(token),
        createdBy: args.createdBy,
        expiresAt,
        // The same clock as expires_at, so `proposal_shares_expires_after_created`
        // compares like with like rather than the database's now() with ours.
        createdAt: now,
      })
      .returning(summary)
    if (!row) throw new Error('share insert returned no row')
    await appendAudit(txDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'proposal.share_created',
      subjectType: 'proposal',
      subjectId: proposal.id,
      // Never the token, never its hash: the id is how the team names it.
      detail: { companyId: proposal.companyId, shareId: row.id, expiresAt: expiresAt.toISOString(), cappedByEvidence },
    })
    return row
  })

  return { ok: true, share, token, cappedByEvidence }
}

/**
 * Withdraw a link. The row stays — its views and any acceptance are history —
 * and every later read or accept answers as if it never existed. False when
 * there is no such live link in this org.
 */
export async function shareRevoke(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly shareId: string
    readonly actor: string
    /** When given, the share must belong to this proposal too — the route names one in its path. */
    readonly proposalId?: string
    readonly now?: Date
  },
): Promise<boolean> {
  const now = args.now ?? new Date()
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as AgencyDb
    const [row] = await txDb
      .update(schema.proposalShares)
      .set({ revokedAt: now })
      .where(and(
        eq(schema.proposalShares.orgId, args.orgId),
        eq(schema.proposalShares.id, args.shareId),
        ...(args.proposalId ? [eq(schema.proposalShares.proposalId, args.proposalId)] : []),
        isNull(schema.proposalShares.revokedAt),
      ))
      .returning({ id: schema.proposalShares.id, proposalId: schema.proposalShares.proposalId })
    if (!row) return false
    await appendAudit(txDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'proposal.share_revoked',
      subjectType: 'proposal',
      subjectId: row.proposalId,
      detail: { shareId: row.id },
    })
    return true
  })
}

/** Every link a proposal has had, newest first — revoked and expired ones included. */
export async function shareList(db: AgencyDb, orgId: string, proposalId: string): Promise<ShareSummary[]> {
  return db
    .select(summary)
    .from(schema.proposalShares)
    .where(and(eq(schema.proposalShares.orgId, orgId), eq(schema.proposalShares.proposalId, proposalId)))
    .orderBy(desc(schema.proposalShares.createdAt))
}

// ---------------------------------------------------------------------------
// The buyer's side — cross-org by design: the token is the authority
// ---------------------------------------------------------------------------

/**
 * The proposal as the buyer's page may use it: the stored document and the
 * status that decides whether Accept is offered. No id — not the proposal's,
 * the share's, the company's or the creator's — and no view counts: nothing
 * the page could leak by rendering it, and nothing to enumerate with.
 */
export interface ShareProposal {
  readonly status: string
  /** The generated `Proposal` from packages/core, as stored. Never regenerated. */
  readonly document: unknown
  readonly decidedAt: Date | null
}

export type ShareView =
  | {
      /**
       * `open` — the proposal is `sent` and this link has not accepted it:
       * the page offers Accept. `closed` — decided, or accepted through this
       * link: the page is read-only.
       */
      readonly state: 'open' | 'closed'
      readonly proposal: ShareProposal
      readonly company: { readonly domain: string; readonly name: string | null }
      readonly org: { readonly name: string }
      /** The scan's `ran_at`: the "based on a review of" date. */
      readonly evidenceAsOf: Date
    }
  | {
      /** The evidence aged out after the link was minted. No document; no view counted. */
      readonly state: 'reverifying'
      readonly org: { readonly name: string }
    }

interface ShareRow extends ShareSummary {
  readonly orgId: string
  readonly tokenHash: string
}

async function shareByToken(db: AgencyDb, token: string, lock = false): Promise<ShareRow | null> {
  if (!SHARE_TOKEN_SHAPE.test(token)) return null
  const hash = shareHashToken(token)
  const q = db
    .select({ ...summary, orgId: schema.proposalShares.orgId, tokenHash: schema.proposalShares.tokenHash })
    .from(schema.proposalShares)
    .where(eq(schema.proposalShares.tokenHash, hash))
    .limit(1)
  const [row] = lock ? await q.for('update') : await q
  if (!row || !hashesMatch(row.tokenHash, hash)) return null
  return row
}

/**
 * What the buyer's page shows, or null for a token that is unknown, revoked
 * or expired — the same null for all three, so the page cannot be used to
 * tell them apart.
 *
 * Counts the view in one UPDATE whose predicate repeats the liveness check,
 * so a link revoked between the read and the count is not counted and not
 * shown. A link whose evidence has aged out shows no document and counts
 * nothing: nobody saw the proposal.
 */
export async function shareReadByToken(db: AgencyDb, token: string, now: Date = new Date()): Promise<ShareView | null> {
  const row = await shareByToken(db, token)
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null

  const [proposal] = await db
    .select({
      status: schema.proposals.status,
      document: schema.proposals.document,
      decidedAt: schema.proposals.decidedAt,
      scanId: schema.proposals.scanId,
      companyId: schema.proposals.companyId,
    })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.orgId, row.orgId), eq(schema.proposals.id, row.proposalId)))
    .limit(1)
  if (!proposal) return null
  const [[company], [org]] = await Promise.all([
    db
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, row.orgId), eq(schema.companies.id, proposal.companyId)))
      .limit(1),
    db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, row.orgId)).limit(1),
  ])
  if (!company || !org) return null

  const ranAt = await scanRanAt(db, row.orgId, proposal.scanId)
  if (!ranAt || isStale(ranAt, await staleAfterDaysFor(db, row.orgId), now)) {
    return { state: 'reverifying', org: { name: org.name } }
  }

  const [counted] = await db
    .update(schema.proposalShares)
    .set({
      viewCount: sql`${schema.proposalShares.viewCount} + 1`,
      firstViewedAt: sql`coalesce(${schema.proposalShares.firstViewedAt}, ${now.toISOString()}::timestamptz)`,
      lastViewedAt: now,
    })
    .where(and(
      eq(schema.proposalShares.id, row.id),
      isNull(schema.proposalShares.revokedAt),
      gt(schema.proposalShares.expiresAt, now),
    ))
    .returning({ acceptedAt: schema.proposalShares.acceptedAt })
  if (!counted) return null

  const open = proposal.status === 'sent' && counted.acceptedAt === null
  return {
    state: open ? 'open' : 'closed',
    proposal: { status: proposal.status, document: proposal.document, decidedAt: proposal.decidedAt },
    company: { domain: company.domain, name: company.name },
    org: { name: org.name },
    evidenceAsOf: ranAt,
  }
}

export type ShareAcceptRefusal =
  | 'not_found' | 'expired' | 'revoked' | 'already_accepted' | 'decided' | 'blank_name' | 'reverifying'
export type ShareAcceptResult =
  | { ok: true; proposalId: string; orgId: string; companyDomain: string; shareId: string }
  | { ok: false; reason: ShareAcceptRefusal; status: 404 | 410 | 409 | 400 }

const REFUSED: Readonly<Record<ShareAcceptRefusal, 404 | 410 | 409 | 400>> = {
  not_found: 404,
  // Revoked answers like unknown: the team withdrew it, and the page that
  // follows says nothing about why.
  revoked: 404,
  expired: 410,
  reverifying: 410,
  already_accepted: 409,
  decided: 409,
  blank_name: 400,
}

class Refused extends Error {
  constructor(readonly reason: ShareAcceptRefusal) {
    super(reason)
  }
}

const refuse = (reason: ShareAcceptRefusal): Extract<ShareAcceptResult, { ok: false }> =>
  ({ ok: false, reason, status: REFUSED[reason] })

/**
 * The buyer accepts. One transaction:
 *
 *  1. the share row and then the proposal are locked, and the refusals are
 *     read off them — revoked, expired, already accepted, a proposal that is
 *     no longer `sent`, evidence that has aged out since the link was made;
 *  2. ONE UPDATE records the typed name, and its predicate is the liveness
 *     check itself (`accepted_at IS NULL AND revoked_at IS NULL AND
 *     expires_at > now`), so two clicks produce one acceptance;
 *  3. `setProposalStatus(accepted)` with `actor: 'share_link'` — the same
 *     call the team's button makes, which closes the deal `won`;
 *  4. `proposal.accepted_via_share` is audited with the ids, never the name
 *     and never the token.
 *
 * Returns the ids the route needs for its notification, and the route
 * returns none of them.
 */
export async function shareAccept(
  db: AgencyDb,
  args: { readonly token: string; readonly acceptedByName: unknown; readonly now?: Date },
): Promise<ShareAcceptResult> {
  const now = args.now ?? new Date()
  if (!SHARE_TOKEN_SHAPE.test(args.token)) return refuse('not_found')
  const name = shareNormaliseName(args.acceptedByName)
  if (!name) return refuse('blank_name')

  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as AgencyDb
      const row = await shareByToken(txDb, args.token, true)
      if (!row) throw new Refused('not_found')
      if (row.revokedAt) throw new Refused('revoked')
      if (row.acceptedAt) throw new Refused('already_accepted')
      if (row.expiresAt.getTime() <= now.getTime()) throw new Refused('expired')

      const [proposal] = await txDb
        .select({ id: schema.proposals.id, status: schema.proposals.status, scanId: schema.proposals.scanId, companyId: schema.proposals.companyId })
        .from(schema.proposals)
        .where(and(eq(schema.proposals.orgId, row.orgId), eq(schema.proposals.id, row.proposalId)))
        .limit(1)
        .for('update')
      if (!proposal) throw new Refused('not_found')
      if (proposal.status !== 'sent') throw new Refused('decided')

      const ranAt = await scanRanAt(txDb, row.orgId, proposal.scanId)
      if (!ranAt || isStale(ranAt, await staleAfterDaysFor(txDb, row.orgId), now)) throw new Refused('reverifying')

      const [accepted] = await txDb
        .update(schema.proposalShares)
        .set({ acceptedAt: now, acceptedByName: name })
        .where(and(
          eq(schema.proposalShares.id, row.id),
          isNull(schema.proposalShares.acceptedAt),
          isNull(schema.proposalShares.revokedAt),
          gt(schema.proposalShares.expiresAt, now),
        ))
        .returning({ id: schema.proposalShares.id })
      if (!accepted) throw new Refused('already_accepted')

      const decided = await setProposalStatus(txDb, {
        orgId: row.orgId,
        id: proposal.id,
        status: 'accepted',
        actor: 'share_link',
        now,
      })
      if (!decided) throw new Refused('not_found')

      await appendAudit(txDb, {
        orgId: row.orgId,
        actor: 'share_link',
        action: 'proposal.accepted_via_share',
        subjectType: 'proposal',
        subjectId: proposal.id,
        detail: { proposalId: proposal.id, shareId: row.id, companyId: proposal.companyId },
      })

      // The FK forbids a proposal without its company, and the notification
      // names the company by domain; a row with none is not an acceptance.
      const [company] = await txDb
        .select({ domain: schema.companies.domain })
        .from(schema.companies)
        .where(and(eq(schema.companies.orgId, row.orgId), eq(schema.companies.id, proposal.companyId)))
        .limit(1)
      if (!company) throw new Refused('not_found')

      return {
        ok: true as const,
        proposalId: proposal.id,
        orgId: row.orgId,
        companyDomain: company.domain,
        shareId: row.id,
      }
    })
  } catch (err) {
    // A refusal rolls back whatever the transaction had written: nothing is
    // half-accepted.
    if (err instanceof Refused) return refuse(err.reason)
    throw err
  }
}
