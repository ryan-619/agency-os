import 'server-only'
import { and, eq } from 'drizzle-orm'
import {
  orgProfileRead, quoteItemsOf, quoteNeedsOf, quoteSellerFrom, schema, type AgencyDb, type QuoteRow, type QuoteSeller,
} from '@agency/db/queries'
import { orgIdentity } from '@/lib/org-identity'
import type { QuoteView } from '@/lib/quote-view'

/**
 * A quote as its document shows it: the company and contact by name, and the
 * seller as it was when the quote was SENT — its snapshot — or, for a draft,
 * as the profile reads now.
 */
export async function quoteViewFor(db: AgencyDb, quote: QuoteRow): Promise<QuoteView> {
  const [[company], contactRows, seller] = await Promise.all([
    db.select({ name: schema.companies.name, domain: schema.companies.domain })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, quote.orgId), eq(schema.companies.id, quote.companyId)))
      .limit(1),
    quote.contactId
      ? db.select({ firstName: schema.contacts.firstName, lastName: schema.contacts.lastName })
          .from(schema.contacts)
          .where(and(eq(schema.contacts.orgId, quote.orgId), eq(schema.contacts.id, quote.contactId)))
          .limit(1)
      : Promise.resolve([]),
    sellerFor(db, quote),
  ])
  const contact = contactRows[0]
  const contactName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null : null
  return {
    number: quote.number,
    title: quote.title,
    intro: quote.intro,
    status: quote.status,
    dated: (quote.sentAt ?? quote.createdAt).toISOString().slice(0, 10),
    validUntil: quote.validUntil,
    currency: quote.currency,
    items: quoteItemsOf(quote),
    subtotal: quote.subtotal,
    taxRate: Number(quote.taxRate),
    taxAmount: quote.taxAmount,
    total: quote.total,
    advancePercent: quote.advancePercent,
    advanceAmount: quote.advanceAmount,
    needs: quoteNeedsOf(quote).map((n) => ({ label: n.label, evidence: n.evidence })),
    terms: quote.terms,
    seller,
    buyer: { company: company?.name || company?.domain || 'Your business', contact: contactName },
  }
}

async function sellerFor(db: AgencyDb, quote: QuoteRow): Promise<QuoteSeller> {
  if (quote.seller && typeof quote.seller === 'object') return quote.seller as QuoteSeller
  const [org, profile] = await Promise.all([orgIdentity(quote.orgId), orgProfileRead(db, quote.orgId)])
  return quoteSellerFrom(org.name, profile)
}

/** When a quote's link stops opening: the end of its last valid day, in India. */
export function quoteLinkExpiry(validUntil: string): Date {
  const d = new Date(`${validUntil}T18:30:00.000Z`)
  return d
}
