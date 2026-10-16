import { COMPANY_SUMMARY_NOTE, companySummary, type CompanySummary } from '@agency/core'
import { companySummaryFacts, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import type { CompanySlotProps } from './slot'

/**
 * At a glance (2026-10-16): what the cards below say, in a dozen lines, at
 * the top of the company page.
 *
 * Every word is `companySummary`'s (packages/core), over facts read with the
 * latest scan read once (`companySummaryFacts`). Nothing is stored, nothing
 * is written or audited by reading it, no model is asked, and there is no
 * script: the lines are plain text, which React escapes. A fault costs this
 * card only — an error escaping a server component renders `app/error.tsx`
 * for the whole page — and is logged by its class, never its message, which
 * from the driver quotes a query and its bound values.
 */
export async function SummarySlot(props: CompanySlotProps) {
  let summary: CompanySummary | null
  try {
    const db = getDb() as unknown as AgencyDb
    const now = new Date()
    const facts = await companySummaryFacts(db, { orgId: props.orgId, companyId: props.companyId, now })
    summary = facts ? companySummary(facts, now) : null
  } catch (err) {
    log.warn('the company summary could not be read', { companyId: props.companyId, error: err instanceof Error ? err.name : 'UnknownError' })
    return null
  }
  if (!summary) return null

  return (
    <section className="card" style={{ marginTop: 0, marginBottom: 18 }}>
      <h2 style={{ marginTop: 0 }}>At a glance</h2>
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{summary.headline}</p>
      <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
        {summary.lines.map((l, i) => (
          <li key={i} className={l.kind === 'not_assessed' || l.kind === 'recorded' || l.kind === 'research' ? 'hint' : undefined} style={{ marginBottom: 3 }}>
            {l.text}
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{COMPANY_SUMMARY_NOTE}</p>
    </section>
  )
}
