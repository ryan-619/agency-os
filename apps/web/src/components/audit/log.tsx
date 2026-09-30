import { When } from '@/components/when'

/**
 * The audit log, as lines a person can read (PROMPT.md §2.4).
 *
 * A server component over rows the page has ALREADY reduced: the sentence,
 * who, where it links, and the raw detail already passed through `redact()`.
 * Nothing here reads the database or decides what a row means — that is
 * `lib/audit-copy.ts`, which is pure and tested — so this file is layout.
 *
 * The raw row is one click away rather than absent, because a sentence is an
 * interpretation and the record is what an auditor checks it against. An
 * alarm row — an opt-out that was not stored, a call with no AI disclosure —
 * is marked where it sits instead of being filtered to a page nobody opens.
 */

export interface AuditLineView {
  readonly id: string
  readonly at: string
  readonly who: string
  /** "access since revoked", or null. */
  readonly whoNote: string | null
  /** True when `who` is a person rather than a process. */
  readonly isPerson: boolean
  readonly sentence: string
  readonly href: string | null
  readonly alarm: boolean
  readonly action: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  /** Pretty-printed and redacted. */
  readonly detail: string
}

export function AuditLog({ lines }: { lines: readonly AuditLineView[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 150 }}>When</th>
          <th style={{ width: 170 }}>Who</th>
          <th>What</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td className="mono">
              <When iso={l.at} />
            </td>
            <td>
              {l.isPerson ? <strong>{l.who}</strong> : <span className="muted">{l.who}</span>}
              {l.whoNote ? (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {l.whoNote}
                </div>
              ) : null}
            </td>
            <td>
              <div>
                {l.alarm ? <span className="tag warn" style={{ marginLeft: 0, marginRight: 6 }}>needs a person</span> : null}
                {l.sentence}
                {l.href ? (
                  <>
                    {' '}
                    <a href={l.href} style={{ whiteSpace: 'nowrap' }}>
                      open →
                    </a>
                  </>
                ) : null}
              </div>
              <details style={{ marginTop: 3 }}>
                <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                  <code>{l.action}</code>
                  {l.subjectType ? (
                    <span>
                      {' '}
                      on {l.subjectType}
                      {l.subjectId ? <> <code>{l.subjectId.slice(0, 8)}</code></> : null}
                    </span>
                  ) : null}
                </summary>
                <pre
                  style={{
                    margin: '6px 0 2px',
                    fontSize: 11.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: 4,
                    padding: '6px 8px',
                  }}
                >
                  {l.detail}
                </pre>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
