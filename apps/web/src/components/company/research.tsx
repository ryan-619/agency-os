import { researchFor, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { ResearchPanel, type ResearchItem } from './research-panel'
import type { CompanySlotProps } from './slot'

/**
 * The company page's research slot (0028): what was found out about the
 * company, each claim with the page it came from. Headed as research, never
 * evidence, so nobody reads it as something the scanner saw.
 */
export async function ResearchSlot(props: CompanySlotProps & { readonly isOwner: boolean }) {
  const db = getDb() as unknown as AgencyDb
  const rows = await researchFor(db, props.orgId, props.companyId).catch(() => [])
  const items: ResearchItem[] = rows.map((r) => {
    let host = r.sourceUrl
    try {
      host = new URL(r.sourceUrl).hostname.replace(/^www\./, '')
    } catch {
      // Stored only when it parsed; shown whole otherwise.
    }
    return {
      id: r.id,
      claim: r.claim,
      sourceUrl: r.sourceUrl,
      sourceTitle: r.sourceTitle,
      sourceHost: host,
      recordedBy: r.recordedBy,
      recordedByLabel: r.recordedBy ? r.recordedByName?.trim() || r.recordedByEmail || 'a teammate' : 'the assistant',
      createdAt: r.createdAt.toISOString(),
    }
  })
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Research</h2>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
        What was found out about this company, each claim with the page it came from. Research, never evidence:
        nothing here was observed by the scanner, and nothing here is quoted to them — open the source before you rely on it.
      </p>
      <ResearchPanel items={items} currentUserId={props.userId} isOwner={props.isOwner} canWrite={props.canWrite} />
    </section>
  )
}
