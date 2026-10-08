'use client'

import { useState } from 'react'
import { STEP_DEFAULT_BODY, STEP_KIND_WORDS, STEP_LIMITS, STEP_PLACEHOLDERS, STOP_REASON_WORDS, stepsLine, type StepKind } from './steps-words'

export interface StepView {
  readonly kind: StepKind
  readonly afterDays: number
  readonly subject: string | null
  readonly body: string | null
}

export interface RunsView {
  readonly live: number
  readonly stopped: Readonly<Record<string, number>>
}

/**
 * A campaign's follow-up steps (0024): what happens after its opener for each
 * person who has not replied, and how many are being followed up now. A
 * message step drafts on its day — for a person to approve, unless the
 * campaign auto-sends — and a reply stops everything for that person.
 */
export function CampaignSteps({
  campaignId,
  channel,
  autoSend,
  steps,
  runs,
  canWrite,
}: {
  readonly campaignId: string
  readonly channel: 'email' | 'linkedin' | 'sms'
  readonly autoSend: boolean
  readonly steps: readonly StepView[]
  readonly runs: RunsView
  readonly canWrite: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<StepView[]>([...steps])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const messages = channel !== 'sms'
  const stopped = Object.entries(runs.stopped).filter(([, n]) => n > 0)

  const set = (i: number, patch: Partial<StepView>) => setDraft((d) => d.map((s, n) => (n === i ? { ...s, ...patch } : s)))
  const add = (kind: StepKind) =>
    setDraft((d) => [...d, { kind, afterDays: kind === 'message' ? 3 : 2, subject: null, body: kind === 'message' ? STEP_DEFAULT_BODY : null }])
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/steps`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps: draft.map((s) => ({ ...s, subject: s.subject?.trim() ? s.subject : null })) }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'The steps could not be saved.')
        return
      }
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="steps-summary">
        <span>
          <strong>Follow-ups:</strong>{' '}
          {steps.length === 0 ? 'none — a person who does not reply hears nothing more' : stepsLine(steps)}
        </span>
        {runs.live > 0 || stopped.length > 0 ? (
          <span className="muted">
            {' · '}
            {runs.live} being followed up
            {stopped.map(([why, n]) => ` · ${n} stopped (${STOP_REASON_WORDS[why] ?? why})`).join('')}
          </span>
        ) : null}
        {canWrite ? (
          <button type="button" className="link-like" onClick={() => setEditing(true)}>
            {steps.length === 0 ? 'Add follow-ups' : 'Edit follow-ups'}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="steps-editor">
      <p className="hint" style={{ marginTop: 0 }}>
        After the opener, for each person who has not replied. A reply — on any channel — stops them for good, and so
        does a pause, a closed deal or a message that did not go. Each step counts its days from when the step before
        went: a message from when it was SENT, a task from when it was made.
        {messages
          ? autoSend
            ? ' This campaign auto-sends, so a follow-up message goes on its day with nobody reading it — every rule is still checked at sending.'
            : ' A follow-up message is drafted on its day and waits on Approvals like the opener.'
          : ' A text campaign follows up with calls and visits only: each text is drafted for one person from a registered template.'}
      </p>
      {draft.length === 0 ? <p className="muted">No steps yet.</p> : null}
      {draft.map((s, i) => (
        <div key={i} className="step-row">
          <div className="step-head">
            <strong>Step {i + 2}:</strong> {STEP_KIND_WORDS[s.kind]}
            <label>
              {' '}after{' '}
              <input
                type="number"
                min={1}
                max={STEP_LIMITS.afterDaysMax}
                value={s.afterDays}
                onChange={(e) => set(i, { afterDays: Number(e.target.value) })}
                style={{ width: 64 }}
              />{' '}
              days
            </label>
            <span className="step-moves">
              <button type="button" disabled={i === 0} onClick={() => setDraft((d) => { const n = [...d]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n })}>↑</button>
              <button type="button" disabled={i === draft.length - 1} onClick={() => setDraft((d) => { const n = [...d]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; return n })}>↓</button>
              <button type="button" onClick={() => setDraft((d) => d.filter((_, n) => n !== i))}>Remove</button>
            </span>
          </div>
          {s.kind === 'message' ? (
            <>
              {channel === 'email' ? (
                <input
                  type="text"
                  placeholder="Subject — leave empty to reply on the opener's subject"
                  maxLength={STEP_LIMITS.subjectMax}
                  value={s.subject ?? ''}
                  onChange={(e) => set(i, { subject: e.target.value })}
                />
              ) : null}
              <textarea rows={5} maxLength={STEP_LIMITS.bodyMax} value={s.body ?? ''} onChange={(e) => set(i, { body: e.target.value })} />
            </>
          ) : null}
        </div>
      ))}
      <p className="hint">You can use {STEP_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')} in a message.</p>
      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        {draft.length < STEP_LIMITS.steps ? (
          <>
            {messages ? <button type="button" onClick={() => add('message')}>+ Message</button> : null}
            <button type="button" onClick={() => add('call')}>+ Call</button>
            <button type="button" onClick={() => add('visit')}>+ Visit</button>
          </>
        ) : null}
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save follow-ups'}
        </button>
        <button type="button" onClick={() => { setDraft([...steps]); setEditing(false); setError('') }}>Cancel</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  )
}
