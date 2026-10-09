import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { can, quoteLapsed } from '@agency/core'
import {
  orgProfileRead, quoteItemsOf, quoteNeedsOf, quoteRead, schema, servicesList, shareLinksFor, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { QuoteEditor } from './editor'

/**
 * One quote, to edit and send (0023). Everything a person changes is saved
 * through PATCH /api/quotes/[id], over the version this page loaded.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!can(principal, 'deals:read')) redirect('/')
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound()

  const db = getDb() as unknown as AgencyDb
  const quote = await quoteRead(db, user.orgId, id)
  if (!quote) notFound()
  const [[company], contacts, catalogue, profile, links] = await Promise.all([
    db.select({ name: schema.companies.name, domain: schema.companies.domain })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, quote.companyId)))
      .limit(1),
    db.select({ id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, email: schema.contacts.email })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, user.orgId), eq(schema.contacts.companyId, quote.companyId))),
    servicesList(db, user.orgId, { activeOnly: true }),
    orgProfileRead(db, user.orgId),
    shareLinksFor(db, { orgId: user.orgId, quoteId: quote.id }),
  ])

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const now = new Date()
  return (
    <Shell user={user} current="quotes" signOut={signOutAction}>
      <p className="crumb">
        <a href="/quotes">Quotes</a> / {company ? <a href={`/companies/${encodeURIComponent(company.domain)}`}>{company.name || company.domain}</a> : null}
      </p>
      <QuoteEditor
        canWrite={can(principal, 'deals:write')}
        initial={{
          id: quote.id,
          number: quote.number,
          status: quote.status,
          title: quote.title,
          intro: quote.intro ?? '',
          items: quoteItemsOf(quote),
          contactId: quote.contactId,
          advancePercent: quote.advancePercent,
          validUntil: quote.validUntil,
          terms: quote.terms ?? '',
          updatedAt: (quote.updatedAt ?? quote.createdAt).toISOString(),
          lapsed: quoteLapsed(quote.validUntil, now),
          acceptedByName: quote.acceptedByName,
        }}
        needs={quoteNeedsOf(quote).map((n) => ({ label: n.label, evidence: [...n.evidence] }))}
        gstRate={Number(quote.taxRate) || profile.gstRate}
        contacts={contacts.map((c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Contact', hasEmail: Boolean(c.email) }))}
        catalogue={catalogue.map((s) => ({
          id: s.id, name: s.name, description: s.description, priceFrom: s.priceFrom, priceTo: s.priceTo, priceUnit: s.priceUnit,
        }))}
        links={links.map((l) => ({
          id: l.id,
          createdAt: l.createdAt.toISOString(),
          expiresAt: l.expiresAt.toISOString(),
          revoked: l.revokedAt !== null,
          views: l.viewCount,
          lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
        }))}
        upiReady={Boolean(profile.upiVpa)}
      />
    </Shell>
  )
}
