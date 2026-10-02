'use client'

import { useState } from 'react'
import { When } from '@/components/when'
import { SharedNumberHolderNote } from '@/components/shared-number-note'
import { SHARED_NUMBER_LABEL, isSharedNumberOptOutPause } from '@/lib/shared-number-pause'

/**
 * The suppression list, and who is paused (PROMPT.md §2.1, §8.4).
 *
 * "One row there and no channel may ever contact that address, number, or
 * domain again." So this screen is the one place a person sees the whole
 * list, adds to it, and — owner only, audited — takes something off it.
 *
 * The add form's error is the important text on the page. A value that cannot
 * be normalised is refused, and the message says what the consequence of
 * storing it as typed would have been: an opt-out that never matches.
 *
 * Each row carries its source as a tag — how it came to be on the list — in
 * words the page mapped on the server. "unrecorded" is a row from before the
 * source was tracked, and says so rather than borrowing another tag.
 *
 * The paused list offers Resume for every pause; the route refuses, with
 * its sentence, the ones a person may not lift. A shared number's holder
 * reads what lifts theirs beside it (review round 9): this page is where
 * the number they share is recorded, and Resume works once it is. Every row
 * names the person, and a holder's row shows the number the note asks for,
 * with a button that fills it into the form above (review round 10, [7]):
 * a holder imported with a phone and no email was a bare id here, beside a
 * note telling the reader to record a number nothing on the page showed.
 */

export interface SourceView {
  readonly tag: string
  readonly explain: string
}

export interface SuppressionView {
  readonly id: string
  readonly kind: string
  readonly value: string
  readonly reason: string
  /** How the row got here, already in words: `manual`, `reply`, …, or `unrecorded`. */
  readonly source: SourceView
  readonly createdAt: string
}

export interface PausedView {
  readonly id: string
  /** Their name, or "(no name recorded)". */
  readonly name: string
  readonly email: string | null
  /** As stored on their record; shown on a shared number's holder's row. */
  readonly phone: string | null
  readonly pausedAt: string | null
  readonly pausedReason: string | null
}

export function SuppressionsPanel({
  suppressions,
  sources,
  paused,
  canWrite,
  canRemove,
}: {
  suppressions: readonly SuppressionView[]
  /** Every tag a row can carry, for the legend. */
  sources: readonly SourceView[]
  paused: readonly PausedView[]
  canWrite: boolean
  canRemove: boolean
}) {
  const PLACEHOLDER = {
    email: 'someone@example.com',
    domain: 'example.com',
    phone: '+1 415 555 0100',
    linkedin: 'linkedin.com/in/jane-doe',
  } as const
  const [kind, setKind] = useState<'email' | 'domain' | 'phone' | 'linkedin'>('email')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setBusy('add')
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/suppressions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, value, reason }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; alreadyPresent?: boolean; value?: string }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return
      }
      if (body.alreadyPresent) {
        setNotice(`${body.value} was already on the list. Nothing changed.`)
        setValue('')
        return
      }
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (s: SuppressionView): Promise<void> => {
    if (
      !window.confirm(
        `Remove ${s.value} from the suppression list?\n\nThis means they can be contacted again. ` +
          `It was added because: ${s.reason}\nHow it got here: ${s.source.explain}`,
      )
    ) {
      return
    }
    setBusy(s.id)
    try {
      const res = await fetch(`/api/suppressions/${s.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } finally {
      setBusy(null)
    }
  }

  const resume = async (p: PausedView): Promise<void> => {
    setBusy(p.id)
    setError('')
    try {
      const res = await fetch(`/api/contacts/${p.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // The pause this list showed, so the route lifts that one and no
        // other: a pause written since is a 409 saying to reload.
        body: JSON.stringify({ action: 'resume', pausedReason: p.pausedReason }),
      })
      if (res.ok) {
        window.location.reload()
        return
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? 'That did not work.')
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {canWrite ? (
        <div className="row-card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 6px' }}>Add to the list</h3>
          <div className="two-up">
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="email">Email address</option>
                <option value="domain">Whole domain</option>
                <option value="phone">Phone number</option>
                <option value="linkedin">LinkedIn profile</option>
              </select>
            </label>
            <label>
              Value
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={PLACEHOLDER[kind]}
                autoComplete="off"
              />
            </label>
          </div>
          <label>
            Why
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Replied asking us to stop, 12 Sep" />
            <span className="hint">
              Required. A suppression nobody can explain gets removed by whoever finds it, and removing one means
              contacting somebody who asked not to be. It is recorded as <code>manual</code>, with your name on the
              audit line.
            </span>
          </label>
          {error ? <div className="err-line">{error}</div> : null}
          {notice ? <div className="ok-line">{notice}</div> : null}
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busy === 'add' || !value || !reason} onClick={() => void add()}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      ) : null}

      <h2 style={{ fontSize: 15, margin: '18px 0 8px' }}>Suppressed</h2>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        How each row got here:{' '}
        {sources.map((src, i) => (
          <span key={src.tag}>
            {i > 0 ? ' · ' : null}
            <span className="tag" style={{ marginLeft: 0 }}>{src.tag}</span> {src.explain}
          </span>
        ))}
      </p>
      {suppressions.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Nobody is suppressed.</p>
      ) : (
        <div className="rows">
          {suppressions.map((s) => (
            <div key={s.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <code>{s.value}</code>
                  <span className="tag">{s.kind}</span>
                  <span className="tag" title={s.source.explain}>
                    {s.source.tag}
                  </span>
                </div>
                {canRemove ? (
                  <button type="button" className="deny" disabled={busy === s.id} onClick={() => void remove(s)}>
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {s.reason} · <When iso={s.createdAt} mode="date" />
                {s.source.tag === 'unrecorded' ? <> · {s.source.explain}</> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 15, margin: '22px 0 8px' }}>Paused</h2>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Held from every campaign — most often because they replied; each row says why. Nothing further goes to them
        until the pause is lifted.
      </p>
      {paused.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Nobody is paused.</p>
      ) : (
        <div className="rows">
          {paused.map((p) => (
            <div key={p.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <strong>{p.name}</strong> <code>{p.email ?? p.phone ?? p.id}</code>
                </div>
                {canWrite ? (
                  <button type="button" disabled={busy === p.id} onClick={() => void resume(p)}>
                    Resume
                  </button>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {p.pausedReason} · {p.pausedAt ? <When iso={p.pausedAt} /> : null}
                {isSharedNumberOptOutPause(p.pausedReason) ? (
                  <div style={{ marginTop: 2 }}>
                    <SharedNumberHolderNote />
                    {p.phone ? (
                      <div style={{ marginTop: 2 }}>
                        {SHARED_NUMBER_LABEL} <code>{p.phone}</code>
                        {canWrite ? (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="linkish"
                              onClick={() => {
                                setKind('phone')
                                setValue(p.phone ?? '')
                                setError('')
                                setNotice('')
                                window.scrollTo({ top: 0, behavior: 'smooth' })
                              }}
                            >
                              Fill it in above
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
