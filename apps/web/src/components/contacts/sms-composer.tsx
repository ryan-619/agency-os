'use client'

import { useEffect, useState } from 'react'
import { DEFERRED_CODES } from '../../lib/approval-view'
import { sendCheckSentence, type SendCheckView } from '../../lib/consent-view'
import { SMS_VAR_MAX_CHARS, lengthLine, renderPreview, smsLength, type ComposerPart } from './sms-text'

/**
 * "Draft SMS" (0019): one SMS to one person, from a registered DLT template,
 * for a person to approve.
 *
 * Under DLT an SMS is a registered template with its `{#var#}` slots filled —
 * nothing else is delivered — so the composer offers the active SMS
 * templates and asks for the values, with the message rendered live and its
 * length in characters and segments. "Check" puts those exact words to the
 * send path's own dry run for this person under the chosen campaign; a
 * refusal nobody may approve past (no SMS opt-in, a suppression, a pause, a
 * template that does not match) blocks the draft and says why. "Draft" then
 * parks it on /approvals. Nothing here sends, and nothing decides: the
 * server renders, checks and refuses, and the worker checks again at sending.
 *
 * Imported relatively, with its words as pure functions, so
 * `apps/web/test/sms-route.test.ts` reads what it says.
 */

export interface ComposerCampaign {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly status: string
}

interface TemplateOption {
  readonly id: string
  readonly externalId: string
  readonly senderId: string
  readonly category: string
  readonly name: string | null
  readonly parts: readonly ComposerPart[] | null
  readonly slots: number
}

export interface CheckAnswer extends SendCheckView {
  readonly rendered: true
  readonly body: string
  readonly blocked: boolean
}

/**
 * What the worker does at sending with a refusal a person CAN resolve. Only
 * the clock's refusals are held and tried again (`DEFERRED_CODES`: quiet
 * hours — TRAI's band included — the daily cap, a paused campaign). Every
 * other one — a contact with no timezone, say — is refused for good at the
 * tick, and the draft never goes. The composer said "would wait" for all of
 * them, and an approver who believed it approved a message that was then
 * refused.
 */
export function atSending(code: string): 'held' | 'refused' {
  return DEFERRED_CODES.has(code) ? 'held' : 'refused'
}

const withoutStop = (s: string): string => s.trim().replace(/\.+$/, '')

/** The line under Check: the send path's answer, and what that means for a draft. */
export function checkLine(answer: CheckAnswer): string {
  const said = sendCheckSentence(answer)
  const d = answer.decision
  if (answer.blocked) return `${said} The draft is not offered.`
  if (d.allowed || d.code === 'needs_approval') return said
  return atSending(d.code) === 'held'
    ? `${said} If it were approved now, the worker would hold it and try again later.`
    : `${said} The worker would refuse it at sending as things stand — fix it before drafting.`
}

/** The line beside a draft written with a hold: wait only where the worker waits. */
export function holdLine(hold: { readonly code: string; readonly reason: string }): string {
  return atSending(hold.code) === 'held'
    ? `If it were approved right now it would wait: ${hold.reason}`
    : `If it were approved right now it would be refused at sending: ${withoutStop(hold.reason)} — fix it before approving.`
}

type Check =
  | { readonly kind: 'answer'; readonly key: string; readonly answer: CheckAnswer }
  | { readonly kind: 'refused'; readonly key: string; readonly message: string }

export function SmsComposer({
  contactId,
  smsConsent,
  campaigns,
  onCancel,
}: {
  contactId: string
  /** The SMS consent as recorded on the ledger; anything but granted is refused by the send path. */
  smsConsent: 'granted' | 'refused' | 'never_asked' | null
  campaigns: readonly ComposerCampaign[]
  onCancel: () => void
}) {
  const smsCampaigns = campaigns.filter((c) => c.channel === 'sms' && c.status === 'active')
  const [templates, setTemplates] = useState<readonly TemplateOption[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [campaignId, setCampaignId] = useState(smsCampaigns[0]?.id ?? '')
  const [templateId, setTemplateId] = useState('')
  const [values, setValues] = useState<string[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [busy, setBusy] = useState<'check' | 'draft' | null>(null)
  const [error, setError] = useState('')
  const [drafted, setDrafted] = useState<readonly string[] | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch('/api/templates?channel=sms&active=1', { cache: 'no-store' })
        const b = (await res.json().catch(() => ({}))) as { templates?: TemplateOption[]; error?: string }
        if (!live) return
        if (!res.ok || !Array.isArray(b.templates)) {
          setLoadError(b.error ?? 'The templates could not be read.')
          return
        }
        setTemplates(b.templates)
        const firstOne = b.templates[0]
        if (firstOne) {
          setTemplateId(firstOne.id)
          setValues(Array.from({ length: firstOne.slots }, () => ''))
        }
      } catch {
        if (live) setLoadError('The templates could not be read. Try again.')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const template = templates?.find((t) => t.id === templateId) ?? null
  const preview = template?.parts ? renderPreview(template.parts, values) : null
  const length = preview ? smsLength(preview.text) : null
  /** What the latest check was about: a check answers for these inputs and no others. */
  const key = JSON.stringify([campaignId, templateId, values])
  const current = check && check.key === key ? check : null

  const pickTemplate = (id: string) => {
    setTemplateId(id)
    const t = templates?.find((x) => x.id === id)
    setValues(Array.from({ length: t?.slots ?? 0 }, () => ''))
  }

  const post = async (dryRun: boolean): Promise<Record<string, unknown> | null> => {
    setError('')
    try {
      const res = await fetch(`/api/contacts/${contactId}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignId, templateId, vars: values, dryRun }),
      })
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(typeof b.error === 'string' ? b.error : 'That did not work.')
        return null
      }
      return b
    } catch {
      setError('The request did not complete. Try again.')
      return null
    }
  }

  const runCheck = async (): Promise<void> => {
    setBusy('check')
    const asked = key
    const b = await post(true)
    setBusy(null)
    if (!b) return
    if (b.rendered === false) {
      setCheck({ kind: 'refused', key: asked, message: typeof b.error === 'string' ? b.error : 'The values do not render.' })
      return
    }
    setCheck({ kind: 'answer', key: asked, answer: b as unknown as CheckAnswer })
  }

  const draft = async (): Promise<void> => {
    setBusy('draft')
    const b = await post(false)
    setBusy(null)
    if (!b) return
    const lines = [typeof b.note === 'string' ? b.note : 'Drafted. A person approves it on /approvals.']
    const hold = b.wouldHold as { code?: unknown; reason?: unknown } | null | undefined
    if (hold && typeof hold.code === 'string' && typeof hold.reason === 'string') lines.push(holdLine({ code: hold.code, reason: hold.reason }))
    if (typeof b.deployment === 'string') lines.push(b.deployment)
    setDrafted(lines)
  }

  if (drafted) {
    return (
      <div className="row-card slim" style={{ fontSize: 13 }}>
        <div className="ok-line" style={{ marginTop: 0, fontSize: 13 }}>{drafted[0]}</div>
        {drafted.slice(1).map((l) => (
          <div key={l} className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{l}</div>
        ))}
        <div className="row-actions" style={{ marginTop: 10 }}>
          <a href="/approvals">Open approvals</a>
          <button type="button" className="linkish" onClick={onCancel}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="row-card slim" style={{ fontSize: 13 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Draft SMS</h3>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
        From a template registered on DLT, with its variables filled — nothing else is delivered. It goes only to a
        person with a recorded SMS opt-in, and every SMS is approved by a person on /approvals before the worker sends it.
      </p>
      {smsConsent !== 'granted' ? (
        <div className="note note-warn" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
          {smsConsent === 'refused'
            ? 'They refused SMS. Nothing can be drafted to them, and only an owner can lift a recorded refusal.'
            : 'No SMS opt-in is recorded for them, and SMS is opt-in only: the check below will refuse it. Record their opt-in under “Edit and consent” first, with where it came from.'}
        </div>
      ) : null}

      {smsCampaigns.length === 0 ? (
        <p style={{ margin: 0 }}>
          There is no active SMS campaign, and every SMS goes under one — it is where the daily cap and quiet hours
          live. Create one on <a href="/campaigns">Campaigns</a>.
        </p>
      ) : loadError ? (
        <div className="err-line">{loadError}</div>
      ) : templates === null ? (
        <p className="muted" style={{ margin: 0 }}>Reading the templates…</p>
      ) : templates.length === 0 ? (
        <p style={{ margin: 0 }}>
          No SMS template is switched on. Record the templates registered on DLT on{' '}
          <a href="/settings/templates">Settings → Templates</a> first.
        </p>
      ) : (
        <>
          <div className="two-up">
            <label>
              Under campaign
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                {smsCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label>
              Template
              <select value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name ?? t.externalId} · {t.senderId} · {t.category.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {template ? <span className="hint">DLT template {template.externalId}, header {template.senderId}.</span> : null}
            </label>
          </div>

          {template && template.parts && template.slots > 0 ? (
            <div className="two-up">
              {template.parts
                .filter((p): p is Extract<ComposerPart, { kind: 'slot' }> => p.kind === 'slot')
                .map((p, i) => {
                  const v = values[i] ?? ''
                  const n = Array.from(v).length
                  return (
                    <label key={i}>
                      Variable {i + 1} <span className="muted">{`{#${p.variable}#}`}</span>
                      <input
                        value={v}
                        maxLength={120}
                        autoComplete="off"
                        onChange={(e) => setValues((vs) => vs.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                      <span className="hint" style={n > SMS_VAR_MAX_CHARS ? { color: 'var(--warn)' } : undefined}>
                        {n}/{SMS_VAR_MAX_CHARS}
                      </span>
                    </label>
                  )
                })}
            </div>
          ) : null}

          {preview && length ? (
            <div style={{ margin: '6px 0' }}>
              <pre className="mono approval-payload" style={{ margin: 0 }}>{preview.text}</pre>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {lengthLine(length)}
                {preview.problems.length > 0 ? ` · ${preview.problems.map((p) => p.message).join(' ')}` : ''}
              </div>
            </div>
          ) : null}

          {current?.kind === 'refused' ? <div className="err-line">{current.message}</div> : null}
          {current?.kind === 'answer' ? (
            <div className={current.answer.blocked ? 'err-line' : current.answer.decision.allowed ? 'ok-line' : 'muted'} style={{ fontSize: 12.5 }}>
              {checkLine(current.answer)}
            </div>
          ) : null}
          {error ? <div className="err-line">{error}</div> : null}

          <div className="row-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              disabled={busy !== null || !campaignId || !template || !preview?.complete}
              onClick={() => void runCheck()}
            >
              {busy === 'check' ? 'Checking…' : 'Check'}
            </button>
            <button
              type="button"
              disabled={busy !== null || current?.kind !== 'answer' || current.answer.blocked}
              onClick={() => void draft()}
              title="Parks it on /approvals for a person. Nothing is sent from here."
            >
              {busy === 'draft' ? 'Drafting…' : 'Draft for approval'}
            </button>
            <button type="button" className="linkish" onClick={onCancel} disabled={busy !== null}>
              Cancel
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Check runs the sender’s own rules over these words. It queues nothing and sends nothing.
            </span>
          </div>
        </>
      )}
    </div>
  )
}
