'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * Message drafts waiting for a person (PROMPT.md §2.4, §8.4).
 *
 * The agent's `queue_touch` writes a draft ABOUT a company, to nobody. The
 * person approving it chooses who it goes to and under which campaign, and
 * their name goes on the row. Nothing is sent by approving: the worker's next
 * tick re-checks every §2.1 rule at the moment of sending. That is said on
 * the card, because "Approve" on a message that then takes an hour to go
 * (quiet hours) reads as broken unless it is explained.
 *
 * The body is shown whole and unformatted. Someone deciding whether this may
 * be sent has to see exactly what will be sent.
 */

export interface DraftView {
  readonly id: string
  readonly channel: string
  readonly subject: string | null
  readonly body: string | null
  readonly createdAt: string
  readonly company: { readonly id: string; readonly domain: string; readonly name: string | null } | null
  /** Contacts at the draft's company who can be written to on its channel. */
  readonly candidates: readonly {
    readonly id: string
    readonly label: string
    readonly reachable: boolean
    readonly why: string | null
  }[]
}

export interface CampaignChoice {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly autoSend: boolean
}

type Settled = { outcome: 'approved' | 'refused' | 'taken'; message: string }

export function DraftQueue({
  drafts,
  campaigns,
  canDecide,
  senderConnected = true,
}: {
  drafts: readonly DraftView[]
  campaigns: readonly CampaignChoice[]
  canDecide: boolean
  /**
   * Whether a worker exists to drain the queue. False on a deployment that
   * runs only the web app, where an approved message stays approved forever
   * — and telling somebody "it will send on the next pass" would be the
   * product claiming something it did not do.
   */
  senderConnected?: boolean
}) {
  const [settled, setSettled] = useState<Record<string, Settled>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [choice, setChoice] = useState<Record<string, { contactId: string; campaignId: string; note: string }>>({})

  const pick = (id: string, patch: Partial<{ contactId: string; campaignId: string; note: string }>) =>
    setChoice((c) => ({ ...c, [id]: { contactId: '', campaignId: '', note: '', ...c[id], ...patch } }))

  const decide = async (draft: DraftView, decision: 'approved' | 'denied'): Promise<void> => {
    const chosen = choice[draft.id] ?? { contactId: '', campaignId: '', note: '' }
    setBusy(draft.id)
    setErrors((e) => ({ ...e, [draft.id]: '' }))
    try {
      const res = await fetch(`/api/touches/${draft.id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...chosen }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) {
        setSettled((s) => ({
          ...s,
          [draft.id]: {
            outcome: decision === 'approved' ? 'approved' : 'refused',
            message:
              decision === 'approved'
                ? senderConnected
                  ? 'Approved. The worker will send it on its next pass — after checking the suppression list, ' +
                    'consent, quiet hours and the daily cap again. If it lands in quiet hours it waits for morning.'
                  : 'Approved, and queued. No worker is connected to this deployment, so nothing will send it ' +
                    'until one is — every rule is still checked at that moment, not now.'
                : 'Denied. Nothing was sent, and the note is kept with the draft.',
          },
        }))
      } else if (res.status === 409) {
        setSettled((s) => ({ ...s, [draft.id]: { outcome: 'taken', message: 'Someone else decided this first.' } }))
      } else {
        setErrors((e) => ({ ...e, [draft.id]: body.error ?? 'That did not work.' }))
      }
    } catch {
      setErrors((e) => ({ ...e, [draft.id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="queue">
      {drafts.map((d) => {
        const done = settled[d.id]
        const chosen = choice[d.id] ?? { contactId: '', campaignId: '', note: '' }
        const forChannel = campaigns.filter((c) => c.channel === d.channel)
        const reachable = d.candidates.filter((c) => c.reachable)
        return (
          <div key={d.id} className={`approval ${done ? `approval-${done.outcome}` : ''}`}>
            <div className="approval-head">
              <strong>{d.subject ?? '(no subject)'}</strong>
              <span className="pill">{d.channel}</span>
              {d.company ? (
                <a href={`/companies/${encodeURIComponent(d.company.domain)}`} className="muted" style={{ fontSize: 12.5 }}>
                  about {d.company.name ?? d.company.domain}
                </a>
              ) : null}
              <span className="muted" style={{ fontSize: 12 }}>
                drafted <When iso={d.createdAt} />
              </span>
            </div>

            <pre className="mono approval-payload">{d.body ?? ''}</pre>

            {done ? (
              <p className="muted">{done.message}</p>
            ) : !canDecide ? (
              <p className="muted">Waiting for someone who can approve this.</p>
            ) : (
              <>
                <div className="draft-choices">
                  <label>
                    To
                    <select
                      value={chosen.contactId}
                      onChange={(e) => pick(d.id, { contactId: e.target.value })}
                      disabled={reachable.length === 0}
                    >
                      <option value="">
                        {d.candidates.length === 0
                          ? 'No contacts at this company yet'
                          : reachable.length === 0
                            ? 'No contact here can be written to'
                            : 'Choose a person'}
                      </option>
                      {reachable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    {d.candidates.some((c) => !c.reachable) ? (
                      <span className="hint">
                        Not offered:{' '}
                        {d.candidates
                          .filter((c) => !c.reachable)
                          .map((c) => `${c.label} (${c.why})`)
                          .join('; ')}
                        .
                      </span>
                    ) : null}
                    {d.candidates.length === 0 && d.company ? (
                      <span className="hint">
                        Add a contact on{' '}
                        <a href={`/companies/${encodeURIComponent(d.company.domain)}`}>the company page</a> first —
                        with their timezone, or nothing can be sent to them.
                      </span>
                    ) : null}
                  </label>

                  <label>
                    Under campaign
                    <select value={chosen.campaignId} onChange={(e) => pick(d.id, { campaignId: e.target.value })}>
                      <option value="">
                        {forChannel.length === 0 ? `No ${d.channel} campaign exists yet` : 'Choose a campaign'}
                      </option>
                      {forChannel.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.autoSend ? ' (auto-send)' : ''}
                        </option>
                      ))}
                    </select>
                    <span className="hint">
                      The campaign is where the daily cap and quiet hours come from.
                      {forChannel.length === 0 ? (
                        <>
                          {' '}
                          <a href="/campaigns">Create one</a>.
                        </>
                      ) : null}
                    </span>
                  </label>

                  <label>
                    Note <span className="muted">(optional; kept with the decision)</span>
                    <input value={chosen.note} onChange={(e) => pick(d.id, { note: e.target.value })} maxLength={500} />
                  </label>
                </div>

                {errors[d.id] ? <div className="err-line">{errors[d.id]}</div> : null}

                <div className="approval-actions">
                  <button
                    type="button"
                    disabled={busy === d.id || !chosen.contactId || !chosen.campaignId}
                    onClick={() => void decide(d, 'approved')}
                  >
                    Approve
                  </button>
                  <button type="button" className="deny" disabled={busy === d.id} onClick={() => void decide(d, 'denied')}>
                    Deny
                  </button>
                  <span className="muted">
                    {senderConnected
                      ? 'Approving queues it. The worker sends on its next pass, after checking every rule again.'
                      : 'Approving records your decision and queues it. No worker is connected to this deployment, so it will not be sent until one is.'}
                  </span>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
