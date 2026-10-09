/**
 * Links a business opens (0023): its quote, its own audit page, or a preview
 * of the website the agency would build it.
 *
 * The proposal's share link (`proposal-shares.ts`) set the rules, and these
 * keep them: the token is 32 random bytes, base64url, shown once and never
 * stored — only its sha256 is; a link expires and can be revoked; an
 * unknown, revoked or expired token reads the same, as nothing; and a view
 * is a count and two times, nothing about who.
 *
 * What a view is FOR is the one thing added: the first time a business opens
 * its link, the person who sent it gets a task — "your quote link was just
 * opened: call now" — because the hour after somebody reads an offer is the
 * hour a call lands. Best-effort: a task that cannot be written never costs
 * the business its page. A view is counted by the page's own script, once it
 * has been visible in a browser, and never for a teammate — a preview card
 * built when the link is pasted into WhatsApp is not somebody reading it
 * (`apps/web/src/lib/link-view.ts`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { classifyWebsite, isNoSiteDomain } from '@agency/core'
import { tasksCreate } from './tasks.js'

export type ShareKind = 'quote' | 'report' | 'preview'
export type ShareLinkRow = typeof schema.shareLinks.$inferSelect

/** What a token looks like: 32 bytes of base64url. Anything else is not looked up. */
export const SHARE_LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
/** How long an audit page or a preview link lives; a quote's lives until it lapses. */
export const SHARE_LINK_TTL_DAYS = 30

export function shareLinkHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

const KIND_WORDS: Readonly<Record<ShareKind, string>> = {
  quote: 'quote',
  report: 'audit page',
  preview: 'website preview',
}

/**
 * Mint a link and audit it, in one transaction. Returns the raw token, which
 * is the only time it exists outside the person's message.
 */
export async function shareLinkMint(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly kind: ShareKind
    readonly companyId: string
    readonly quoteId?: string | null
    readonly createdBy: string | null
    readonly actor: string
    readonly expiresAt: Date
  },
): Promise<{ readonly token: string; readonly link: ShareLinkRow }> {
  if ((args.kind === 'quote') !== Boolean(args.quoteId)) throw new Error('a quote link names its quote, and only a quote link does')
  const token = randomBytes(32).toString('base64url')
  const link = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.shareLinks)
      .values({
        orgId: args.orgId,
        kind: args.kind,
        companyId: args.companyId,
        quoteId: args.quoteId ?? null,
        tokenHash: shareLinkHash(token),
        createdBy: args.createdBy,
        expiresAt: args.expiresAt,
      })
      .returning()
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'share_link.created',
      subjectType: 'company',
      subjectId: args.companyId,
      detail: { kind: args.kind, linkId: row!.id, ...(args.quoteId ? { quoteId: args.quoteId } : {}), expiresAt: args.expiresAt.toISOString() },
    })
    return row!
  })
  return { token, link }
}

/** Revoke a link of this org. False when there was nothing live to revoke. */
export async function shareLinkRevoke(
  db: AgencyDb,
  args: { readonly orgId: string; readonly linkId: string; readonly actor: string; readonly now?: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.shareLinks)
      .set({ revokedAt: args.now ?? new Date() })
      .where(and(eq(schema.shareLinks.orgId, args.orgId), eq(schema.shareLinks.id, args.linkId), isNull(schema.shareLinks.revokedAt)))
      .returning({ id: schema.shareLinks.id, kind: schema.shareLinks.kind, companyId: schema.shareLinks.companyId })
    const row = rows[0]
    if (!row) return false
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'share_link.revoked',
      subjectType: 'company',
      subjectId: row.companyId,
      detail: { kind: row.kind, linkId: row.id },
    })
    return true
  })
}

/** Revoke every live link of one quote — a quote revised or withdrawn after it was sent. Returns how many. */
export async function shareLinksRevokeForQuote(
  db: AgencyDb,
  args: { readonly orgId: string; readonly quoteId: string; readonly now?: Date },
): Promise<number> {
  const rows = await db
    .update(schema.shareLinks)
    .set({ revokedAt: args.now ?? new Date() })
    .where(and(eq(schema.shareLinks.orgId, args.orgId), eq(schema.shareLinks.quoteId, args.quoteId), isNull(schema.shareLinks.revokedAt)))
    .returning({ id: schema.shareLinks.id })
  return rows.length
}

/**
 * The live link a token names, of the kind asked for, or null — unknown,
 * revoked, expired and the wrong kind all read the same. Counts nothing.
 */
export async function shareLinkResolve(db: AgencyDb, token: string, kind: ShareKind, now: Date): Promise<ShareLinkRow | null> {
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) return null
  const hash = shareLinkHash(token)
  const [row] = await db
    .select()
    .from(schema.shareLinks)
    .where(and(eq(schema.shareLinks.tokenHash, hash), eq(schema.shareLinks.kind, kind), isNull(schema.shareLinks.revokedAt), gt(schema.shareLinks.expiresAt, now)))
    .limit(1)
  if (!row) return null
  // The index found it by hash; compare in constant time anyway, as a proposal's link does.
  const a = Buffer.from(row.tokenHash, 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b) ? row : null
}

/**
 * Count a view of a live link. On the FIRST view, the person who made the
 * link — or nobody, for an agent's — gets a task to follow up while the
 * business is reading: a call when the company has a phone on record, a
 * to-do otherwise. Never throws: a page must not fail for its bookkeeping.
 */
export async function shareLinkCountView(
  db: AgencyDb,
  args: { readonly link: ShareLinkRow; readonly companyName: string; readonly now: Date },
): Promise<{ readonly first: boolean }> {
  try {
    const rows = await db
      .update(schema.shareLinks)
      .set({
        viewCount: sql`${schema.shareLinks.viewCount} + 1`,
        firstViewedAt: sql`coalesce(${schema.shareLinks.firstViewedAt}, ${args.now.toISOString()}::timestamptz)`,
        lastViewedAt: args.now,
      })
      .where(and(eq(schema.shareLinks.id, args.link.id), isNull(schema.shareLinks.revokedAt), gt(schema.shareLinks.expiresAt, args.now)))
      .returning({ viewCount: schema.shareLinks.viewCount })
    const first = rows[0]?.viewCount === 1
    if (first) await followUpTask(db, args.link, args.companyName, args.now)
    return { first }
  } catch {
    return { first: false }
  }
}

async function followUpTask(db: AgencyDb, link: ShareLinkRow, companyName: string, now: Date): Promise<void> {
  const what = KIND_WORDS[link.kind as ShareKind] ?? 'link'
  const [company] = await db
    .select({ phone: schema.companies.phone })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, link.orgId), eq(schema.companies.id, link.companyId)))
    .limit(1)
  const base = {
    orgId: link.orgId,
    companyId: link.companyId,
    assigneeUserId: link.createdBy,
    dueAt: now,
    createdBy: null,
    actor: 'share_link',
  } as const
  // Whoever holds the link opened it — most likely the business, but a link can be forwarded, so say no more than that.
  const detail =
    `The ${what} link made for ${companyName} was opened for the first time just now, most likely by them. ` +
    'The best moment to follow up is while they are reading it.'
  const call = company?.phone
    ? await tasksCreate(db, { ...base, kind: 'call', title: `Call ${companyName} — your ${what} link was just opened`, detail }).catch(() => null)
    : null
  if (call?.ok) return
  await tasksCreate(db, { ...base, kind: 'todo', title: `Follow up with ${companyName} — your ${what} link was just opened`, detail }).catch(() => null)
}

/** The links of a company or a quote, newest first, for the team's list. Never a token: it is not stored. */
export async function shareLinksFor(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyId?: string; readonly quoteId?: string; readonly kind?: ShareKind },
): Promise<ShareLinkRow[]> {
  return db
    .select()
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.orgId, args.orgId),
        ...(args.companyId ? [eq(schema.shareLinks.companyId, args.companyId)] : []),
        ...(args.quoteId ? [eq(schema.shareLinks.quoteId, args.quoteId)] : []),
        ...(args.kind ? [eq(schema.shareLinks.kind, args.kind)] : []),
      ),
    )
    .orderBy(desc(schema.shareLinks.createdAt))
    .limit(50)
}

/**
 * The preview email's first line: that the business has no website of its
 * own only when its listing was read and names none (`classifyWebsite`);
 * otherwise only what the preview is. Exported for its test.
 */
export function shareLinkPreviewOpening(
  name: string,
  company: { readonly domain: string; readonly listingCheckedAt: Date | null; readonly listingWebsite: string | null },
): string {
  const listingNamesNone =
    isNoSiteDomain(company.domain) &&
    company.listingCheckedAt !== null &&
    (company.listingWebsite === null || classifyWebsite(company.listingWebsite).kind !== 'own')
  if (listingNamesNone) {
    return `I noticed your Google listing does not link to a website of your own, so we made a quick preview of what one could look like for ${name}, from that listing:`
  }
  return company.listingCheckedAt !== null
    ? `We made a quick preview of what a fresh one-page website for ${name} could look like, from your Google listing:`
    : `We made a quick preview of what a fresh one-page website for ${name} could look like:`
}

/**
 * Draft the email that carries a business's audit page or website preview
 * (2026-10-08): an outbound email awaiting approval, as `queue_touch` drafts
 * one — on /approvals a person reads it, names the recipient and the
 * campaign, and the send path judges it at sending. Nothing is sent here.
 *
 * The words claim nothing the CRM did not observe (§2.2): a preview says the
 * business has no website of its own only when its Google listing was read
 * and names none — a Facebook page or a directory entry is not one — and the
 * audit page's email promises only that it is from public information.
 */
export async function shareLinkDraftEmail(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly kind: 'report' | 'preview'
    readonly url: string
    readonly agencyName: string
    readonly actor: string
  },
): Promise<{ readonly ok: true; readonly touchId: string } | { readonly ok: false; readonly message: string }> {
  const [company] = await db
    .select({
      name: schema.companies.name, domain: schema.companies.domain,
      listingCheckedAt: schema.companies.listingCheckedAt, listingWebsite: schema.companies.listingWebsite,
    })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (!company) return { ok: false, message: 'That company is not in this organisation.' }
  const name = company.name || company.domain
  const [subject, opening] =
    args.kind === 'report'
      ? [`A quick look at ${name} online`, `I put together a short page on how ${name} shows up online, from public information only:`]
      : [`A website for ${name}`, shareLinkPreviewOpening(name, company)]
  const body = [
    'Hi,',
    '',
    opening,
    '',
    args.url,
    '',
    args.kind === 'report'
      ? 'It only uses public information. If any of it is useful, I would be happy to walk you through it — just reply here.'
      : 'It is only a preview — we would build the real one with your photos, services and prices. Happy to talk if it is useful; just reply here.',
    '',
    args.agencyName,
  ].join('\n')
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.touches)
      .values({
        orgId: args.orgId,
        companyId: args.companyId,
        contactId: null,
        recipient: null,
        channel: 'email',
        direction: 'out',
        status: 'awaiting_approval',
        subject: subject.slice(0, 200),
        body,
      })
      .returning({ id: schema.touches.id })
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'share_link.email_drafted',
      subjectType: 'company',
      subjectId: args.companyId,
      detail: { kind: args.kind, touchId: row!.id },
    })
    return { ok: true as const, touchId: row!.id }
  })
}
