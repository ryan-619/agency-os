import { isStale } from '@agency/core'
import type { ScanHistoryRow } from '@agency/db/queries'
import { When } from '@/components/when'
import { newestOkScanId, scanScoreWords } from '@/lib/timeline'

/**
 * Score history: one row per scan, each with the score computed FROM that
 * scan (`scores.scan_id`), never the score whose time happens to sit near it.
 *
 * A scan that did not reach the site says "unreachable" and why — never 0,
 * which would put a timeout on a chart beside real measurements. Each row
 * names the ICP profile it was scored against, and a row scored against a
 * different profile from the newest one says so: the same site scores
 * differently under different weights, and a drop that is really a changed
 * profile is not a change in the company.
 *
 * Only the newest scan that reached the site is marked stale — it is the one
 * the page's evidence comes from. Freshness is derived from `ran_at`.
 */
export interface ScoreHistoryProps {
  readonly rows: readonly ScanHistoryRow[]
  readonly profiles: ReadonlyMap<string, string>
  readonly staleAfterDays: number
  readonly now: Date
  /** The table holds the newest scans only; older ones exist. */
  readonly truncated: boolean
}

export function ScoreHistory({ rows, profiles, staleAfterDays, now, truncated }: ScoreHistoryProps): React.ReactNode {
  const newestOk = newestOkScanId(rows)
  const currentProfile = rows.find((r) => r.score !== null)?.score?.icpProfileId ?? null

  return (
    <>
      <h2>Score history</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Score history — each row is one scan and the score computed from it. A scan that could not
        reach the site observed nothing, so it has no score: it says unreachable, never 0.
      </p>
      <table className="history-table">
        <thead>
          <tr>
            <th>Ran</th>
            <th>Reached the site</th>
            <th>Score</th>
            <th>Scored against</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const words = scanScoreWords(r)
            const stale = r.scan.id === newestOk && isStale(r.scan.ranAt, staleAfterDays, now)
            const profileId = r.score?.icpProfileId ?? null
            return (
              <tr key={r.scan.id} className={stale ? 'row-stale' : undefined}>
                <td className="mono">
                  <When iso={r.scan.ranAt.toISOString()} />
                  {stale ? <span className="pill pill-stale">stale</span> : null}
                </td>
                <td className="mono">{r.scan.ok ? 'yes' : 'no'}</td>
                <td>
                  {words.unreachable ? (
                    <>
                      <span className="tag warn" style={{ marginLeft: 0 }}>unreachable</span>
                      {r.scan.error ? (
                        <div className="mono muted" style={{ fontSize: 11.5 }}>{r.scan.error}</div>
                      ) : null}
                    </>
                  ) : (
                    <span className="mono">{words.text}</span>
                  )}
                </td>
                <td>
                  {profileId ? (
                    <>
                      {profiles.get(profileId) ?? 'a profile no longer on file'}{' '}
                      <span className="mono muted" style={{ fontSize: 11.5 }}>{profileId.slice(0, 8)}</span>
                      {currentProfile && profileId !== currentProfile ? (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          a different profile from the newest score — not comparable
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.some((r) => r.scan.id === newestOk && isStale(r.scan.ranAt, staleAfterDays, now)) ? (
        <p className="hint">
          The newest scan that reached the site is older than {staleAfterDays} days, so its findings
          must be re-verified before anything quotes them.
        </p>
      ) : null}
      {truncated ? (
        <p className="hint">The {rows.length} most recent scans. Older scans are kept but not listed here.</p>
      ) : null}
    </>
  )
}
