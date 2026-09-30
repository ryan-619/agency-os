'use client'

import { Fragment, useState } from 'react'
import { When } from '@/components/when'
import { ContactEdit } from '@/components/contacts/edit'
import { sendCheckSentence, type SendCheckView } from '@/lib/consent-view'

/**
 * The consent ledger (§2.1): one row per person, and per row the facts the
 * send path reads — consent per channel as exactly one of granted, refused
 * or never asked; the suppression list's answer for each address; the zone
 * quiet hours are checked in; whether a reply has paused them.
 *
 * Every word on a row was chosen by `lib/consent-view.ts` on the server, so
 * this component renders and does not decide. The one thing it asks for
 * itself is "Why can't I reach them?", which calls the sender's own dry run
 * (`/api/contacts/[id]/send-check`) and prints the answer in the words every
 * other screen uses. That call queues nothing; the page says so beside it.
 */

export interface LedgerChannelView {
  readonly channel: 'email' | 'sms' | 'voice' | 'whatsapp'
  readonly state: 'granted' | 'refused' | 'never_asked'
  readonly label: string
  readonly cls: string
  /** The full source, for a tooltip — the label bounds it. */
  readonly source: string | null
}

export interface LedgerSuppressionView {
  readonly key: 'email' | 'phone' | 'linkedin'
  readonly label: string
  readonly cls: string
}

export interface LedgerView {
  readonly id: string
  readonly name: string
  readonly firstName: string | null
  readonly lastName: string | null
  readonly title: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly linkedinUrl: string | null
  readonly companyDomain: string
  readonly companyName: string | null
  readonly zone: string
  readonly zoneMissing: boolean
  readonly pausedAt: string | null
  readonly pausedReason: string | null
  readonly emailBouncedAt: string | null
  readonly emailBounceCode: string | null
  readonly channels: readonly LedgerChannelView[]
  readonly suppression: readonly LedgerSuppressionView[]
  /** By kind and the path that recorded it — never the value. */
  readonly matches: readonly { readonly kind: string; readonly source: string | null }[]
}

export interface LedgerCampaign {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly status: string
}

const KEY_WORDS: Record<LedgerSuppressionView['key'], string> = { email: 'email', phone: 'phone', linkedin: 'LinkedIn' }

/** Only a URL that is plainly a LinkedIn page becomes a link; anything else is shown as text. */
function linkedinHref(url: string): string | null {
  if (/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(url)) return url
  if (/^([a-z]{2,3}\.)?linkedin\.com\//i.test(url)) return `https://${url}`
  return null
}

export function ContactsLedger({
  rows,
  campaigns,
  canWrite,
  isOwner,
}: {
  rows: readonly LedgerView[]
  campaigns: readonly LedgerCampaign[]
  canWrite: boolean
  isOwner: boolean
}) {
  const [open, setOpen] = useState<{ id: string; panel: 'check' | 'edit' } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const toggle = (id: string, panel: 'check' | 'edit') =>
    setOpen((o) => (o && o.id === id && o.panel === panel ? null : { id, panel }))

  const patch = async (id: string, body: Record<string, unknown>): Promise<void> => {
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
      window.location.reload()
    } catch {
      setErrors((e) => ({ ...e, [id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) {
    return <p className="muted">Nobody matches. People are added from a company’s page.</p>
  }

  return (
    <table style={{ marginTop: 14 }}>
      <thead>
        <tr>
          <th>Person</th>
          <th>Addresses</th>
          <th>Timezone</th>
          <th>Consent</th>
          <th>Suppression</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const li = r.linkedinUrl ? linkedinHref(r.linkedinUrl) : null
          const panel = open?.id === r.id ? open.panel : null
          return (
            <Fragment key={r.id}>
              <tr>
                <td>
                  <strong>{r.name}</strong>
                  {r.pausedAt ? <span className="tag warn">paused</span> : null}
                  {r.emailBouncedAt ? <span className="tag warn">bounced</span> : null}
                  {r.title ? <div className="muted" style={{ fontSize: 12.5 }}>{r.title}</div> : null}
                  <div style={{ fontSize: 12.5 }}>
                    <a href={`/companies/${r.companyDomain}`}>{r.companyName ?? r.companyDomain}</a>
                  </div>
                  {r.pausedAt ? (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Paused: {r.pausedReason ?? 'no reason recorded'} · <When iso={r.pausedAt} mode="date" />
                    </div>
                  ) : null}
                  {r.emailBouncedAt ? (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Address bounced{r.emailBounceCode ? ` (${r.emailBounceCode})` : ''} · <When iso={r.emailBouncedAt} mode="date" />
                    </div>
                  ) : null}
                </td>
                <td style={{ fontSize: 12.5 }}>
                  {r.email ? <div><code>{r.email}</code></div> : null}
                  {r.phone ? <div style={{ marginTop: 3 }}><code>{r.phone}</code></div> : null}
                  {r.linkedinUrl ? (
                    <div style={{ marginTop: 3 }}>
                      {li ? (
                        <a href={li} target="_blank" rel="noreferrer">LinkedIn</a>
                      ) : (
                        <code title="Not a LinkedIn URL this system can read">{r.linkedinUrl}</code>
                      )}
                    </div>
                  ) : null}
                </td>
                <td style={{ fontSize: 12.5 }}>
                  <span className={r.zoneMissing ? 'ledger-state none' : undefined} style={{ whiteSpace: 'normal' }}>{r.zone}</span>
                </td>
                <td>
                  {r.channels.map((c) => (
                    <div key={c.channel} className={`ledger-state ${c.cls}`} title={c.source ?? undefined}>
                      {c.channel}: {c.label}
                    </div>
                  ))}
                </td>
                <td>
                  {r.suppression.map((s) => (
                    <div key={s.key} className={`ledger-state ${s.cls}`}>
                      {KEY_WORDS[s.key]}: {s.label}
                    </div>
                  ))}
                  {r.matches.length > 0 ? (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                      matched by {r.matches.map((m) => `${m.kind}${m.source ? ` (${m.source})` : ''}`).join(', ')}
                    </div>
                  ) : null}
                </td>
                <td>
                  <div className="row-actions" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                    <button type="button" className="linkish" onClick={() => toggle(r.id, 'check')}>
                      Why can’t I reach them?
                    </button>
                    {canWrite ? (
                      <>
                        <button type="button" className="linkish" onClick={() => toggle(r.id, 'edit')}>
                          Edit and consent
                        </button>
                        {r.pausedAt ? (
                          <button type="button" className="linkish" disabled={busy === r.id} onClick={() => void patch(r.id, { action: 'resume' })}>
                            Resume
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="linkish"
                            disabled={busy === r.id}
                            onClick={() => {
                              const reason = window.prompt('Why pause them? (kept with the pause)')
                              if (reason?.trim()) void patch(r.id, { action: 'pause', reason })
                            }}
                          >
                            Pause
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                  {errors[r.id] ? <div className="err-line">{errors[r.id]}</div> : null}
                </td>
              </tr>
              {panel ? (
                <tr>
                  <td colSpan={6} style={{ background: 'var(--bg)' }}>
                    {panel === 'check' ? (
                      <SendCheck contactId={r.id} campaigns={campaigns} />
                    ) : (
                      <ContactEdit
                        contact={{
                          id: r.id,
                          firstName: r.firstName,
                          lastName: r.lastName,
                          title: r.title,
                          email: r.email,
                          phone: r.phone,
                          linkedinUrl: r.linkedinUrl,
                        }}
                        channels={r.channels.map((c) => ({ channel: c.channel, state: c.state }))}
                        isOwner={isOwner}
                        onCancel={() => setOpen(null)}
                      />
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

interface SendCheckResponse extends SendCheckView {
  readonly facts: {
    readonly quietStart: string
    readonly quietEnd: string
    readonly recipientTimeZone: string | null
    readonly zoneFrom: 'contact' | 'company' | null
    readonly sentToday: number
    readonly dailyCap: number
    readonly campaignStatus: string
    /** The sender stops at a pause before it counts anything, so `sentToday` is not a count then. */
    readonly paused: boolean
  }
}

/** "Why can't I reach them?" — the sender's dry run for one campaign. */
function SendCheck({ contactId, campaigns }: { contactId: string; campaigns: readonly LedgerCampaign[] }) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '')
  const [answer, setAnswer] = useState<SendCheckResponse | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (campaigns.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        There is no campaign yet, and a campaign is where the daily cap and the quiet hours live — so there is
        nothing to check against. Create one on the <a href="/campaigns">Campaigns</a> page.
      </p>
    )
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setAnswer(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/send-check?campaignId=${encodeURIComponent(campaignId)}`)
      const b = (await res.json().catch(() => ({}))) as Partial<SendCheckResponse> & { error?: string }
      if (!res.ok || !b.decision || !b.facts) {
        setError(b.error ?? 'The check did not complete.')
        return
      }
      setAnswer(b as SendCheckResponse)
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const f = answer?.facts
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Under campaign
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={{ padding: '3px 6px' }}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.channel}, {c.status})
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy || !campaignId} onClick={() => void run()} style={{ padding: '4px 10px', fontSize: 12.5 }}>
          {busy ? 'Checking…' : 'Check'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          A dry run of the sender’s own rules. It queues nothing and sends nothing.
        </span>
      </div>
      {error ? <div className="err-line">{error}</div> : null}
      {answer && f ? (
        <div style={{ marginTop: 8 }}>
          <div className={answer.decision.allowed ? 'ok-line' : 'err-line'} style={{ fontSize: 13 }}>
            {sendCheckSentence(answer)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Quiet hours {f.quietStart}–{f.quietEnd}
            {f.recipientTimeZone
              ? ` in ${f.recipientTimeZone}${f.zoneFrom === 'company' ? ' (their company’s zone)' : ''}`
              : ', in no known zone'}
            {f.paused ? null : ` · ${f.sentToday} of ${f.dailyCap} sent today`}
            {` · campaign ${f.campaignStatus}`}
          </div>
        </div>
      ) : null}
    </div>
  )
}
