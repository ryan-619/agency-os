'use client'

import { useEffect, useState } from 'react'
import type { EnrolSkip } from '@agency/core'
import { REFUSAL_WORDS, campaignAutoPausedWords } from '@/lib/refusal-words'

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
 *
 * Enrolment fills a campaign: one draft per person at every qualifying,
 * freshly scanned company. It is previewed before anything is written, and
 * the preview says the one thing people assume it does and it does not —
 * read the suppression list. That check belongs to the send path (§2.1), so
 * a suppressed person IS enrolled and then refused at sending.
 *
 * A campaign the WORKER paused says so, with the numbers it paused on: too
 * many of its addresses bounced. Nothing un-pauses it but a person setting
 * it active again from the form below, after fixing the list.
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
  /**
   * Set when the worker paused this campaign because its addresses were
   * bouncing, and no person has set it active since (`campaignAutoPauses`).
   * Shown only while the status is still `paused`.
   */
  readonly autoPaused?: {
    readonly bouncePct: number
    readonly threshold: number
    readonly sentTo: number
    readonly bounced: number
    /** ISO time of the pause. */
    readonly at: string
  } | null
}

export function CampaignsPanel({
  campaigns,
  canWrite,
  canAutoSend,
  canEnrol = false,
  senderConnected = true,
  noSenderNote = null,
}: {
  campaigns: readonly CampaignView[]
  canWrite: boolean
  canAutoSend: boolean
  /** May this person enrol contacts into a campaign (`campaigns:write`). */
  canEnrol?: boolean
  /** False when no worker exists to drain the queue — see lib/deployment.ts. */
  senderConnected?: boolean
  /** `nothingWillSendNote()`, or null when a worker will drain the queue. */
  noSenderNote?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [enrolling, setEnrolling] = useState<string | null>(null)

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
                {canWrite || canEnrol ? (
                  <div className="row-actions">
                    {canEnrol && c.status !== 'done' && enrolling !== c.id ? (
                      <button type="button" onClick={() => setEnrolling(c.id)}>
                        Enrol qualifying contacts (preview)
                      </button>
                    ) : null}
                    {canWrite ? (
                      <button type="button" onClick={() => setEditing(c.id)}>
                        Edit
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Up to {c.dailyCap} a day · quiet {c.quietStart.slice(0, 5)}–{c.quietEnd.slice(0, 5)} in each recipient&apos;s
                own timezone
              </div>
              {c.status === 'paused' && c.autoPaused ? (
                <p
                  className="note note-warn"
                  style={{ margin: '8px 0 0', fontSize: 13 }}
                  title={`The limit is ${c.autoPaused.threshold}% once twenty people have been written to.`}
                >
                  {campaignAutoPausedWords(c.autoPaused)}
                </p>
              ) : null}
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
              {enrolling === c.id ? (
                <EnrolPanel campaign={c} noSenderNote={noSenderNote} onClose={() => setEnrolling(null)} />
              ) : null}
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

/**
 * Why somebody was left out, in front of a person. The code is what the audit
 * row keeps; these say which way to look — the company's scan, or the person.
 */
const ENROL_SKIP_WORDS: Readonly<Record<EnrolSkip, string>> = {
  unreachable: 'companies whose site did not answer at the last scan',
  stale: 'companies with no fresh scan — re-scan them first',
  disqualified: 'companies the profile disqualifies',
  not_qualified: 'companies below the qualifying score',
  no_evidence: 'companies with nothing observed to quote',
  no_contact: 'qualifying companies with nobody on file',
  no_address: 'people with no usable address on this channel',
  paused: 'people paused after replying',
  declined: 'people who declined this channel',
  no_timezone: 'people with no timezone, on them or their company',
  already_enrolled: 'people who already have a draft in this campaign',
  already_contacted: 'people this campaign has already written to',
}

/** What the enrol route answers — counts only, never who. */
interface EnrolPlan {
  readonly dryRun: boolean
  readonly status: 'queued' | 'awaiting_approval'
  readonly queued: number
  readonly skipped: Partial<Record<EnrolSkip, number>>
  readonly skippedTotal: number
  readonly truncated: boolean
  readonly limit: number
  readonly suppressedHint: number | null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function SkipCounts({ plan }: { plan: EnrolPlan }) {
  const rows = (Object.entries(plan.skipped) as [EnrolSkip, number][]).filter(([, n]) => n > 0)
  if (rows.length === 0) return null
  return (
    <ul>
      {rows.map(([why, n]) => (
        <li key={why}>
          <strong>{n}</strong> {ENROL_SKIP_WORDS[why] ?? why.replace(/_/g, ' ')}
        </li>
      ))}
    </ul>
  )
}

/**
 * Preview first, then queue. The preview is the same plan with nothing
 * written, so what the confirm button says is what it will do — give or
 * take somebody else enrolling in between, which the answer reports.
 */
function EnrolPanel({
  campaign,
  noSenderNote,
  onClose,
}: {
  campaign: CampaignView
  noSenderNote: string | null
  onClose: () => void
}) {
  const [plan, setPlan] = useState<EnrolPlan | null>(null)
  const [done, setDone] = useState<EnrolPlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const enrol = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/enrol`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      })
      const body = (await res.json().catch(() => ({}))) as Partial<EnrolPlan> & { error?: string }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return
      }
      if (dryRun) setPlan(body as EnrolPlan)
      else setDone(body as EnrolPlan)
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  // The preview is asked for as the panel opens. It writes nothing, so a
  // second run (React's development double-invoke) costs a read and no more.
  useEffect(() => {
    void enrol(true)
  }, [])

  const linkedInWarning =
    campaign.channel === 'linkedin' ? (
      <p className="note note-warn" style={{ marginTop: 8 }}>
        No provider can send on LinkedIn; approved rows will wait for the LinkedIn step.
      </p>
    ) : null
  const noSender = noSenderNote ? (
    <p className="note note-warn" style={{ marginTop: 8 }}>
      {noSenderNote}
    </p>
  ) : null

  if (done) {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="note">
          <p style={{ margin: 0 }}>
            {done.status === 'queued' ? (
              <>
                Queued <strong>{plural(done.queued, 'message', 'messages')}</strong> for the worker to send. Nothing was
                sent yet — each one is checked against every rule at the moment it is sent.
              </>
            ) : (
              <>
                Queued <strong>{plural(done.queued, 'draft', 'drafts')}</strong> for approval. Nothing was sent.
              </>
            )}
            {done.skippedTotal > 0 ? ` ${done.skippedTotal} skipped:` : ''}
          </p>
          <SkipCounts plan={done} />
          {done.truncated ? (
            <p style={{ margin: '8px 0 0' }}>
              It stopped at the limit of {done.limit}. Enrol again to continue with the rest — everyone queued this time
              is skipped next time.
            </p>
          ) : null}
        </div>
        {linkedInWarning}
        {noSender}
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => window.location.reload()}>
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 12 }}>
      {plan ? (
        <>
          <div className="note">
            <p style={{ margin: 0 }}>
              <strong>{plural(plan.queued, 'person', 'people')}</strong> would get a draft;{' '}
              {plan.skippedTotal} skipped{plan.skippedTotal > 0 ? ':' : '.'}
            </p>
            <SkipCounts plan={plan} />
            <p style={{ margin: '8px 0 0' }}>
              The send path will refuse anyone on the suppression list — enrolment does not read it, on purpose.
              {plan.suppressedHint ? ` Checked just now, ${plan.suppressedHint} of these would be.` : ''}
            </p>
            {plan.truncated ? (
              <p style={{ margin: '8px 0 0' }}>
                This stops at the limit of {plan.limit}, highest-scoring companies first. Enrol again afterwards to
                continue with the rest.
              </p>
            ) : null}
            <p style={{ margin: '8px 0 0' }}>
              {plan.status === 'queued'
                ? 'This campaign auto-sends: these go to the worker without a person reading each one. Every rule is still checked at the moment of sending.'
                : 'Each draft waits in Approvals for a person to read it and choose to send it.'}
              {campaign.status !== 'active'
                ? ` The campaign is ${campaign.status}, so nothing in it is sent until it is active.`
                : ''}
            </p>
          </div>
          {linkedInWarning}
          {noSender}
        </>
      ) : busy ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Working out who qualifies…
        </p>
      ) : null}

      {error ? <div className="err-line">{error}</div> : null}

      <div className="row-actions" style={{ marginTop: 10 }}>
        {plan && plan.queued > 0 ? (
          <button type="button" disabled={busy} onClick={() => void enrol(false)}>
            {busy
              ? 'Queuing…'
              : plan.status === 'queued'
                ? `Queue ${plural(plan.queued, 'message', 'messages')} to send`
                : `Queue ${plural(plan.queued, 'draft', 'drafts')} for approval`}
          </button>
        ) : null}
        <button type="button" onClick={onClose} disabled={busy}>
          {plan && plan.queued === 0 ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
