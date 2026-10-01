import { informationalSection } from '@agency/core'
import { latestInformationalFindings, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import type { CompanySlotProps } from './slot'

/** The same key/value reading of a finding's evidence the scored table uses. */
function evidenceLines(evidence: Readonly<Record<string, unknown>>): Array<[string, string]> {
  return Object.entries(evidence).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
}

/**
 * The signals the scanner observed but does not score — context about the
 * public surface, never a gap, a strength or a missing observation. Mounted
 * after "Not observed" and before the scan table.
 *
 * Reads the LATEST scan, the one the page above describes, and renders
 * nothing when that scan never reached the site (the page says so itself).
 * Freshness comes from the scan's `ran_at` through `informationalSection`,
 * with the same threshold and the same stale mark as the scored table: these
 * rows are never quoted, but they are still statements about somebody's site.
 */
export async function InformationalSlot(props: CompanySlotProps): Promise<React.ReactNode> {
  const found = await latestInformationalFindings(getDb() as unknown as AgencyDb, props.orgId, props.companyId)
  if (!found || found.findings.length === 0) return null

  const { stale, rows } = informationalSection({
    scan: found.scan,
    findings: found.findings,
    staleAfterDays: props.staleAfterDays,
  })

  return (
    <section className="informational">
      <h2 style={{ marginTop: 0 }}>Also observed (not scored)</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        These are observed from the outside like everything above, but they are not part of the
        score and nothing quotes them in outreach.
      </p>
      {stale ? (
        <div className="note note-warn">
          <strong>These observations are stale.</strong> They were made more than{' '}
          {props.staleAfterDays} days ago and may no longer describe the site. Re-scan before relying
          on them: <code>npm run scan -- {props.domain}</code>.
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Signal</th>
            <th>Why it is recorded</th>
            <th>Result</th>
            <th>What was observed</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={stale ? 'row-stale' : undefined}>
              <td>
                {r.label}
                <div className="mono muted" style={{ fontSize: 11.5 }}>{r.key}</div>
                {stale ? <span className="pill pill-stale">stale</span> : null}
              </td>
              <td className="muted" style={{ fontSize: 12.5 }}>{r.why ?? '—'}</td>
              <td>
                <span className={`tag${r.status === 'gap' ? ' warn' : ''}`}>{r.status}</span>
              </td>
              <td className="mono" style={{ fontSize: 12.5 }}>{r.detail ?? '—'}</td>
              <td>
                <dl className="evidence">
                  {evidenceLines(r.evidence).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      {/* Not truncated, as in the scored table: `.evidence dd` scrolls. */}
                      <dd className="mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
