'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * The LinkedIn steps: the one place in the product where the provider is a
 * person.
 *
 * Two presses, in this order, and the order is the point. Start runs the
 * message through the send path with the person as the provider; the words
 * appear ONLY if every rule passes at that moment, and the row is recorded as
 * handed to them. Then they send it from their own account and say whether
 * they did. The words are never on screen before Start — a message a person
 * could copy before the rules ran is a message that can go after a refusal.
 *
 * What the send path would say right now is shown BEFORE Start, from the
 * server's dry run of the same rules. It is a forecast: Start asks again.
 */

export interface LinkedinStepItem {
  readonly touchId: string
  readonly state: 'ready' | 'sending' | 'handed' | 'stopped'
  readonly contactName: string | null
  readonly companyDomain: string | null
  readonly companyName: string | null
  readonly campaignName: string | null
  /** Built from the normalised profile key on the server, never the stored string. */
  readonly profileUrl: string | null
  /** When an earlier Start was deferred until; the rules decide, this is a hint. */
  readonly scheduledFor: string | null
  /**
   * `ready` only: the dry run, in words. `clear` and `clock` leave Start
   * enabled — the clock may have moved by the time it is pressed, and a
   * deferral hands nothing over. `blocked` disables it.
   */
  readonly check: { readonly kind: 'clear' | 'clock' | 'blocked'; readonly text: string } | null
  /** `handed` only. */
  readonly words: { readonly subject: string; readonly body: string } | null
  readonly handedTo: string | null
  readonly handedAt: string | null
  /** `stopped` only: why, in a person's words. */
  readonly stoppedBecause: string | null
}

type Handed = { readonly subject: string; readonly body: string; readonly profileUrl: string | null }

async function post(
  touchId: string,
  action: 'start' | 'sent' | 'not_sent' | 'dismiss',
): Promise<{ ok: true; out: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/touches/${touchId}/performed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: typeof out.error === 'string' ? out.error : 'That did not work.' }
    return { ok: true, out }
  } catch {
    return { ok: false, error: 'The request did not complete. Reload before trying again: it may have gone through.' }
  }
}

function Step({ step, canAct }: { step: LinkedinStepItem; canAct: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Filled by a successful Start, so the words appear without a reload.
  const [handed, setHanded] = useState<Handed | null>(
    step.words ? { ...step.words, profileUrl: step.profileUrl } : null,
  )
  const state = handed && step.state === 'ready' ? 'handed' : step.state

  const act = async (action: 'start' | 'sent' | 'not_sent' | 'dismiss'): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    const r = await post(step.touchId, action)
    if (!r.ok) {
      setBusy(false)
      setError(r.error)
      return
    }
    if (action === 'start' && r.out.status === 'sent') {
      const w = (r.out.words ?? {}) as { subject?: unknown; body?: unknown; profileUrl?: unknown }
      setHanded({
        subject: typeof w.subject === 'string' ? w.subject : '',
        body: typeof w.body === 'string' ? w.body : '',
        profileUrl: typeof w.profileUrl === 'string' ? w.profileUrl : step.profileUrl,
      })
      setBusy(false)
      return
    }
    if (action === 'start') {
      // Deferred or refused: nothing was handed over. Say why, then show the
      // step as the server now has it.
      const label = typeof r.out.label === 'string' ? r.out.label : 'not sent'
      setNotice(
        r.out.status === 'deferred'
          ? `Not yet — ${label}. Nothing was shown or recorded as sent; it stays in this list.`
          : `Refused — ${label}. Nothing was shown or recorded as sent.`,
      )
      setTimeout(() => window.location.reload(), 1200)
      return
    }
    window.location.reload()
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('The browser would not copy it. Select the text and copy it by hand.')
    }
  }

  const who = step.contactName ?? 'this contact'
  return (
    <div className="row-card slim">
      <div className="row-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <strong>{who}</strong>
        {step.companyDomain ? (
          <a className="muted" style={{ fontSize: 12.5 }} href={`/companies/${encodeURIComponent(step.companyDomain)}`}>
            {step.companyName ?? step.companyDomain}
          </a>
        ) : null}
        {step.campaignName ? <span className="tag">{step.campaignName}</span> : null}
        <span className={`pill${state === 'handed' ? ' pill-b' : state === 'stopped' ? ' pill-c' : ''}`}>
          {state === 'ready' ? 'to send' : state === 'sending' ? 'starting' : state === 'handed' ? 'handed over' : 'stopped'}
        </span>
      </div>

      {error ? <div className="err-line" role="alert">{error}</div> : null}
      {notice ? <div className="hint" role="status">{notice}</div> : null}

      {state === 'ready' ? (
        <>
          {step.check ? (
            <p
              style={{ margin: '6px 0', fontSize: 13 }}
              className={step.check.kind === 'clear' ? 'ok-line' : step.check.kind === 'blocked' ? 'err-line' : 'muted'}
            >
              {step.check.text}
            </p>
          ) : null}
          {step.scheduledFor && Date.parse(step.scheduledFor) > Date.now() ? (
            <span className="hint">
              An earlier Start was deferred; the rules said to try again after <When iso={step.scheduledFor} />.
            </span>
          ) : null}
          <div className="row-actions" style={{ marginTop: 8, alignItems: 'center' }}>
            <button
              type="button"
              disabled={!canAct || busy || step.check?.kind === 'blocked'}
              title={step.check?.kind === 'blocked' ? step.check.text : undefined}
              onClick={() => void act('start')}
            >
              Start
            </button>
            {step.profileUrl ? (
              <a href={step.profileUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>
                Their profile
              </a>
            ) : null}
          </div>
          <span className="hint">
            Start checks every send rule now. If they pass, you get the message to copy and it is recorded as
            handed to you; if not, nothing is shown.
          </span>
        </>
      ) : null}

      {state === 'sending' ? (
        <p className="hint">Somebody pressed Start a moment ago. Reload in a minute to see how it settled.</p>
      ) : null}

      {state === 'handed' && handed ? (
        <>
          <p className="hint" style={{ marginTop: 6 }}>
            Every rule passed. Handed to {step.handedTo ?? 'you'}
            {step.handedAt ? <> at <When iso={step.handedAt} /></> : null}. Send it from your own LinkedIn
            account, then say whether it went.
          </p>
          {handed.subject ? <div style={{ fontSize: 12.5, marginTop: 6 }}><strong>{handed.subject}</strong></div> : null}
          <pre className="touch-body" style={{ fontFamily: 'inherit' }}>{handed.body}</pre>
          <div className="row-actions" style={{ marginTop: 8, alignItems: 'center' }}>
            <button type="button" onClick={() => void copy(handed.subject ? `${handed.subject}\n\n${handed.body}` : handed.body)}>
              {copied ? 'Copied' : 'Copy message'}
            </button>
            {handed.profileUrl ? (
              <a href={handed.profileUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>
                Open their profile
              </a>
            ) : (
              <span className="hint" style={{ marginTop: 0 }}>No readable profile link on the contact.</span>
            )}
            <button type="button" disabled={!canAct || busy} onClick={() => void act('sent')}>I sent it</button>
            <button type="button" className="deny" disabled={!canAct || busy} onClick={() => void act('not_sent')}>
              I did not send it
            </button>
          </div>
        </>
      ) : null}

      {state === 'stopped' ? (
        <>
          <p style={{ margin: '6px 0', fontSize: 13 }} className="err-line">
            {step.stoppedBecause ?? 'This message is no longer one to send.'}
          </p>
          <div className="row-actions" style={{ marginTop: 4 }}>
            <button type="button" className="linkish" disabled={!canAct || busy} onClick={() => void act('dismiss')}>
              Close this step
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function LinkedinSteps({ steps, canAct }: { steps: readonly LinkedinStepItem[]; canAct: boolean }) {
  if (steps.length === 0) return <p className="muted" style={{ fontSize: 13 }}>No LinkedIn steps are waiting.</p>
  return (
    <div className="rows" style={{ marginTop: 8 }}>
      {!canAct ? (
        <p className="hint" style={{ marginTop: 0 }}>Only somebody who can approve messages can start or finish a step.</p>
      ) : null}
      {steps.map((s) => <Step key={s.touchId} step={s} canAct={canAct} />)}
    </div>
  )
}
