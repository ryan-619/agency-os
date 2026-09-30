import type { DiffInput, FindingDiff, FindingDiffRow } from '@agency/core'
import type { EvidenceScan } from '@agency/db/queries'
import { When } from '@/components/when'
import { CHANGE_WORDS, readingWords } from '@/lib/timeline'

/**
 * What changed between the two most recent scans that reached the site
 * (PROMPT.md §2.2).
 *
 * The labels are `diffFindings`' state machine read aloud, and the rule is on
 * the panel, not only in a comment: a signal the newer scan could not observe
 * is "not assessed this time", never "fixed". A timeout on `/security` is not
 * evidence that somebody wrote a security page.
 *
 * Every row shows BOTH scans' evidence, so the label can be checked against
 * what each scan recorded rather than taken on trust. When the newer scan is
 * past the freshness threshold (derived from its `ran_at`), the rows carry
 * the stale mark the page's own table uses: a diff may be read when stale,
 * never quoted.
 */
export interface EvidenceDiffProps {
  readonly changes: { readonly newer: EvidenceScan; readonly older: EvidenceScan; readonly diff: FindingDiff } | null
  readonly stale: boolean
  readonly staleAfterDays: number
  /** Scans between the two that never reached the site; null when they are not all in view. */
  readonly skippedUnreachable: number | null
  /** The most recent scan of all is one that did not reach the site. */
  readonly latestUnreachable: boolean
  readonly domain: string
}

/** The same key/value reading of a finding's evidence the page's own table uses. */
function evidenceLines(evidence: Readonly<Record<string, unknown>>): Array<[string, string]> {
  return Object.entries(evidence).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
}

function Side({ d }: { d: DiffInput | null }): React.ReactNode {
  const reading = readingWords(d)
  const lines = d ? evidenceLines(d.evidence) : []
  return (
    <>
      <span
        className={`tag${reading === 'gap' ? ' warn' : reading === 'in place' ? ' on' : ''}`}
        style={{ marginLeft: 0 }}
      >
        {reading}
      </span>
      {d?.detail ? <div className="mono muted" style={{ fontSize: 11.5, marginTop: 2 }}>{d.detail}</div> : null}
      {lines.length ? (
        <dl className="evidence" style={{ marginTop: 4 }}>
          {lines.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              {/* Not truncated, as in the page's table: `.evidence dd` scrolls. */}
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  )
}

function Row({ r, stale }: { r: FindingDiffRow; stale: boolean }): React.ReactNode {
  const words = CHANGE_WORDS[r.change]
  return (
    <tr className={stale ? 'row-stale' : undefined}>
      <td className="mono">
        {r.signalKey}
        {r.scored ? null : <div className="muted" style={{ fontSize: 11.5 }}>not scored</div>}
        {stale ? <span className="pill pill-stale">stale</span> : null}
      </td>
      <td>
        <strong className={words.className || undefined}>{words.label}</strong>
        <div className="muted" style={{ fontSize: 11.5 }}>{words.explain}</div>
      </td>
      <td><Side d={r.older} /></td>
      <td><Side d={r.newer} /></td>
    </tr>
  )
}

export function EvidenceDiff(p: EvidenceDiffProps): React.ReactNode {
  return (
    <>
      <h2>What changed since the last successful scan</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        What changed — a signal the scanner could not observe this time is listed as not assessed,
        never as fixed. A timeout or a blocked fetch is evidence of nothing.
      </p>
      {!p.changes ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Fewer than two scans have reached the site, so there is nothing to compare yet. That is not
          the same as nothing having changed.
        </p>
      ) : (
        <DiffBody {...p} changes={p.changes} />
      )}
    </>
  )
}

function DiffBody(p: EvidenceDiffProps & { readonly changes: NonNullable<EvidenceDiffProps['changes']> }): React.ReactNode {
  const { newer, older, diff } = p.changes
  const changed = diff.rows.filter((r) => r.change !== 'unchanged')
  const unchanged = diff.rows.filter((r) => r.change === 'unchanged')
  const s = diff.summary

  return (
    <>
      <p style={{ fontSize: 13, margin: '0 0 8px' }}>
        Compared the scan of <span className="mono"><When iso={older.ranAt.toISOString()} /></span> with
        the scan of <span className="mono"><When iso={newer.ranAt.toISOString()} /></span>
        {p.stale ? <span className="pill pill-stale">stale</span> : null}
        {' · '}
        <span className="diff-fixed">{s.fixed} fixed</span>
        {' · '}
        <span className="diff-regressed">{s.regressed} regressed</span>
        {' · '}
        <span className="diff-not-assessed">{s.notAssessed} not assessed this time</span>
        {' · '}
        {s.nowObserved} observed this time
      </p>
      {p.latestUnreachable ? (
        <p className="hint">
          The most recent scan did not reach the site, so it is not compared; these are the two
          successful scans before it.
        </p>
      ) : null}
      {p.skippedUnreachable !== null && p.skippedUnreachable > 0 ? (
        <p className="hint">
          {p.skippedUnreachable === 1
            ? '1 scan between these two did not reach the site and is skipped.'
            : `${p.skippedUnreachable} scans between these two did not reach the site and are skipped.`}
        </p>
      ) : null}
      {p.stale ? (
        <div className="note note-warn">
          <strong>The newer scan is stale.</strong> It ran more than {p.staleAfterDays} days ago, so
          this comparison may no longer describe the site. Re-scan before relying on it:{' '}
          <code>npm run scan -- {p.domain}</code>.
        </div>
      ) : null}

      {changed.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Every signal was observed the same way on both scans.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th>Change</th>
              <th>Older scan</th>
              <th>Newer scan</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((r) => <Row key={r.signalKey} r={r} stale={p.stale} />)}
          </tbody>
        </table>
      )}

      {unchanged.length ? (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>
            {unchanged.length === 1 ? '1 signal' : `${unchanged.length} signals`} observed the same way on both scans
          </summary>
          <table>
            <tbody>
              {unchanged.map((r) => <Row key={r.signalKey} r={r} stale={p.stale} />)}
            </tbody>
          </table>
        </details>
      ) : null}
    </>
  )
}
