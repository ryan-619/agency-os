'use client'

import { useState } from 'react'
import { toast } from '../toast/toast'
import { ToastOn } from '../toast/toast-on'

/**
 * What a person can record about a meeting from its brief: that it was held,
 * that nobody turned up, that it moved, or that it is off.
 *
 * The route decides; this offers only what it will accept and says what each
 * does. An outcome needs the meeting to have started — "held" about next
 * Tuesday is a claim about the future — so until then the only action is
 * Cancel, and the hint says how to move it instead. A recorded outcome may
 * be corrected (a mis-click on "held" is fixed by "no-show"), so every
 * outcome but the current one stays on offer.
 *
 * Nothing here tells anybody anything; no invitation was sent from here, so
 * there is none to move or withdraw, and the copy says so where it matters.
 */
const OUTCOMES = [
  { outcome: 'held', label: 'Held', note: 'It happened. The deal stays where it is; move it on the board.' },
  { outcome: 'no_show', label: 'No-show', note: 'They did not turn up. The deal is not moved — a no-show is not a lost deal.' },
] as const

export function MeetingActions({
  id,
  timeZone,
  started,
  cancelled,
  outcome,
  canWrite,
}: {
  id: string
  /** The meeting's own zone: a new time is entered in it, not the viewer's. */
  timeZone: string
  /** Whether it had started when the page was rendered. The route re-checks. */
  started: boolean
  cancelled: boolean
  outcome: string | null
  canWrite: boolean
}) {
  const [mode, setMode] = useState<'idle' | 'reschedule'>('idle')
  const [local, setLocal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  if (!canWrite || cancelled) return null

  const patch = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch(`/api/meetings/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(typeof out.error === 'string' ? out.error : 'That did not work.')
        return null
      }
      return out
    } catch {
      setError('The request did not complete. Try again.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const record = async (to: string): Promise<void> => {
    if (await patch({ action: 'outcome', outcome: to })) {
      toast.afterReload(to === 'no_show' ? 'Recorded as a no-show.' : 'Recorded as held.')
      window.location.reload()
    }
  }

  const cancel = async (): Promise<void> => {
    if (!window.confirm('Cancel this meeting? Nobody is told — if you sent an invitation from your calendar, cancel it there too.')) return
    const out = await patch({ action: 'cancel' })
    if (out) {
      const note = typeof out.note === 'string' ? out.note : 'Cancelled.'
      setDone(note)
      // Said again once the page has reloaded: 900 ms is too short to read it.
      toast.afterReload(note)
      setTimeout(() => window.location.reload(), 900)
    }
  }

  const reschedule = async (): Promise<void> => {
    if (!local) {
      setError('Pick the new date and time.')
      return
    }
    // A datetime-local input can carry seconds; the route takes minutes.
    const out = await patch({ action: 'reschedule', startsAtLocal: local.slice(0, 16), timeZone })
    if (out && typeof out.replacement === 'string') {
      const note = typeof out.note === 'string' ? out.note : 'Recorded at the new time.'
      setDone(note)
      // Said again on the new meeting's page, which this tab opens next: 900 ms is too short to read it.
      toast.afterReload(note)
      setTimeout(() => window.location.assign(`/meetings/${out.replacement as string}`), 900)
    }
  }

  return (
    <div style={{ marginBottom: 22 }}>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <ToastOn message={done} />

      {mode === 'idle' ? (
        <div className="row-actions" style={{ marginTop: 6 }}>
          {started && outcome === 'rescheduled' ? (
            // The route refuses to overwrite a reschedule: the replacement it
            // recorded would be orphaned, and a second reschedule would make
            // another. What happened is recorded on the new meeting.
            <span className="hint" style={{ alignSelf: 'center', marginTop: 0 }}>
              Rescheduled — record what happened on the new meeting.
            </span>
          ) : started ? (
            <>
              {OUTCOMES.filter((o) => o.outcome !== outcome).map((o) => (
                <button key={o.outcome} type="button" disabled={busy} title={o.note} onClick={() => void record(o.outcome)}>
                  {o.label}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                title="It happened, or will, at another time. Records the new meeting and links the two."
                onClick={() => { setError(null); setMode('reschedule') }}
              >
                Rescheduled…
              </button>
            </>
          ) : null}
          {outcome === null ? (
            <button type="button" className="deny" disabled={busy} title="Call it off. Nobody is told." onClick={() => void cancel()}>
              Cancel meeting
            </button>
          ) : null}
          {!started ? (
            <span className="hint" style={{ alignSelf: 'center', marginTop: 0 }}>
              Held, no-show and rescheduled can be recorded once it has started. To move it before then, cancel it
              and book the new time from the company page.
            </span>
          ) : null}
        </div>
      ) : (
        <form
          className="row-card slim"
          style={{ marginTop: 6 }}
          onSubmit={(e) => { e.preventDefault(); void reschedule() }}
        >
          <label>
            New time
            <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} required />
            <span className="hint">
              Entered in <strong>{timeZone}</strong>, the meeting&rsquo;s zone — not yours. The new meeting keeps its
              contact, length and notes; this one is marked rescheduled and linked to it. No invitation is sent — move the
              event in your calendar.
            </span>
          </label>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>Record the new time</button>
            <button type="button" className="deny" disabled={busy} onClick={() => setMode('idle')}>Back</button>
          </div>
        </form>
      )}
    </div>
  )
}
