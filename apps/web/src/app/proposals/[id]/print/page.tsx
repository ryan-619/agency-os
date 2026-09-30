import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, can, isStale, parseIcpDefinition, type Proposal } from '@agency/core'
import { appendAudit, readProposal, schema, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { ProposalDocument } from '@/components/pipeline/proposal-document'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { isoDate, provenanceSentence, staleBannerText } from '@/lib/proposal-markdown'
import { icpForOrg } from '@/lib/queries'

/**
 * A proposal, laid out for paper (PROMPT.md §8.6).
 *
 * The stored document, never regenerated, through the same
 * `<ProposalDocument>` the proposal page uses — for the team, so the score it
 * was ranked on stays on it. No Shell: the page is the document and the
 * heading it needs on paper (who it was prepared for, by whom, from what),
 * joined at read time, and nothing that only works on a screen.
 *
 * §2.2: the stale banner is derived from the scan's `ran_at` on this read,
 * exactly as the page derives it, and it PRINTS. A printed proposal is the
 * easiest thing in the product to hand to somebody, so it carries the
 * warning onto the paper rather than leaving it on a screen nobody will see
 * again. Printing is not sending (§8.4); nothing here sends. Each render is
 * audited as `proposal.exported { format: 'print' }`, beside the Markdown
 * download's `format: 'markdown'`.
 */
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The print view reads as a document, whatever the viewer's colour scheme:
 * a dark theme's pale ink on white paper is illegible. The rest of the
 * print rules are the shared ones in globals.css.
 */
const PRINT_CSS = `
@media print {
  :root { --bg: #fff; --panel: #fff; --ink: #111; --muted: #444; --line: #ccc; --accent: #111; --ok: #0b5e36; --warn: #7a4a00; }
  body { background: #fff; }
  .print-hide { display: none; }
  .card, .note, tr { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
}
`

const session = cache(() => auth())

/** One read per request, shared by the title and the page. */
const load = cache(async (orgId: string, id: string) => {
  const db = getDb() as unknown as AgencyDb
  const [row, icpRow] = await Promise.all([readProposal(db, orgId, id), icpForOrg(orgId)])
  if (!row) return null
  const [[company], [org], [scan], [preparer]] = await Promise.all([
    db
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, row.companyId)))
      .limit(1),
    db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).limit(1),
    db
      .select({ ranAt: schema.scans.ranAt })
      .from(schema.scans)
      .where(and(eq(schema.scans.orgId, orgId), eq(schema.scans.id, row.scanId)))
      .limit(1),
    row.createdBy
      ? db
          .select({ name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(and(eq(schema.users.orgId, orgId), eq(schema.users.id, row.createdBy)))
          .limit(1)
      : Promise.resolve([]),
  ])
  // The FK forbids a proposal without its company; a row that has none
  // anyway is not a document.
  if (!company) return null

  let staleAfter = DEFAULT_STALE_AFTER_DAYS
  if (icpRow) {
    try {
      staleAfter = parseIcpDefinition(icpRow.definition).freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS
    } catch {
      staleAfter = DEFAULT_STALE_AFTER_DAYS
    }
  }
  return {
    row,
    doc: row.document as Proposal,
    company,
    // The org's name, as the generator wrote it into the summary — not the
    // ICP's label, which names a market rather than an agency.
    agency: org?.name ?? 'Agency',
    preparedBy: preparer ? (preparer.name ?? preparer.email) : null,
    evidenceAsOf: scan ? scan.ranAt.toISOString() : null,
    evidenceStale: isStale(scan?.ranAt, staleAfter),
  }
})

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  // The title is what a browser names the PDF and prints in the page header.
  const s = await session()
  const { id } = await params
  if (!s?.user || !UUID.test(id)) return {}
  const found = await load(s.user.orgId, id)
  return found ? { title: found.doc.title } : {}
}

export default async function ProposalPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await session()
  if (!s?.user) redirect('/signin')
  const user = s.user
  const { id } = await params
  if (!UUID.test(id)) notFound()
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')) notFound()

  const found = await load(user.orgId, id)
  if (!found) notFound()
  const { row, doc, company, agency, preparedBy, evidenceAsOf, evidenceStale } = found
  const scannedOn = isoDate(evidenceAsOf ?? doc.basedOn.scanRanAt)
  const banner = staleBannerText(company.domain, scannedOn)

  await appendAudit(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    actor: user.id,
    action: 'proposal.exported',
    subjectType: 'proposal',
    subjectId: row.id,
    detail: { companyId: row.companyId, format: 'print' },
  }).catch((err: unknown) => {
    log.warn('proposal export not audited', { proposalId: row.id, err: err instanceof Error ? err.name : 'unknown' })
  })

  const tag = row.status === 'accepted' ? ' on' : row.status === 'declined' || row.status === 'withdrawn' ? ' warn' : ''

  return (
    <main className="main" style={{ maxWidth: 860, margin: '0 auto' }}>
      <style>{PRINT_CSS}</style>
      <p className="crumb print-hide">
        <a href={`/proposals/${row.id}`}>← Back to the proposal</a>
        <span className="muted"> · Print from the browser (Ctrl+P, or ⌘P on a Mac); this line does not print. Nothing on this page sends.</span>
      </p>

      <header>
        <h1>{doc.title}</h1>
        <p className="lede" style={{ marginBottom: 8 }}>
          Prepared for {company.name ?? company.domain} by {preparedBy ? `${preparedBy}, ${agency}` : agency}
          {' · generated '}{isoDate(row.generatedAt.toISOString())}{' '}
          <span className={`tag${tag}`}>{row.status}</span>
        </p>
        <p className="muted" style={{ fontSize: 12.5 }}>{provenanceSentence(company.domain, scannedOn)}</p>
      </header>

      {evidenceStale ? (
        <div className="note note-warn" style={{ margin: '14px 0' }}>
          <strong>{banner.lead}</strong> {banner.rest}
        </div>
      ) : null}

      <ProposalDocument
        doc={doc}
        company={{ domain: company.domain, name: company.name }}
        agency={{ name: agency }}
        status={row.status}
        evidenceAsOf={evidenceAsOf}
        evidenceStale={evidenceStale}
        audience="team"
      />
    </main>
  )
}
