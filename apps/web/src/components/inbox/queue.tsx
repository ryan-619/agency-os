'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { When } from '@/components/when'
import { answerElsewhere, answersByTemplate, channelLabel, contactsLinkFor, matchedByWords } from '@/components/inbox/channel'
import { optedOutNote, optedOutWarning, type OptedOutRow } from '@/components/inbox/opted-out'
import { answerComposerNote, colleagueHeadline, resumedLine, type ReplySender } from '@/components/inbox/sender'
import { SharedNumberHolderNote } from '@/components/shared-number-note'
import {
  ANSWER_BODY_MAX, ANSWER_SUBJECT_MAX, HUMAN_REPLY_KINDS, INBOX_GROUP_LABELS, RECLASSIFY_HINT, answerIsLive,
  answerStateWords, answerSubject, type InboxGroup,
} from '@/lib/inbox-view'
import { SHARED_NUMBER_LABEL, isSharedNumberOptOutPause } from '@/lib/shared-number-pause'

/**
 * The inbox's rows and what a person can do with each (PROMPT.md §8.4).
 *
 * Four actions, and none of them sends anything:
 *
 *  - Handled — a name and a time on the reply, once.
 *  - Reclassify — any of the five kinds. Never `opted_out`, in either
 *    direction: that kind is the person's own words, read by a pure function
 *    when the reply arrived, and the suppression row is what enforces it.
 *  - Pause / Resume — the contacts route, exactly as on the company page.
 *  - Answer — a DRAFT, parked on /approvals. Drafting resumes the person
 *    (their reply paused them everywhere), and the worker sends it only after
 *    a person approves it and every rule passes again at that moment. Not
 *    on SMS or WhatsApp (0019): an answer there is a registered template, so
 *    the row points at Draft SMS on /contacts instead of offering free text
 *    — and, since Draft SMS refuses a paused person and resumes nobody, says
 *    to resume them there first when their reply paused them.
 *
 * A reply from somebody else on the thread — a colleague replying all to
 * our message, filed under the contact it went to — is headlined under its
 * sender, "filed under" the contact, and its composer says the answer goes
 * to the contact's address on file, not to the sender (`sender.ts`; review
 * round 9). A shared number's holder reads beside Resume what lifts their
 * pause (`SharedNumberHolderNote`), as on /contacts, and the number it asks
 * to be recorded — the one on their record (review round 10, [7]).
 *
 * The reply's body is shown whole. Somebody deciding what to do about a
 * message has to be able to read all of it.
 */

export interface InboxRowView {
  readonly id: string
  readonly group: InboxGroup
  readonly channel: string
  readonly subject: string | null
  readonly body: string | null
  /** The address it came from, as received. */
  readonly from: string | null
  readonly receivedAt: string
  /** In the person's own zone, formatted on the server; null when neither they nor their company has one. */
  readonly localTime: string | null
  readonly company: { readonly domain: string; readonly name: string | null } | null
  readonly contact: {
    readonly id: string
    readonly name: string
    readonly email: string | null
    /** Shown beside a shared number's holder's note — the number it asks to be recorded. */
    readonly phone: string | null
    readonly pausedReason: string | null
    readonly paused: boolean
  } | null
  /** The message this answers, when it was matched by Message-ID. Null: matched by address. */
  readonly parent: {
    readonly subject: string | null
    readonly campaignId: string | null
    readonly campaignName: string | null
    readonly approvedBy: string | null
    readonly sentAt: string | null
  } | null
  readonly dealStage: string | null
  /** For a reply that asked to stop, by the address it came from alone (`inboxTouches`). */
  readonly suppressed: boolean
  /**
   * False when the reply came from another address than the contact it is
   * filed under — a colleague replying all to our message (review round 8):
   * a stop in it is theirs, never the contact's.
   */
  readonly fromIsContact: boolean
  readonly handled: { readonly by: string; readonly at: string } | null
  readonly answered: { readonly touchId: string; readonly status: string } | null
}

export interface InboxCampaignChoice {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly status: string
}

type Drafted = { readonly lines: readonly string[] }

/** What `opted-out.ts` reads off a row to say whose stop it was. */
function stopOf(row: InboxRowView): OptedOutRow {
  return { fromIsContact: row.fromIsContact, from: row.from, contactName: row.contact?.name ?? null, suppressed: row.suppressed }
}

/** What `sender.ts` reads off a row to say whose reply it was, and where an answer goes. */
function senderOf(row: InboxRowView): ReplySender {
  return {
    fromIsContact: row.fromIsContact,
    from: row.from,
    contactName: row.contact?.name ?? null,
    contactEmail: row.contact?.email ?? null,
  }
}

export function InboxQueue({
  groups,
  campaigns,
  canWrite,
  canAnswer,
}: {
  groups: readonly { readonly group: InboxGroup; readonly label: string; readonly rows: readonly InboxRowView[] }[]
  campaigns: readonly InboxCampaignChoice[]
  /** contacts:write — Handled, Reclassify, Pause and Resume. */
  canWrite: boolean
  /** campaigns:write — Answer. */
  canAnswer: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [drafted, setDrafted] = useState<Record<string, Drafted>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, { subject: string; body: string; campaignId: string }>>({})

  const fail = (id: string, message: string) => setErrors((e) => ({ ...e, [id]: message }))

  const send = async (id: string, url: string, method: 'PATCH' | 'POST', body: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(id)
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        fail(id, typeof b.error === 'string' ? b.error : 'That did not work.')
        return null
      }
      return b
    } catch {
      fail(id, 'The request did not complete. Try again.')
      return null
    } finally {
      setBusy(null)
    }
  }

  const act = async (row: InboxRowView, body: Record<string, unknown>) => {
    if (await send(row.id, `/api/inbox/${row.id}`, 'PATCH', body)) router.refresh()
  }

  const pause = async (row: InboxRowView) => {
    if (!row.contact) return
    const reason = window.prompt(`Why pause ${row.contact.name}? (kept with the pause; every campaign stops writing to them)`)
    if (reason === null) return
    if (!reason.trim()) {
      fail(row.id, 'Say why — a pause with no reason gets cleared.')
      return
    }
    if (await send(row.id, `/api/contacts/${row.contact.id}`, 'PATCH', { action: 'pause', reason })) router.refresh()
  }

  const resume = async (row: InboxRowView) => {
    if (!row.contact) return
    // The pause this row showed: the route lifts that one and no other.
    const body = { action: 'resume', pausedReason: row.contact.pausedReason }
    if (await send(row.id, `/api/contacts/${row.contact.id}`, 'PATCH', body)) router.refresh()
  }

  const formFor = (row: InboxRowView) =>
    form[row.id] ?? { subject: answerSubject(row.subject), body: '', campaignId: row.parent?.campaignId ?? '' }

  const edit = (row: InboxRowView, patch: Partial<{ subject: string; body: string; campaignId: string }>) =>
    setForm((f) => ({ ...f, [row.id]: { ...formFor(row), ...f[row.id], ...patch } }))

  const answer = async (row: InboxRowView) => {
    const f = formFor(row)
    const b = await send(row.id, `/api/inbox/${row.id}/reply`, 'POST', {
      subject: f.subject,
      body: f.body,
      campaignId: f.campaignId || null,
    })
    if (!b) return
    const lines: string[] = [typeof b.note === 'string' ? b.note : 'Drafted. A person approves it on /approvals.']
    if (b.resumed === true && row.contact) lines.push(resumedLine(senderOf(row)))
    const hold = b.wouldHold as { reason?: unknown } | null | undefined
    if (hold && typeof hold.reason === 'string') lines.push(`If it were approved right now: ${hold.reason}`)
    if (typeof b.deployment === 'string') lines.push(b.deployment)
    setDrafted((d) => ({ ...d, [row.id]: { lines } }))
    setOpen(null)
    router.refresh()
  }

  return (
    <div>
      {groups.map((g) => (
        <section key={g.group}>
          <h2>
            {g.label} <span className="muted" style={{ fontWeight: 400 }}>({g.rows.length})</span>
          </h2>
          <div className="card" style={{ padding: '0 15px' }}>
            {g.rows.map((row) => {
              const optedOut = row.group === 'opted_out'
              const live = row.answered ? answerIsLive(row.answered.status) : false
              const forChannel = campaigns.filter((c) => c.channel === row.channel)
              const f = formFor(row)
              const done = drafted[row.id]
              const colleague = colleagueHeadline(senderOf(row))
              return (
                <div key={row.id} className="inbox-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="touch-head">
                      <span className="inbox-kind">{INBOX_GROUP_LABELS[row.group]}</span>
                      {channelLabel(row.channel) ? <span className="pill">{channelLabel(row.channel)}</span> : null}
                      {colleague ? (
                        <>
                          <strong>{colleague.sender}</strong>
                          <span className="muted">— {colleague.note}</span>
                        </>
                      ) : (
                        <>
                          <strong>{row.contact?.name ?? 'a contact no longer in the CRM'}</strong>
                          {row.from ? <span className="muted">&lt;{row.from}&gt;</span> : null}
                        </>
                      )}
                      {row.company ? (
                        <a href={`/companies/${encodeURIComponent(row.company.domain)}`}>
                          {row.company.name ?? row.company.domain}
                        </a>
                      ) : null}
                      {row.dealStage ? <span className="pill">deal: {row.dealStage}</span> : null}
                      {row.contact?.paused ? (
                        <span className="pill pill-c" title={row.contact.pausedReason ?? undefined}>paused</span>
                      ) : null}
                      {row.suppressed ? <span className="pill pill-c">on the suppression list</span> : null}
                    </div>

                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {row.localTime ? (
                        <>their time: {row.localTime}</>
                      ) : (
                        <>
                          received <When iso={row.receivedAt} /> (your time — no timezone on them or their company)
                        </>
                      )}
                    </div>

                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {row.parent ? (
                        <>
                          answers “{row.parent.subject ?? '(no subject)'}”
                          {row.parent.campaignName ? <> · {row.parent.campaignName}</> : null}
                          {row.parent.approvedBy ? <> · approved by {row.parent.approvedBy}</> : null}
                          {row.parent.sentAt ? (
                            <>
                              {' '}
                              · sent <When iso={row.parent.sentAt} />
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>{matchedByWords(row.channel)}</>
                      )}
                    </div>

                    {answersByTemplate(row.channel) && !row.subject ? null : (
                      <div style={{ marginTop: 8, fontSize: 13.5 }}>
                        <strong>{row.subject ?? '(no subject)'}</strong>
                      </div>
                    )}
                    <pre className="touch-body" style={{ maxHeight: 'none' }}>{row.body ?? '(no text)'}</pre>

                    {optedOut ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
                        {optedOutNote(stopOf(row))} <a href="/suppressions">The suppression list</a>.
                      </p>
                    ) : null}
                    {optedOut && optedOutWarning(stopOf(row)) ? (
                      <div className="note note-warn" style={{ marginTop: 8 }}>{optedOutWarning(stopOf(row))}</div>
                    ) : null}

                    {row.answered ? (
                      <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
                        {answerStateWords(row.answered.status)}
                        {row.answered.status === 'awaiting_approval' ? (
                          <>
                            {' '}
                            — <a href="/approvals">open approvals</a>
                          </>
                        ) : null}
                      </p>
                    ) : null}

                    {done ? (
                      <div className="note" style={{ marginTop: 8 }}>
                        {done.lines.map((l) => (
                          <div key={l}>{l}</div>
                        ))}
                      </div>
                    ) : null}

                    {open === row.id ? (
                      <div className="row-card" style={{ marginTop: 10 }}>
                        <label>
                          Subject
                          <input
                            value={f.subject}
                            maxLength={ANSWER_SUBJECT_MAX}
                            onChange={(e) => edit(row, { subject: e.target.value })}
                          />
                        </label>
                        <label>
                          Answer
                          <textarea
                            rows={7}
                            value={f.body}
                            maxLength={ANSWER_BODY_MAX}
                            onChange={(e) => edit(row, { body: e.target.value })}
                          />
                          <span className="hint">
                            {f.body.length}/{ANSWER_BODY_MAX}. Sent as plain text, threaded under their reply.
                          </span>
                        </label>
                        <label>
                          Under campaign
                          <select value={f.campaignId} onChange={(e) => edit(row, { campaignId: e.target.value })}>
                            <option value="">
                              {forChannel.length === 0 ? `No ${row.channel} campaign exists yet` : 'Choose a campaign'}
                            </option>
                            {forChannel.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                                {c.id === row.parent?.campaignId ? ' (the one they replied to)' : ''}
                                {c.status !== 'active' ? ` (${c.status})` : ''}
                              </option>
                            ))}
                          </select>
                          <span className="hint">
                            The campaign is where the daily cap and quiet hours come from. Only {row.channel} campaigns
                            are offered — an answer goes back the way the reply came.
                          </span>
                        </label>
                        <p className="hint" style={{ marginTop: 10 }}>
                          {answerComposerNote(senderOf(row))}
                        </p>
                        <div className="inbox-actions" style={{ marginTop: 10 }}>
                          <button
                            type="button"
                            disabled={busy === row.id || !f.subject.trim() || !f.body.trim() || !f.campaignId}
                            onClick={() => void answer(row)}
                          >
                            Draft the answer
                          </button>
                          <button type="button" className="linkish" onClick={() => setOpen(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {errors[row.id] ? <div className="err-line">{errors[row.id]}</div> : null}
                  </div>

                  <div className="inbox-actions" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
                    {row.handled ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        handled by {row.handled.by}, <When iso={row.handled.at} />
                      </span>
                    ) : canWrite ? (
                      <button type="button" disabled={busy === row.id} onClick={() => void act(row, { action: 'handled' })}>
                        Handled
                      </button>
                    ) : null}

                    {canWrite && !optedOut ? (
                      <label style={{ margin: 0, textAlign: 'right' }}>
                        <select
                          aria-label="Reclassify"
                          value=""
                          disabled={busy === row.id}
                          onChange={(e) => {
                            if (e.target.value) void act(row, { action: 'reclassify', kind: e.target.value })
                          }}
                        >
                          <option value="">Reclassify…</option>
                          {HUMAN_REPLY_KINDS.filter((k) => k !== row.group).map((k) => (
                            <option key={k} value={k}>
                              {INBOX_GROUP_LABELS[k]}
                            </option>
                          ))}
                        </select>
                        <span className="hint" style={{ maxWidth: 190 }}>
                          Not “asked to stop”: {RECLASSIFY_HINT}
                        </span>
                      </label>
                    ) : null}

                    {canWrite && row.contact && !optedOut ? (
                      row.contact.paused ? (
                        <>
                          <button type="button" disabled={busy === row.id} onClick={() => void resume(row)}>
                            Resume
                          </button>
                          {isSharedNumberOptOutPause(row.contact.pausedReason) ? (
                            <span className="hint" style={{ maxWidth: 190, textAlign: 'right' }}>
                              <SharedNumberHolderNote />
                              {row.contact.phone ? (
                                <>
                                  {' '}
                                  {SHARED_NUMBER_LABEL} <code>{row.contact.phone}</code>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <button type="button" disabled={busy === row.id} onClick={() => void pause(row)}>
                          Pause
                        </button>
                      )
                    ) : null}

                    {canAnswer && row.contact && !optedOut && !row.suppressed && !live && answersByTemplate(row.channel) ? (
                      <span className="hint" style={{ maxWidth: 190, textAlign: 'right' }}>
                        {answerElsewhere(row.channel, row.contact)}
                        {row.channel === 'sms' ? (
                          <>
                            {' '}
                            <a href={contactsLinkFor(row.contact.name)}>Open {row.contact.name}</a>
                          </>
                        ) : null}
                      </span>
                    ) : canAnswer && row.contact && !optedOut && !row.suppressed && !live && open !== row.id ? (
                      <button type="button" disabled={busy === row.id} onClick={() => setOpen(row.id)}>
                        Answer
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
