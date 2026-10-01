import { When } from '@/components/when'
import type { TimelineEvent, TimelineTone } from '@/lib/timeline'

/**
 * Everything that happened to a company, newest first, in one list: scans
 * with the score each produced, messages in both directions (refusals
 * included, with their reason), deal moves, meetings, proposals, calls and
 * notes.
 *
 * Layout only — `mergeTimeline` in `lib/timeline.ts` decided the order and
 * the words. The newest lines are open and the rest fold away, because this
 * sits above the company's actions and a long history must not push them off
 * the screen.
 */
export interface TimelineProps {
  readonly events: readonly TimelineEvent[]
  /** The history is whole from here; older lines were cut at a source's limit. */
  readonly since: Date | null
}

/** Shown before the fold. */
const OPEN = 15

const TONE_TAG: Readonly<Record<TimelineTone, string>> = {
  plain: 'tag',
  good: 'tag on',
  warn: 'tag warn',
  muted: 'tag',
}

function Item({ e }: { e: TimelineEvent }): React.ReactNode {
  const tail = [...e.facts, ...(e.by ? [e.by] : [])]
  return (
    <li className="timeline-item" style={e.stale ? { opacity: 0.75 } : undefined}>
      <span className="k"><When iso={e.at.toISOString()} /></span>
      <span className={TONE_TAG[e.tone]} style={{ marginLeft: 0 }}>{e.label}</span>
      {e.stale ? <span className="pill pill-stale">stale</span> : null}
      <div className={e.tone === 'muted' ? 'muted' : undefined} style={{ marginTop: 2 }}>
        {e.href ? <a href={e.href}>{e.text}</a> : e.text}
      </div>
      {tail.length ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {tail.join(' · ')}
        </div>
      ) : null}
    </li>
  )
}

export function Timeline({ events, since }: TimelineProps): React.ReactNode {
  const open = events.slice(0, OPEN)
  const folded = events.slice(OPEN)
  return (
    <section className="card" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>Everything that happened</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Scans with the score each one produced, every message in either direction, deal moves,
        meetings, proposals, calls and notes, newest first. A note is a teammate&apos;s words, shown
        with whose they are — never evidence.
      </p>
      {events.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Nothing has happened with this company yet.</p>
      ) : (
        <>
          <ol className="timeline">
            {open.map((e) => <Item key={`${e.kind}:${e.id}`} e={e} />)}
          </ol>
          {folded.length ? (
            <details style={{ marginTop: 4 }}>
              <summary className="muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                {folded.length} older {folded.length === 1 ? 'line' : 'lines'}
              </summary>
              <ol className="timeline" style={{ marginTop: 8 }}>
                {folded.map((e) => <Item key={`${e.kind}:${e.id}`} e={e} />)}
              </ol>
            </details>
          ) : null}
        </>
      )}
      {since ? (
        <p className="hint">
          Complete from <When iso={since.toISOString()} mode="date" /> onwards. Older lines are left
          out rather than merged, because sources cut at different points would show the gap as a
          quiet stretch. Every recorded action is on the <a href="/audit">audit log</a>.
        </p>
      ) : null}
    </section>
  )
}
