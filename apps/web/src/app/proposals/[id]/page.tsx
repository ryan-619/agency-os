import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_STALE_AFTER_DAYS, can, isStale, parseIcpDefinition, type Proposal } from '@agency/core'
import { readProposal, schema, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ProposalDocument } from '@/components/pipeline/proposal-document'
import { ProposalLinksSlot } from '@/components/pipeline/proposal-links'
import { ProposalShareSlot } from '@/components/pipeline/proposal-share'
import type { ProposalSlotProps } from '@/components/pipeline/proposal-slot'
import { ProposalStatus } from '@/components/pipeline/proposal-status'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'
import { icpForOrg } from '@/lib/queries'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One proposal, as generated (PROMPT.md §8.6).
 *
 * The document itself is `<ProposalDocument>`, rendered here for the team;
 * this page adds what the team needs around it — the status, the link back
 * to the company, the stale warning, and the slots that hand the document
 * on (print, download, a buyer's link).
 */
export const dynamic = 'force-dynamic'

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const db = getDb() as unknown as AgencyDb
  const [row, icpRow] = await Promise.all([readProposal(db, user.orgId, id), icpForOrg(user.orgId)])
  if (!row) notFound()
  const [company] = await db
    .select({ domain: schema.companies.domain, name: schema.companies.name })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, row.companyId)))
    .limit(1)
  // The FK forbids a proposal without its company; a row that has none
  // anyway is not a page.
  if (!company) notFound()
  const doc = row.document as Proposal

  let orgLabel = 'Agency'
  let staleAfter = DEFAULT_STALE_AFTER_DAYS
  if (icpRow) {
    try {
      const icp = parseIcpDefinition(icpRow.definition)
      orgLabel = icp.label
      staleAfter = icp.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS
    } catch {
      orgLabel = 'Agency'
    }
  }

  // §2.2. The generator refuses to write a proposal from a stale scan — but a
  // proposal written while the scan was fresh keeps sitting here, and the
  // evidence underneath it ages out on its own. Freshness is DERIVED from the
  // scan's ran_at on every read, the way the meeting brief does it; reading a
  // stored flag is how a three-week-old gap renders with no mark on it.
  const [scan] = await db
    .select({ ranAt: schema.scans.ranAt })
    .from(schema.scans)
    .where(and(eq(schema.scans.orgId, user.orgId), eq(schema.scans.id, row.scanId)))
    .limit(1)
  const evidenceStale = isStale(scan?.ranAt, staleAfter)
  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }
  const canWrite = can({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  const slot: ProposalSlotProps = { orgId: user.orgId, proposalId: row.id, status: row.status, evidenceStale, canWrite }

  return (
    <Shell user={user} orgName={orgLabel} current="pipeline" signOut={signOutAction}>
      <p className="crumb"><a href="/pipeline">← Pipeline</a></p>
      <h1>{doc.title}</h1>
      <p className="lede">
        <span className={`tag${row.status === 'accepted' ? ' on' : row.status === 'declined' || row.status === 'withdrawn' ? ' warn' : ''}`}>{row.status}</span>
        {' · '}
        <a href={`/companies/${encodeURIComponent(company.domain)}`}>{company.name ?? company.domain}</a>
        {' · generated '}<When iso={row.generatedAt.toISOString()} />
        {row.decidedAt ? <> · decided <When iso={row.decidedAt.toISOString()} /></> : null}
      </p>
      {evidenceStale ? (
        <div className="note note-warn">
          <strong>The evidence under this proposal has aged out.</strong> It was written from a scan that ran{' '}
          {scan ? <When iso={scan.ranAt.toISOString()} mode="date" /> : 'more than'} — more than {staleAfter} days ago.
          §2.2 says stale findings are re-verified before they appear in anything outbound, so re-scan{' '}
          <code>{company.domain}</code> and generate a fresh proposal rather than sending this one.
        </div>
      ) : null}
      <ProposalStatus id={row.id} status={row.status} canWrite={canWrite} />
      <ProposalLinksSlot {...slot} />
      <ProposalShareSlot {...slot} />

      <ProposalDocument
        doc={doc}
        company={{ domain: company.domain, name: company.name }}
        agency={{ name: orgLabel }}
        status={row.status}
        evidenceAsOf={scan ? scan.ranAt.toISOString() : null}
        evidenceStale={evidenceStale}
        audience="team"
      />
    </Shell>
  )
}
