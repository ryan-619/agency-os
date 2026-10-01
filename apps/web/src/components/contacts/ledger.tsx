'use client'

import { Fragment, useState } from 'react'
import { pauseReasonClass } from '@agency/core'
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
 * this component renders and does not decide — with one reading of its own:
 * which pause buttons a row gets, from the pause's CLASS, through
 * `pauseReasonClass`, the one pure reader the route, the inbox and the send
 * path share (review round 3). A pause an unrecorded opt-out or an
 * unfinished erasure left gets no Resume and says what to do instead — the
 * route refuses it anyway (409) — and a reply's pause gets Pause beside
 * Resume, so a teammate can hold somebody whose reply someone may answer.
 * The route also refuses a resume while an opt-out the audit log says was
 * never recorded matches no suppression row; that needs the database, so
 * the row shows the route's sentence when it happens. The one thing it asks for
 * itself is "Why can't I reach them?", which calls the sender's own dry run
 * (`/api/contacts/[id]/send-check`) and prints the answer in the words every
 * other screen uses. That call queues nothing; the page says so beside it.
 *
 * Two more per row. "Download record" is everything held about the person,
 * as JSON (`/api/contacts/[id]/record`, any member, audited). "Erase…" is
 * owners only, and asks for the contact's id typed back before it will send
 * anything: an erasure cannot be undone, and it keeps the suppression — the
 * panel says exactly what goes, what stays, and what is not scrubbed.
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

type Panel = 'check' | 'edit' | 'erase'

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
  const [open, setOpen] = useState<{ id: string; panel: Panel } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const toggle = (id: string, panel: Panel) =>
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
          // Null when they are not paused. Which buttons the row gets — see the header.
          const pausedFor = r.pausedAt ? pauseReasonClass(r.pausedReason) : null
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
                    <a
                      href={`/api/contacts/${r.id}/record`}
                      className="linkish"
                      title="Everything held about them, as JSON. The download is recorded in the audit log."
                    >
                      Download record
                    </a>
                    {canWrite ? (
                      <>
                        <button type="button" className="linkish" onClick={() => toggle(r.id, 'edit')}>
                          Edit and consent
                        </button>
                        {pausedFor === 'opt_out_not_recorded' ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            No Resume: they asked to stop and it could not be recorded. Record the opt-out on{' '}
                            <a href="/suppressions">/suppressions</a>; the pause stays.
                          </span>
                        ) : pausedFor === 'erasure' ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            No Resume: they asked to be erased and it did not complete. An owner finishes it with Erase….
                          </span>
                        ) : pausedFor ? (
                          <button type="button" className="linkish" disabled={busy === r.id} onClick={() => void patch(r.id, { action: 'resume' })}>
                            Resume
                          </button>
                        ) : null}
                        {!pausedFor || pausedFor === 'replied' ? (
                          <button
                            type="button"
                            className="linkish"
                            disabled={busy === r.id}
                            title={
                              pausedFor === 'replied'
                                ? 'Replaces the pause their reply caused with yours, so answering the reply will not lift it.'
                                : undefined
                            }
                            onClick={() => {
                              const reason = window.prompt(
                                pausedFor === 'replied'
                                  ? 'Why hold them? This replaces the pause their reply caused, so answering the reply will not lift it. (Kept with the pause.)'
                                  : 'Why pause them? (kept with the pause)',
                              )
                              if (reason?.trim()) void patch(r.id, { action: 'pause', reason })
                            }}
                          >
                            {pausedFor === 'replied' ? 'Hold (pause)' : 'Pause'}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {isOwner ? (
                      <button type="button" className="linkish" style={{ color: 'var(--warn)' }} onClick={() => toggle(r.id, 'erase')}>
                        Erase…
                      </button>
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
                    ) : panel === 'erase' ? (
                      <EraseContact contactId={r.id} name={r.name} onCancel={() => setOpen(null)} />
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

interface EraseResponse {
  readonly erased: true
  readonly touchesScrubbed: number
  readonly callsScrubbed: number
  readonly suppressionsAdded: number
  readonly suppressionsNew: number
  readonly meetingsScrubbed: number
  readonly notesDeleted: number
  readonly tasksDeleted: number
  readonly cancelled: number
  readonly companyRenamed: boolean
  readonly skipped: readonly { readonly from: 'contact' | 'message' | 'call' | 'opt_out'; readonly why: 'company_page' | 'unreadable' }[]
  readonly recordingsAtCarrier: readonly string[]
}

const SKIP_WORDS: Record<EraseResponse['skipped'][number]['from'], string> = {
  contact: 'the LinkedIn URL on their row',
  message: 'the address on a message that went out',
  call: 'the number on a call',
  opt_out: 'the address or number an opt-out was recorded against',
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The erasure panel (owners only). Says what goes, what stays and what is
 * not scrubbed BEFORE the button, and will not send until the contact's id
 * is typed back — the same check the route makes.
 */
function EraseContact({ contactId, name, onCancel }: { contactId: string; name: string; onCancel: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<EraseResponse | null>(null)
  const confirmed = typed.trim().toLowerCase() === contactId.toLowerCase()

  const erase = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/contacts/${contactId}/erase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      })
      const b = (await res.json().catch(() => ({}))) as Partial<EraseResponse> & { error?: string }
      if (!res.ok || b.erased !== true) {
        setError(b.error ?? 'The erasure did not complete. Nothing was erased.')
        return
      }
      setDone(b as EraseResponse)
    } catch {
      setError('The request did not complete. Reload the page to see whether they are still listed before trying again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="row-card slim" style={{ fontSize: 13 }}>
        <div className="ok-line" style={{ fontSize: 13, marginTop: 0 }}>
          Erased. {plural(done.touchesScrubbed, 'message')} and {plural(done.callsScrubbed, 'call')} scrubbed;{' '}
          {plural(done.suppressionsAdded, 'key')} kept on the suppression list
          {done.suppressionsAdded > done.suppressionsNew ? ` (${done.suppressionsAdded - done.suppressionsNew} already there)` : ''}.
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          {plural(done.meetingsScrubbed, 'meeting')} lost title and notes · {plural(done.notesDeleted, 'note')} and{' '}
          {plural(done.tasksDeleted, 'task')} deleted
          {done.cancelled > 0 ? ` · ${plural(done.cancelled, 'queued message')} refused` : ''}
          {done.companyRenamed ? ' · the company the booking page named after them was renamed' : ''}
        </div>
        {done.recordingsAtCarrier.length > 0 ? (
          <div className="note warn" style={{ fontSize: 12.5 }}>
            <strong>One more step, by hand.</strong> The link to {plural(done.recordingsAtCarrier.length, 'call recording')} was
            removed here, but the recording itself is stored at Twilio, the voice provider, and nothing here can delete
            it. Delete it in the Twilio console, where it is found by its call SID: {done.recordingsAtCarrier.map((sid, i) => (
              <Fragment key={sid}>{i > 0 ? ', ' : ''}<code>{sid}</code></Fragment>
            ))}
          </div>
        ) : null}
        {done.skipped.length > 0 ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            Not put on the suppression list:{' '}
            {done.skipped
              .map((s) => `${SKIP_WORDS[s.from]} (${s.why === 'company_page' ? 'a company page, not a person — suppressing it would silence the whole company' : 'it cannot be read as an address or number, so nothing can be sent to it either'})`)
              .join('; ')}
            .
          </div>
        ) : null}
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => window.location.reload()}>
            Refresh the list
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="row-card slim" style={{ fontSize: 13 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Erase {name}</h3>
      <p style={{ margin: '0 0 6px' }}>
        <strong>Erasure keeps the suppression:</strong> the person’s address, number and profile go on the suppression
        list first, so a re-import can never contact them again. If any of them cannot be stored, nothing is erased.
      </p>
      <ul style={{ margin: '0 0 6px', paddingLeft: 18, fontSize: 12.5 }}>
        <li>Messages they sent lose their subject, body and address. Messages sent to them keep the agency’s words and lose the address.</li>
        <li>Calls lose both numbers, the transcript, the summary and the recording link. Meetings stay, without title or notes.</li>
        <li>Notes about them and tasks on their messages are deleted, then the contact and their consents. Anything still queued to them is refused.</li>
        <li>An opt-out keeps the one address or number it was recorded against — it is on the suppression list anyway, and the compliance page checks it.</li>
      </ul>
      <p className="muted" style={{ margin: '0 0 6px', fontSize: 12.5 }}>
        Not scrubbed: chat transcripts; audit detail, which holds ids and counts except a reason a teammate typed and
        the suppression list’s own history (an added or removed address keeps its value there, for the same reason the
        suppression is kept — both are in their record); free text about the company
        that happens to name them, like a company note or a deal’s next action; and a call recording stored at
        Twilio — the result lists the call SIDs to delete there by hand. It cannot be undone:{' '}
        <a href={`/api/contacts/${contactId}/record`}>download their record</a> first if they asked for a copy.
      </p>
      <label>
        Type the contact id <code>{contactId}</code> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} />
      </label>
      {error ? <div className="err-line">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button
          type="button"
          disabled={busy || !confirmed}
          onClick={() => void erase()}
          style={{ background: 'var(--panel)', color: 'var(--warn)', border: '1px solid var(--warn)' }}
        >
          {busy ? 'Erasing…' : 'Erase permanently'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
