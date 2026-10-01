import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { assertCan, isStale, type Proposal } from '@agency/core'
import { appendAudit, readProposal, schema, shareEvidenceSuperseded, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { readIcp } from '@/lib/company-list'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import {
  proposalMarkdownFilename, proposalToMarkdown, staleDraftRefusal, supersededDraftRefusal,
} from '@/lib/proposal-markdown'
import { icpForOrg } from '@/lib/queries'

/**
 * A proposal as a Markdown file (PROMPT.md §8.6).
 *
 * The stored document, rendered — never regenerated from today's scan. The
 * file goes wherever a person takes it; this route hands it over and sends
 * nothing (§8.4). Sending is a person's act, from their own mail.
 *
 * §2.2 decides two cases. A DRAFT whose evidence has aged out is refused with
 * 409 `{ reason: 'stale' }`: a draft is the thing about to be sent, and stale
 * findings are re-verified before they appear in anything outbound. A DRAFT
 * whose scan has been superseded by a newer successful one is refused with
 * 409 `{ reason: 'superseded' }`, because only the latest scan is quoted and
 * the newer one may show a priced gap closed (round 3, finding [6]). The page
 * says both before the link is pressed. A proposal past draft is a record of
 * what was sent, so it is exported — with the stale banner in the file.
 * Freshness is derived from the scan's `ran_at` here, as on the page; the
 * stored document cannot know how old it has become.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:read')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })
  const db = getDb() as unknown as AgencyDb
  const [row, icpRow] = await Promise.all([readProposal(db, user.orgId, id), icpForOrg(user.orgId)])
  if (!row) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })

  // The company, the agency and whoever generated it are joined now rather
  // than copied out of the document: a renamed company or teammate is shown
  // as they are called today. The agency is the org's name — the same name
  // the generator wrote the summary in — never the ICP's label.
  const [[company], [org], [scan], [preparer]] = await Promise.all([
    db
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, user.orgId), eq(schema.companies.id, row.companyId)))
      .limit(1),
    db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, user.orgId)).limit(1),
    db
      .select({ ranAt: schema.scans.ranAt })
      .from(schema.scans)
      .where(and(eq(schema.scans.orgId, user.orgId), eq(schema.scans.id, row.scanId)))
      .limit(1),
    row.createdBy
      ? db
          .select({ name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(and(eq(schema.users.orgId, user.orgId), eq(schema.users.id, row.createdBy)))
          .limit(1)
      : Promise.resolve([]),
  ])
  if (!company) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })

  // Guarded: `isStale` throws on a threshold that is not a positive number,
  // and a malformed ICP is not a reason to fail a download.
  const evidenceStale = isStale(scan?.ranAt, readIcp(icpRow?.definition).staleAfterDays)
  if (row.status === 'draft' && evidenceStale) {
    return NextResponse.json({ error: staleDraftRefusal(company.domain), reason: 'stale' }, { status: 409 })
  }
  // Compared in SQL against the stored ran_at (`shareEvidenceSuperseded`),
  // as the share link compares it; an unreachable newer scan supersedes nothing.
  const evidenceSuperseded = row.status === 'draft' ? await shareEvidenceSuperseded(db, user.orgId, row.id) : false
  if (row.status === 'draft' && evidenceSuperseded) {
    return NextResponse.json({ error: supersededDraftRefusal(company.domain), reason: 'superseded' }, { status: 409 })
  }

  const doc = row.document as Proposal
  const markdown = proposalToMarkdown({
    doc,
    company: { domain: company.domain, name: company.name },
    agency: { name: org?.name ?? 'Agency' },
    status: row.status,
    evidenceAsOf: scan ? scan.ranAt.toISOString() : null,
    evidenceStale,
    preparedBy: preparer ? (preparer.name ?? preparer.email) : null,
  })

  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'proposal.exported',
    subjectType: 'proposal',
    subjectId: row.id,
    detail: { companyId: row.companyId, format: 'markdown' },
  }).catch((err: unknown) => {
    log.warn('proposal export not audited', { proposalId: row.id, err: err instanceof Error ? err.name : 'unknown' })
  })

  return new Response(markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${proposalMarkdownFilename(company.domain, doc.generatedAt)}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
