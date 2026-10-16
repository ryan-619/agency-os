/**
 * Quotes (0023): a priced offer of the agency's own services.
 *
 * Raised for one company, prefilled from the services its NEEDS point at
 * (`companyOpportunity`) at the catalogue's prices, with the needs and their
 * dated evidence snapshotted beside the lines, and the tax, the advance, the
 * validity and the terms from the agency's profile. Every line and total is
 * computed by `quoteTotals` in packages/core and held by CHECK to
 * `total = subtotal + tax`.
 *
 * A quote is a draft until a person marks it SENT, which is the moment the
 * seller's details are fixed on it (`quotes_sent_has_its_seller`) and a link
 * may be minted. Editing a sent quote returns it to a draft and revokes its
 * links — the buyer must never accept words they were not shown. Accepting
 * one (a person recording it, or the buyer through the link) closes the
 * company's deal WON, as a proposal's acceptance does.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  QUOTE_LIMITS, quoteItemFromService, quoteItemProblem, quoteLapsed, quoteNumber, quoteSequence, quoteTotals,
  quoteValidUntil, type QuoteItem, type QuoteUnit,
} from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { advanceDeal, openDealFor, setDealStage } from './deals.js'
import { companyOpportunity, servicesList } from './opportunities.js'
import { orgProfileRead, quoteSellerFrom } from './org-profile.js'
import { shareLinksRevokeForQuote } from './share-links.js'
import { tasksCreate } from './tasks.js'

export type QuoteRow = typeof schema.quotes.$inferSelect
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'withdrawn'

/** A need as the quote snapshots it: what it is, and the dated lines that showed it. */
export interface QuoteNeed {
  readonly key: string
  readonly label: string
  readonly evidence: readonly string[]
}

/** The lines as stored, read defensively: a row is data, and a hand-edited one is not trusted. */
export function quoteItemsOf(row: Pick<QuoteRow, 'items'>): QuoteItem[] {
  const raw = Array.isArray(row.items) ? (row.items as unknown[]) : []
  return raw.flatMap((r) => {
    if (typeof r !== 'object' || r === null) return []
    const o = r as Record<string, unknown>
    if (typeof o['name'] !== 'string' || typeof o['quantity'] !== 'number' || typeof o['unitPrice'] !== 'number') return []
    return [{
      serviceId: typeof o['serviceId'] === 'string' ? o['serviceId'] : null,
      name: o['name'],
      description: typeof o['description'] === 'string' ? o['description'] : null,
      quantity: o['quantity'],
      unit: (typeof o['unit'] === 'string' ? o['unit'] : 'one_off') as QuoteUnit,
      unitPrice: o['unitPrice'],
    }]
  })
}

export function quoteNeedsOf(row: Pick<QuoteRow, 'needs'>): QuoteNeed[] {
  const raw = Array.isArray(row.needs) ? (row.needs as unknown[]) : []
  return raw.flatMap((r) => {
    if (typeof r !== 'object' || r === null) return []
    const o = r as Record<string, unknown>
    if (typeof o['key'] !== 'string' || typeof o['label'] !== 'string') return []
    const evidence = Array.isArray(o['evidence']) ? o['evidence'].filter((e): e is string => typeof e === 'string') : []
    return [{ key: o['key'], label: o['label'], evidence }]
  })
}

export type QuoteRefusal =
  | 'not_found' | 'invalid' | 'not_editable' | 'not_sent' | 'lapsed' | 'changed_meanwhile' | 'no_lines' | 'no_company'

export type QuoteOutcome =
  | { readonly ok: true; readonly quote: QuoteRow }
  | { readonly ok: false; readonly reason: QuoteRefusal; readonly message: string }

const refuse = (reason: QuoteRefusal, message: string): QuoteOutcome => ({ ok: false, reason, message })

function itemsProblem(items: readonly QuoteItem[]): string | null {
  if (items.length > QUOTE_LIMITS.items) return `A quote holds at most ${QUOTE_LIMITS.items} lines.`
  for (const [i, item] of items.entries()) {
    const p = quoteItemProblem(item, i)
    if (p) return p
  }
  return null
}

/** The next number in this org's run for the year, under a lock so two quotes never share one. */
async function nextNumber(tx: AgencyDb, orgId: string, now: Date): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('quote.number'), hashtext(${orgId}))`)
  const year = now.getUTCFullYear()
  const rows = await tx
    .select({ number: schema.quotes.number })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.orgId, orgId), sql`${schema.quotes.number} LIKE ${`Q-${year}-%`}`))
  const top = rows.reduce((m, r) => Math.max(m, quoteSequence(r.number, year) ?? 0), 0)
  return quoteNumber(year, top + 1)
}

/**
 * Raise a draft quote for a company. Lines: those given, else one per
 * catalogue service named, else one per service its needs point at (the
 * catalogue's, never the suggestions, which carry no price). The needs are
 * snapshotted with their evidence either way.
 */
export async function quoteCreate(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly companyId: string
    readonly contactId?: string | null
    readonly title?: string | null
    readonly intro?: string | null
    readonly items?: readonly QuoteItem[] | null
    readonly serviceIds?: readonly string[] | null
    readonly createdBy: string | null
    readonly actor: string
    readonly now?: Date
  },
): Promise<QuoteOutcome> {
  const now = args.now ?? new Date()
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
    .limit(1)
  if (!company) return refuse('no_company', 'That company is not in this organisation.')
  if (args.contactId) {
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId), eq(schema.contacts.companyId, company.id)))
      .limit(1)
    if (!contact) return refuse('invalid', 'That contact is not at this company.')
  }

  const [profile, opportunity, catalogue] = await Promise.all([
    orgProfileRead(db, args.orgId),
    companyOpportunity(db, { orgId: args.orgId, company, now }),
    servicesList(db, args.orgId, { activeOnly: true }),
  ])

  let items: QuoteItem[]
  if (args.items && args.items.length > 0) {
    items = [...args.items]
  } else {
    const ids = args.serviceIds && args.serviceIds.length > 0
      ? [...args.serviceIds]
      : opportunity.services.flatMap((s) => (s.id && !s.suggested ? [s.id] : []))
    items = ids.flatMap((id) => {
      const service = catalogue.find((c) => c.id === id)
      return service ? [quoteItemFromService(service)] : []
    })
    if (args.serviceIds && args.serviceIds.length > 0 && items.length !== new Set(args.serviceIds).size) {
      return refuse('invalid', 'One of those services is not in the active catalogue.')
    }
  }
  const problem = itemsProblem(items)
  if (problem) return refuse('invalid', problem)

  const title = (args.title?.trim() || `Proposal for ${company.name}`).slice(0, QUOTE_LIMITS.title)
  const intro = args.intro?.trim() ? args.intro.trim().slice(0, QUOTE_LIMITS.intro) : null
  const needs: QuoteNeed[] = opportunity.reading.needs.map((n) => ({ key: n.key, label: n.label, evidence: [...n.evidence] }))
  const totals = quoteTotals(items, profile.gstRate, profile.advancePercent)

  const quote = await db.transaction(async (tx) => {
    const number = await nextNumber(tx as unknown as AgencyDb, args.orgId, now)
    const [row] = await tx
      .insert(schema.quotes)
      .values({
        orgId: args.orgId,
        companyId: company.id,
        contactId: args.contactId ?? null,
        number,
        title,
        intro,
        items,
        currency: 'INR',
        subtotal: totals.subtotal,
        taxRate: String(profile.gstRate),
        taxAmount: totals.taxAmount,
        total: totals.total,
        advancePercent: profile.advancePercent,
        advanceAmount: totals.advanceAmount,
        needs,
        terms: profile.quoteTerms,
        validUntil: quoteValidUntil(now, profile.quoteValidityDays),
        createdBy: args.createdBy,
      })
      .returning()
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'quote.created',
      subjectType: 'quote',
      subjectId: row!.id,
      detail: { companyId: company.id, number, lines: items.length, total: totals.total },
    })
    return row!
  })
  return { ok: true, quote }
}

export async function quoteRead(db: AgencyDb, orgId: string, quoteId: string): Promise<QuoteRow | null> {
  const [row] = await db.select().from(schema.quotes).where(and(eq(schema.quotes.orgId, orgId), eq(schema.quotes.id, quoteId))).limit(1)
  return row ?? null
}

export async function quotesList(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyId?: string; readonly status?: QuoteStatus; readonly limit?: number },
): Promise<(QuoteRow & { readonly companyName: string | null; readonly companyDomain: string })[]> {
  const rows = await db
    .select({ quote: schema.quotes, companyName: schema.companies.name, companyDomain: schema.companies.domain })
    .from(schema.quotes)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
    .where(
      and(
        eq(schema.quotes.orgId, args.orgId),
        ...(args.companyId ? [eq(schema.quotes.companyId, args.companyId)] : []),
        ...(args.status ? [eq(schema.quotes.status, args.status)] : []),
      ),
    )
    .orderBy(desc(schema.quotes.createdAt))
    .limit(Math.min(args.limit ?? 100, 500))
  return rows.map((r) => ({ ...r.quote, companyName: r.companyName, companyDomain: r.companyDomain }))
}

export interface QuotePatch {
  readonly title?: string
  readonly intro?: string | null
  readonly items?: readonly QuoteItem[]
  readonly contactId?: string | null
  readonly advancePercent?: number
  readonly validUntil?: string
  readonly terms?: string | null
}

/**
 * Change a draft — or a sent quote, which goes back to a draft with its
 * links revoked, since the buyer must never accept words they were not
 * shown. Totals are recomputed at the profile's current GST. Lands only over
 * the version the editor loaded (`expectedUpdatedAt`, when given).
 */
export async function quoteUpdate(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly quoteId: string
    readonly patch: QuotePatch
    readonly expectedUpdatedAt?: string | null
    readonly actor: string
    readonly now?: Date
  },
): Promise<QuoteOutcome & { readonly revised?: boolean }> {
  const now = args.now ?? new Date()
  const current = await quoteRead(db, args.orgId, args.quoteId)
  if (!current) return refuse('not_found', 'That quote does not exist.')
  if (current.status !== 'draft' && current.status !== 'sent') {
    return refuse('not_editable', `This quote is ${current.status}; it cannot be changed. Raise a new one.`)
  }
  const p = args.patch
  const items = p.items ? [...p.items] : quoteItemsOf(current)
  const problem = itemsProblem(items)
  if (problem) return refuse('invalid', problem)
  if (p.title !== undefined && (p.title.trim() === '' || [...p.title].length > QUOTE_LIMITS.title)) {
    return refuse('invalid', `A title is 1 to ${QUOTE_LIMITS.title} characters.`)
  }
  if (p.intro && [...p.intro].length > QUOTE_LIMITS.intro) return refuse('invalid', `The introduction is at most ${QUOTE_LIMITS.intro} characters.`)
  if (p.terms && [...p.terms].length > QUOTE_LIMITS.terms) return refuse('invalid', `The terms are at most ${QUOTE_LIMITS.terms} characters.`)
  if (p.advancePercent !== undefined && (!Number.isInteger(p.advancePercent) || p.advancePercent < 0 || p.advancePercent > 100)) {
    return refuse('invalid', 'The advance is a whole percentage from 0 to 100.')
  }
  if (p.validUntil !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(p.validUntil) || quoteLapsed(p.validUntil, now))) {
    return refuse('invalid', 'Valid until must be a date that has not passed.')
  }
  if (p.contactId) {
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, p.contactId), eq(schema.contacts.companyId, current.companyId)))
      .limit(1)
    if (!contact) return refuse('invalid', 'That contact is not at this company.')
  }

  const profile = await orgProfileRead(db, args.orgId)
  const advancePercent = p.advancePercent ?? current.advancePercent
  const totals = quoteTotals(items, profile.gstRate, advancePercent)
  const revised = current.status === 'sent'
  const fields = Object.keys(p).filter((k) => (p as Record<string, unknown>)[k] !== undefined)

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.quotes)
      .set({
        ...(p.title !== undefined ? { title: p.title.trim() } : {}),
        ...(p.intro !== undefined ? { intro: p.intro?.trim() || null } : {}),
        ...(p.contactId !== undefined ? { contactId: p.contactId } : {}),
        ...(p.terms !== undefined ? { terms: p.terms?.trim() || null } : {}),
        ...(p.validUntil !== undefined ? { validUntil: p.validUntil } : {}),
        items,
        subtotal: totals.subtotal,
        taxRate: String(profile.gstRate),
        taxAmount: totals.taxAmount,
        total: totals.total,
        advancePercent,
        advanceAmount: totals.advanceAmount,
        ...(revised ? { status: 'draft', sentAt: null, seller: null } : {}),
      })
      .where(
        and(
          eq(schema.quotes.orgId, args.orgId),
          eq(schema.quotes.id, args.quoteId),
          eq(schema.quotes.status, current.status),
          ...(args.expectedUpdatedAt
            ? [sql`coalesce(${schema.quotes.updatedAt}, ${schema.quotes.createdAt}) = ${args.expectedUpdatedAt}::timestamptz`]
            : []),
        ),
      )
      .returning()
    const row = rows[0]
    if (!row) return { ok: false as const, reason: 'changed_meanwhile' as const, message: 'This quote was changed by somebody else while you were editing. Reload it; nothing was saved.' }
    if (revised) await shareLinksRevokeForQuote(tx as unknown as AgencyDb, { orgId: args.orgId, quoteId: row.id, now })
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'quote.updated',
      subjectType: 'quote',
      subjectId: row.id,
      detail: { fields, total: row.total, revisedFromSent: revised },
    })
    return { ok: true as const, quote: row, revised }
  })
}

/** Mark a draft SENT — a person's act — fixing the seller's details on it. */
export async function quoteSend(
  db: AgencyDb,
  args: { readonly orgId: string; readonly quoteId: string; readonly actor: string; readonly now?: Date },
): Promise<QuoteOutcome> {
  const now = args.now ?? new Date()
  const current = await quoteRead(db, args.orgId, args.quoteId)
  if (!current) return refuse('not_found', 'That quote does not exist.')
  if (current.status !== 'draft') return refuse('not_editable', `This quote is already ${current.status}.`)
  if (quoteItemsOf(current).length === 0) return refuse('no_lines', 'Add at least one line before sending the quote.')
  if (quoteLapsed(current.validUntil, now)) return refuse('lapsed', 'This quote’s validity has passed. Set a new "valid until" date first.')
  const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, args.orgId)).limit(1)
  const seller = quoteSellerFrom(org?.name ?? 'Agency', await orgProfileRead(db, args.orgId))
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.quotes)
      .set({ status: 'sent', sentAt: now, seller })
      .where(and(eq(schema.quotes.orgId, args.orgId), eq(schema.quotes.id, args.quoteId), eq(schema.quotes.status, 'draft')))
      .returning()
    const row = rows[0]
    if (!row) return refuse('changed_meanwhile', 'This quote changed while it was being sent. Reload it.')
    await advanceDeal(tx as unknown as AgencyDb, { orgId: args.orgId, companyId: row.companyId, to: 'proposal' })
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'quote.sent',
      subjectType: 'quote',
      subjectId: row.id,
      detail: { companyId: row.companyId, number: row.number, total: row.total },
    })
    return { ok: true as const, quote: row }
  })
}

/**
 * Record the buyer's answer to a SENT quote: accepted (by a person
 * recording it, or the buyer through the link, who gives their name) or
 * declined, or the agency withdrawing it. Acceptance closes the company's
 * deal won and, when an advance is asked, gives whoever raised the quote a
 * task to collect it.
 */
export async function quoteDecide(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly quoteId: string
    readonly to: 'accepted' | 'declined' | 'withdrawn'
    readonly actor: string
    readonly via: 'person' | 'share_link'
    readonly acceptedByName?: string | null
    readonly reason?: string | null
    readonly now?: Date
  },
): Promise<QuoteOutcome> {
  const now = args.now ?? new Date()
  const current = await quoteRead(db, args.orgId, args.quoteId)
  if (!current) return refuse('not_found', 'That quote does not exist.')
  if (current.status !== 'sent') return refuse('not_sent', current.status === 'draft' ? 'Mark the quote sent first.' : `This quote is already ${current.status}.`)
  if (args.to === 'accepted' && args.via === 'share_link' && quoteLapsed(current.validUntil, now)) {
    return refuse('lapsed', 'This quote is no longer valid. Ask for an updated one.')
  }
  const name = args.acceptedByName?.trim() ? args.acceptedByName.trim().slice(0, 120) : null
  if (args.to === 'accepted' && args.via === 'share_link' && !name) return refuse('invalid', 'Type your name to accept.')
  const reason = args.reason?.trim() ? args.reason.trim().slice(0, 500) : null

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.quotes)
      .set(
        args.to === 'accepted'
          ? { status: 'accepted', acceptedAt: now, acceptedByName: name }
          : args.to === 'declined'
            ? { status: 'declined', declinedAt: now, declineReason: reason }
            : { status: 'withdrawn' },
      )
      .where(and(eq(schema.quotes.orgId, args.orgId), eq(schema.quotes.id, args.quoteId), eq(schema.quotes.status, 'sent')))
      .returning()
    const row = rows[0]
    if (!row) return refuse('changed_meanwhile', 'This quote changed meanwhile. Reload it.')
    const db2 = tx as unknown as AgencyDb
    if (args.to === 'accepted') {
      const open = await openDealFor(db2, args.orgId, row.companyId)
      const deal = open ?? (await advanceDeal(db2, { orgId: args.orgId, companyId: row.companyId, to: 'proposal' })).deal
      await setDealStage(db2, { orgId: args.orgId, dealId: deal.id, stage: 'won', now }).catch(() => null)
      if (row.advanceAmount > 0) {
        await tasksCreate(db2, {
          orgId: args.orgId,
          kind: 'todo',
          title: `Collect the advance on ${row.number}`,
          detail: `${row.number} was accepted${name ? ` by ${name}` : ''}. The advance asked is ${row.currency} ${row.advanceAmount.toLocaleString('en-IN')}.`,
          companyId: row.companyId,
          assigneeUserId: row.createdBy,
          dueAt: now,
          createdBy: null,
          actor: args.via === 'share_link' ? 'share_link' : args.actor,
        }).catch(() => null)
      }
    }
    if (args.to === 'withdrawn') await shareLinksRevokeForQuote(db2, { orgId: args.orgId, quoteId: row.id, now })
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action:
        args.to === 'withdrawn'
          ? 'quote.withdrawn'
          : args.via === 'share_link'
            ? args.to === 'accepted' ? 'quote.accepted_via_share' : 'quote.declined_via_share'
            : args.to === 'accepted' ? 'quote.accepted' : 'quote.declined',
      subjectType: 'quote',
      subjectId: row.id,
      detail: { companyId: row.companyId, number: row.number, total: row.total },
    })
    return { ok: true as const, quote: row }
  })
}

/**
 * Draft the email that carries a SENT quote's link (0023): an outbound email
 * awaiting approval, exactly as `queue_touch` drafts one — on /approvals a
 * person reads it, names the recipient and the campaign, and the send path
 * judges it at sending. The quote's contact is preselected when they have
 * an address. Nothing is sent here.
 */
export async function quoteDraftEmail(
  db: AgencyDb,
  args: { readonly orgId: string; readonly quoteId: string; readonly url: string; readonly actor: string },
): Promise<{ readonly ok: true; readonly touchId: string } | { readonly ok: false; readonly reason: QuoteRefusal; readonly message: string }> {
  const quote = await quoteRead(db, args.orgId, args.quoteId)
  if (!quote) return { ok: false, reason: 'not_found', message: 'That quote does not exist.' }
  if (quote.status !== 'sent') return { ok: false, reason: 'not_sent', message: 'Mark the quote sent first.' }
  const seller = (quote.seller ?? {}) as { name?: string; legalName?: string | null; brochureUrl?: string | null }
  const from = seller.name ?? 'us'
  let contact: { id: string; firstName: string | null; email: string | null } | undefined
  if (quote.contactId) {
    ;[contact] = await db
      .select({ id: schema.contacts.id, firstName: schema.contacts.firstName, email: schema.contacts.email })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, quote.contactId)))
      .limit(1)
  }
  const amount = `${quote.currency === 'INR' ? '₹' : `${quote.currency} `}${quote.total.toLocaleString(quote.currency === 'INR' ? 'en-IN' : 'en')}`
  const lines = quoteItemsOf(quote).length
  const body = [
    `Hi ${contact?.firstName?.trim() || 'there'},`,
    '',
    `Here is our quote ${quote.number} — ${quote.title}:`,
    '',
    args.url,
    '',
    `It covers ${lines} ${lines === 1 ? 'service' : 'services'} for ${amount}${Number(quote.taxRate) > 0 ? ' including GST' : ''}, and is valid until ${quote.validUntil}. You can read it, accept it${quote.advanceAmount > 0 ? ' and pay the advance by UPI' : ''} on that page.`,
    '',
    'Happy to answer any questions.',
    '',
    from,
    ...(seller.brochureUrl ? ['', `More about us: ${seller.brochureUrl}`] : []),
  ].join('\n')
  const subject = `Your quote ${quote.number} from ${from}`.slice(0, 200)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.touches)
      .values({
        orgId: args.orgId,
        companyId: quote.companyId,
        contactId: contact?.email ? contact.id : null,
        recipient: null,
        channel: 'email',
        direction: 'out',
        status: 'awaiting_approval',
        subject,
        body,
      })
      .returning({ id: schema.touches.id })
    await tx.insert(schema.auditLog).values({
      orgId: args.orgId,
      actor: args.actor,
      action: 'quote.email_drafted',
      subjectType: 'quote',
      subjectId: quote.id,
      detail: { touchId: row!.id, number: quote.number },
    })
    return { ok: true as const, touchId: row!.id }
  })
}
