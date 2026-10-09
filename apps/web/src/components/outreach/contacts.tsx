'use client'

import { useState } from 'react'
import { When } from '@/components/when'
import { SharedNumberHolderNote } from '@/components/shared-number-note'
import { isSharedNumberOptOutPause } from '@/lib/shared-number-pause'
import { toast } from '../toast/toast'

/**
 * The people at a company (PROMPT.md §2.1, §8.4).
 *
 * The two facts the send path will demand are the two this section makes
 * visible per person: a timezone (or nothing can be sent to them), and what
 * consent is recorded per channel (absence means NO for SMS and voice). The
 * form asks for the timezone and says why; it does not create consent, which
 * is recorded deliberately, one channel at a time, with a source.
 *
 * Resume is offered for every pause, and the route refuses, with its
 * sentence, the ones a person may not lift. A shared number's holder also
 * reads what lifts theirs (review round 9): a text from a number they share
 * asked to stop and could not be recorded, so the number goes on the
 * suppression list first — the words /contacts uses.
 */

export interface ContactView {
  readonly id: string
  readonly name: string
  readonly title: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly linkedinUrl: string | null
  readonly timeZone: string | null
  readonly pausedAt: string | null
  readonly pausedReason: string | null
  readonly consents: readonly { readonly channel: string; readonly granted: boolean; readonly source: string }[]
}

/** A consent channel as the pop-up names it. */
const CHANNEL_WORDS: Readonly<Record<string, string>> = { email: 'email', sms: 'SMS', voice: 'voice', whatsapp: 'WhatsApp' }

export function ContactsPanel({
  companyId,
  contacts,
  canWrite,
}: {
  companyId: string
  contacts: readonly ContactView[]
  canWrite: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  /** `done` is the pop-up once the route has taken it. */
  const patch = async (id: string, body: Record<string, unknown>, done: string): Promise<void> => {
    setBusy(id)
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await fetch(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setErrors((e) => ({ ...e, [id]: b.error ?? 'That did not work.' }))
        return
      }
      toast.afterReload(done)
      window.location.reload()
    } catch {
      setErrors((e) => ({ ...e, [id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  const consent = async (id: string, channel: string, granted: boolean): Promise<void> => {
    const source = window.prompt(
      `Where did this ${granted ? 'consent' : 'refusal'} for ${channel} come from? (a form, a call, a reply — it is recorded)`,
    )
    if (source === null) return
    if (!source.trim()) {
      setErrors((e) => ({ ...e, [id]: 'A consent needs a source — where it came from is the record.' }))
      return
    }
    setBusy(id)
    try {
      const res = await fetch(`/api/contacts/${id}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, granted, source }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setErrors((e) => ({ ...e, [id]: b.error ?? 'That did not work.' }))
        return
      }
      toast.afterReload(`${granted ? 'Opt-in' : 'Refusal'} recorded for ${CHANNEL_WORDS[channel] ?? channel}.`)
      window.location.reload()
    } catch {
      setErrors((e) => ({ ...e, [id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card" style={{ marginTop: 18 }}>
      <h2>People</h2>
      {contacts.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Nobody recorded here yet. A draft about this company cannot be approved until there is someone
          to send it to.
        </p>
      ) : (
        <div className="rows">
          {contacts.map((c) => (
            <div key={c.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <strong>{c.name}</strong>
                  {c.title ? <span className="muted" style={{ marginLeft: 6, fontSize: 12.5 }}>{c.title}</span> : null}
                  {c.pausedAt ? <span className="tag warn">paused</span> : null}
                </div>
                {canWrite ? (
                  <div className="row-actions">
                    {c.pausedAt ? (
                      <button
                        type="button"
                        disabled={busy === c.id}
                        onClick={() => void patch(c.id, { action: 'resume', pausedReason: c.pausedReason }, 'Pause lifted.')}
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === c.id}
                        onClick={() => {
                          const reason = window.prompt('Why pause them? (kept with the pause)')
                          if (reason?.trim()) {
                            void patch(c.id, { action: 'pause', reason }, 'Paused. Nothing further goes to them until the pause is lifted.')
                          }
                        }}
                      >
                        Pause
                      </button>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="muted" style={{ fontSize: 12.5 }}>
                {c.email ? <code>{c.email}</code> : null}
                {c.phone ? <code style={{ marginLeft: 8 }}>{c.phone}</code> : null}
                {c.linkedinUrl ? (
                  <a href={c.linkedinUrl} style={{ marginLeft: 8 }} target="_blank" rel="noreferrer">
                    LinkedIn
                  </a>
                ) : null}
              </div>

              <div style={{ fontSize: 12.5, marginTop: 6 }}>
                {c.timeZone ? (
                  <span>
                    Timezone <code>{c.timeZone}</code>
                  </span>
                ) : (
                  <span className="err-line" style={{ marginTop: 0 }}>
                    No timezone — nothing can be sent to them until one is set, because quiet hours cannot be checked.
                  </span>
                )}
                {canWrite ? (
                  <button
                    type="button"
                    style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
                    disabled={busy === c.id}
                    onClick={() => {
                      const zone = window.prompt('IANA timezone, e.g. Europe/London or America/New_York', c.timeZone ?? '')
                      if (zone !== null) {
                        // The route stores a blank as no zone.
                        void patch(c.id, { action: 'timeZone', timeZone: zone }, zone.trim() ? 'Timezone saved.' : 'Timezone cleared.')
                      }
                    }}
                  >
                    {c.timeZone ? 'Change' : 'Set timezone'}
                  </button>
                ) : null}
              </div>

              {c.pausedAt ? (
                <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                  Paused: {c.pausedReason} · <When iso={c.pausedAt} />
                  {isSharedNumberOptOutPause(c.pausedReason) ? (
                    <div style={{ marginTop: 2 }}>
                      <SharedNumberHolderNote />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="consents">
                {(['email', 'sms', 'voice', 'whatsapp'] as const).map((ch) => {
                  const rec = c.consents.find((k) => k.channel === ch)
                  const cold = ch === 'email'
                  return (
                    <span key={ch} className={`consent ${rec ? (rec.granted ? 'yes' : 'no') : cold ? 'cold' : 'none'}`}>
                      {ch}:{' '}
                      {rec
                        ? rec.granted
                          ? 'opted in'
                          : 'declined'
                        : cold
                          ? 'no record (cold email allowed)'
                          : 'no opt-in (cannot be used)'}
                      {canWrite ? (
                        <>
                          {' '}
                          <button type="button" className="linkish" disabled={busy === c.id} onClick={() => void consent(c.id, ch, true)}>
                            record opt-in
                          </button>
                          {' · '}
                          <button type="button" className="linkish" disabled={busy === c.id} onClick={() => void consent(c.id, ch, false)}>
                            record refusal
                          </button>
                        </>
                      ) : null}
                    </span>
                  )
                })}
              </div>
              {errors[c.id] ? <div className="err-line">{errors[c.id]}</div> : null}
            </div>
          ))}
        </div>
      )}

      {canWrite ? (
        adding ? (
          <AddContact companyId={companyId} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            Add a person
          </button>
        )
      ) : null}
    </section>
  )
}

function AddContact({ companyId, onCancel }: { companyId: string; onCancel: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [title, setTitle] = useState('')
  const [email, setEmail] = useState('')
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, firstName, lastName, title, email, timeZone: timeZone || null }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? 'That did not work.')
        return
      }
      toast.afterReload('Contact added.')
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 6px' }}>Add a person</h3>
      <div className="two-up">
        <label>
          First name
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Last name
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Head of Engineering" autoComplete="off" />
      </label>
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="priya@rentman.io" autoComplete="off" />
      </label>
      <label>
        Timezone
        <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Europe/London" autoComplete="off" />
        <span className="hint">
          Where THEY are, as an IANA name. Pre-filled with yours, which is probably wrong for them — quiet hours
          are checked in the recipient&apos;s time, and a wrong zone is a message at 3am. Leave it empty if you
          do not know; nothing will be sent until it is set.
        </span>
      </label>
      {error ? <div className="err-line">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || !email} onClick={() => void submit()}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
