'use client'

import { useState } from 'react'
import { REFUSAL_WORDS } from '@/lib/refusal-words'

/**
 * Campaigns (PROMPT.md §8.4).
 *
 * "Campaign builder: ICP filter, channel, daily cap, quiet hours, auto-send
 * toggle (default off)." The form is that list, and the card beside each
 * campaign is what it has actually done — sent, waiting, and refused-and-why —
 * read straight from `touches`, because those numbers are what answer "why
 * did a campaign of 40 send 12?".
 *
 * Auto-send is the one control with a sentence next to it, because it is the
 * one §2.4 names: on, and mail leaves the building with no person per
 * message. Owner-only to turn on; anyone may turn it off.
 */

export interface CampaignView {
  readonly id: string
  readonly name: string
  readonly channel: 'email' | 'linkedin'
  readonly dailyCap: number
  readonly quietStart: string
  readonly quietEnd: string
  readonly autoSend: boolean
  readonly status: 'draft' | 'active' | 'paused' | 'done'
  readonly activity: {
    readonly sent: number
    readonly awaitingApproval: number
    readonly waitingToSend: number
    readonly refusals: readonly { readonly code: string; readonly n: number }[]
  }
}

export function CampaignsPanel({
  campaigns,
  canWrite,
  canAutoSend,
  senderConnected = true,
}: {
  campaigns: readonly CampaignView[]
  canWrite: boolean
  canAutoSend: boolean
  /** False when no worker exists to drain the queue — see lib/deployment.ts. */
  senderConnected?: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <>
      <div className="rows">
        {campaigns.length === 0 ? (
          <p className="muted" style={{ fontSize: 13.5 }}>
            No campaigns yet. A campaign is where a message&apos;s daily cap and quiet hours come from;
            a draft cannot be approved without one.
          </p>
        ) : null}

        {campaigns.map((c) =>
          editing === c.id ? (
            <CampaignForm key={c.id} campaign={c} canAutoSend={canAutoSend} senderConnected={senderConnected} onCancel={() => setEditing(null)} />
          ) : (
            <div key={c.id} className="row-card">
              <div className="row-head">
                <div>
                  <strong>{c.name}</strong>
                  <span className="tag">{c.channel}</span>
                  <span className={`tag${c.status === 'active' ? ' on' : ''}`}>{c.status}</span>
                  {c.autoSend ? <span className="tag warn">auto-send</span> : <span className="tag">approval per message</span>}
                </div>
                {canWrite ? (
                  <div className="row-actions">
                    <button type="button" onClick={() => setEditing(c.id)}>
                      Edit
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Up to {c.dailyCap} a day · quiet {c.quietStart.slice(0, 5)}–{c.quietEnd.slice(0, 5)} in each recipient&apos;s
                own timezone
              </div>
              <div className="activity">
                <span>
                  <strong>{c.activity.sent}</strong> sent
                </span>
                <span>
                  <strong>{c.activity.awaitingApproval}</strong> waiting for a person
                </span>
                <span>
                  <strong>{c.activity.waitingToSend}</strong> approved, waiting to send
                </span>
                {c.activity.refusals.map((r) => (
                  <span key={r.code}>
                    <strong>{r.n}</strong> not sent — {REFUSAL_WORDS[r.code] ?? r.code}
                  </span>
                ))}
              </div>
            </div>
          ),
        )}
      </div>

      {canWrite ? (
        adding ? (
          <CampaignForm canAutoSend={canAutoSend} senderConnected={senderConnected} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
            New campaign
          </button>
        )
      ) : null}
    </>
  )
}

function CampaignForm({
  campaign,
  canAutoSend,
  senderConnected,
  onCancel,
}: {
  campaign?: CampaignView
  canAutoSend: boolean
  senderConnected: boolean
  onCancel: () => void
}) {
  const [name, setName] = useState(campaign?.name ?? '')
  const [channel, setChannel] = useState<'email' | 'linkedin'>(campaign?.channel ?? 'email')
  const [dailyCap, setDailyCap] = useState(campaign?.dailyCap ?? 25)
  const [quietStart, setQuietStart] = useState(campaign?.quietStart.slice(0, 5) ?? '21:00')
  const [quietEnd, setQuietEnd] = useState(campaign?.quietEnd.slice(0, 5) ?? '08:00')
  const [autoSend, setAutoSend] = useState(campaign?.autoSend ?? false)
  const [status, setStatus] = useState<CampaignView['status']>(campaign?.status ?? 'draft')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(campaign ? `/api/campaigns/${campaign.id}` : '/api/campaigns', {
        method: campaign ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, channel, dailyCap, quietStart, quietEnd, autoSend, status, icpProfileId: null }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card">
      <h3 style={{ margin: '0 0 10px' }}>{campaign ? `Edit ${campaign.name}` : 'New campaign'}</h3>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
      </label>

      <label>
        Channel
        <select value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'linkedin')}>
          <option value="email">Email</option>
          <option value="linkedin">LinkedIn</option>
        </select>
        <span className="hint">
          Cold outreach is email and LinkedIn only. SMS and voice are not offered for a campaign, and the
          send path refuses them regardless.
        </span>
      </label>

      <label>
        Daily cap
        <input
          type="number"
          min={1}
          max={200}
          value={dailyCap}
          onChange={(e) => setDailyCap(Number(e.target.value))}
        />
        <span className="hint">
          Messages this campaign may send in one day, counted from what actually went. A cap, not a
          target — a warmed mailbox that sends 200 cold emails in a day stops being one.
        </span>
      </label>

      <div className="two-up">
        <label>
          Quiet from
          <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
        </label>
        <label>
          until
          <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
        </label>
      </div>
      <span className="hint" style={{ marginTop: -6 }}>
        Local time where the RECIPIENT is, never where you are. A message that lands in this window waits
        for it to end. A contact with no timezone cannot be sent to at all.
      </span>

      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as CampaignView['status'])}>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="done">done</option>
        </select>
      </label>

      <label className="tool-check" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={autoSend}
          disabled={!canAutoSend && !autoSend}
          onChange={(e) => setAutoSend(e.target.checked)}
        />
        <span>
          <strong>Auto-send.</strong>{' '}
          {senderConnected
            ? 'Messages in this campaign leave without a person reading each one.'
            : 'Messages in this campaign would leave without a person reading each one — but no worker is connected to this deployment, so none of them will leave at all until one is.'}
          Every rule — suppression, consent, quiet hours, the cap — still applies to every message.
          {!canAutoSend ? ' Only an owner can turn this on.' : ''}
        </span>
      </label>

      {error ? <div className="err-line">{error}</div> : null}

      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || !name} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
