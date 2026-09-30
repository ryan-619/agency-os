'use client'

import { useEffect, useRef, useState } from 'react'
import { When } from '@/components/when'
import {
  EVIDENCE_LINES_SHOWN, KEY_HELP, OTHER_CAMPAIGN_NOTE,
  addressedByLabel, approvability, approveBlock, approveFootnote, candidateLine, checkedUnderLabel,
  evidenceHeading, evidenceNote, keyAction,
  type AddressedBy, type Approvability, type CandidateDecision, type CheckedUnder, type DraftEvidence,
} from '@/lib/approval-view'

/**
 * Message drafts waiting for a person (PROMPT.md §2.4, §8.4).
 *
 * The agent's `queue_touch` writes a draft ABOUT a company, to nobody.
 * Enrolment and the inbox write one already addressed, and the card says who
 * chose and that the choice can be changed. Either way the person approving
 * names the recipient and the campaign, and their name goes on the row.
 *
 * Nothing is sent by approving: the worker's next tick re-checks every §2.1
 * rule at the moment of sending. What this card adds is the rule IN VIEW
 * while the person reads the words — each candidate's `previewSend` answer,
 * from the sender's own fact-gatherer, in `REFUSAL_WORDS` — and the evidence
 * the draft may quote, dated, with §2.2's warning when it is stale. The
 * display is read-only; the check stays in the send path. The one thing it
 * changes is that Approve is disabled for a rule nobody may approve past,
 * and says why, rather than recording a yes the worker must refuse.
 *
 * The body is shown whole and unformatted. Someone deciding whether this may
 * be sent has to see exactly what will be sent.
 */

export interface DraftCandidate {
  readonly id: string
  readonly label: string
  /** `previewSend` under `DraftView.checkedUnder`; null when there was no campaign to check under. */
  readonly decision: CandidateDecision | null
}

export interface DraftView {
  readonly id: string
  readonly channel: string
  readonly subject: string | null
  readonly body: string | null
  readonly createdAt: string
  readonly company: { readonly id: string; readonly domain: string; readonly name: string | null } | null
  /** Preselected when the row already carries them — enrolment rows and inbox answers do. */
  readonly contactId?: string | null
  readonly campaignId?: string | null
  readonly addressedBy: AddressedBy
  /** The campaign every candidate's decision was computed under, or null when the channel has none. */
  readonly checkedUnder: CheckedUnder | null
  /** Everyone at the draft's company, plus the preselected person if they are not. */
  readonly candidates: readonly DraftCandidate[]
  /** The quotable evidence and its scan's date; null when there is no successful scan. */
  readonly evidence: DraftEvidence | null
}

export interface CampaignChoice {
  readonly id: string
  readonly name: string
  readonly channel: string
  readonly autoSend: boolean
  readonly status: string
}

type Settled = { outcome: 'approved' | 'refused' | 'taken'; message: string }
type Choice = { contactId: string; campaignId: string; note: string }

const EMPTY: Choice = { contactId: '', campaignId: '', note: '' }

export function DraftQueue({
  drafts,
  campaigns,
  canDecide,
  noSenderNote = null,
}: {
  drafts: readonly DraftView[]
  campaigns: readonly CampaignChoice[]
  canDecide: boolean
  /**
   * `nothingWillSendNote()`: null when a worker drains the queue. Set on a
   * deployment that runs only the web app, where an approved message stays
   * approved forever — and telling somebody "it will send on the next pass"
   * would be the product claiming something it did not do.
   */
  noSenderNote?: string | null
}) {
  const [settled, setSettled] = useState<Record<string, Settled>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [choice, setChoice] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      drafts.map((d) => [d.id, { contactId: d.contactId ?? '', campaignId: d.campaignId ?? '', note: '' }]),
    ),
  )
  /** The card with DOM focus, for the outline. The keys read the event's own target. */
  const [focused, setFocused] = useState<string | null>(null)
  /** The card `a` armed. Only Enter on this same card approves it. */
  const [armed, setArmed] = useState<string | null>(null)
  /** Why `a` did nothing, shown on the card that was asked. */
  const [explained, setExplained] = useState<Record<string, string>>({})
  const cards = useRef(new Map<string, HTMLDivElement>())

  const pick = (id: string, patch: Partial<Choice>) => {
    setChoice((c) => ({ ...c, [id]: { ...EMPTY, ...c[id], ...patch } }))
    setExplained((x) => ({ ...x, [id]: '' }))
  }

  const decisionFor = (d: DraftView, contactId: string): CandidateDecision | null =>
    d.candidates.find((c) => c.id === contactId)?.decision ?? null

  const decide = async (draft: DraftView, decision: 'approved' | 'denied'): Promise<void> => {
    const chosen = choice[draft.id] ?? EMPTY
    setBusy(draft.id)
    setArmed(null)
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
                ? noSenderNote === null
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

  const approvableNow = (d: DraftView): Approvability => {
    const chosen = choice[d.id] ?? EMPTY
    return approvability({
      canDecide,
      settled: Boolean(settled[d.id]),
      busy: busy === d.id,
      contactId: chosen.contactId,
      campaignId: chosen.campaignId,
      block: approveBlock(decisionFor(d, chosen.contactId)),
    })
  }

  /**
   * The keyboard (§2.4). Approving is `a` and then Enter on the SAME card
   * the person focused — never one key — because a stray keypress in the
   * wrong tab must not end with a message leaving the building. The listener
   * is bound once; it reads the latest render through this ref, which an
   * effect refreshes after every render.
   */
  const latest = useRef<{
    drafts: readonly DraftView[]
    armed: string | null
    approvableNow: (d: DraftView) => Approvability
    decide: (d: DraftView, decision: 'approved' | 'denied') => Promise<void>
    open: (id: string) => boolean
    deniable: (id: string) => boolean
  }>({
    drafts,
    armed,
    approvableNow,
    decide,
    open: () => false,
    deniable: () => false,
  })
  useEffect(() => {
    latest.current = {
      drafts,
      armed,
      approvableNow,
      decide,
      open: (id: string) => !settled[id],
      deniable: (id: string) => canDecide && !settled[id] && busy !== id,
    }
  })
  useEffect(() => {
    if (!canDecide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const target = e.target instanceof HTMLElement ? e.target : null
      const card = target?.dataset.draftCard ?? null
      // A key typed into a field, on a button or a link belongs to that
      // control. Only a focused card, or the page itself (for j/k), is ours.
      const onPage = target === null || target === document.body || target === document.documentElement
      if (card === null && !onPage) return

      const s = latest.current
      const byId = new Map(s.drafts.map((d) => [d.id, d]))
      const action = keyAction({
        key: e.key,
        // j/k walk the cards still waiting; a decided one is behind the person.
        ids: s.drafts.filter((d) => s.open(d.id)).map((d) => d.id),
        focused: card,
        armed: s.armed,
        approvable: (id) => {
          const d = byId.get(id)
          return d ? s.approvableNow(d) : { ok: false, why: 'That draft is no longer on this page.' }
        },
        deniable: s.deniable,
      })
      switch (action.kind) {
        case 'none':
          return
        case 'disarm':
          s.armed = null
          setArmed(null)
          return
        case 'focus':
          e.preventDefault()
          s.armed = null
          setArmed(null)
          cards.current.get(action.id)?.focus()
          cards.current.get(action.id)?.scrollIntoView({ block: 'nearest' })
          return
        case 'arm':
          e.preventDefault()
          // Written through at once as well as into state, so an Enter that
          // lands before the re-render still finds the card armed — and a
          // disarm still finds it disarmed.
          s.armed = action.id
          setArmed(action.id)
          setExplained((x) => ({ ...x, [action.id]: '' }))
          return
        case 'explain':
          e.preventDefault()
          s.armed = null
          setArmed(null)
          setExplained((x) => ({ ...x, [action.id]: action.why }))
          return
        case 'approve':
        case 'deny': {
          e.preventDefault()
          s.armed = null
          const d = byId.get(action.id)
          if (d) void s.decide(d, action.kind === 'approve' ? 'approved' : 'denied')
          return
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canDecide])

  return (
    <>
      {noSenderNote ? (
        <div className="note note-warn" style={{ marginBottom: 10 }}>
          {noSenderNote}
        </div>
      ) : null}
      {canDecide ? (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          {KEY_HELP}
        </p>
      ) : null}
      <div className="queue">
        {drafts.map((d) => {
          const done = settled[d.id]
          const chosen = choice[d.id] ?? EMPTY
          const forChannel = campaigns.filter((c) => c.channel === d.channel)
          const decision = decisionFor(d, chosen.contactId)
          const block = chosen.contactId ? approveBlock(decision) : null
          const note = evidenceNote(d.evidence, d.company !== null)
          const addressed = addressedByLabel(d.addressedBy)
          const companyHref = d.company ? `/companies/${encodeURIComponent(d.company.domain)}` : null
          const shownLines = d.evidence && !d.evidence.stale ? d.evidence.lines.slice(0, EVIDENCE_LINES_SHOWN) : []
          const moreLines = d.evidence && !d.evidence.stale ? d.evidence.lines.length - shownLines.length : 0
          const chosenCampaign = forChannel.find((c) => c.id === chosen.campaignId)
          const chosenPerson = d.candidates.find((c) => c.id === chosen.contactId)
          return (
            <div
              key={d.id}
              ref={(el) => {
                if (el) cards.current.set(d.id, el)
                else cards.current.delete(d.id)
              }}
              data-draft-card={d.id}
              tabIndex={0}
              role="group"
              aria-label={`Draft: ${d.subject ?? '(no subject)'}`}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setFocused(d.id)
              }}
              onBlur={(e) => {
                if (e.target !== e.currentTarget) return
                setFocused((f) => (f === d.id ? null : f))
                // Focus leaving the card disarms it: Enter elsewhere must never approve this one.
                setArmed((a) => (a === d.id ? null : a))
              }}
              className={`approval ${done ? `approval-${done.outcome}` : ''}`}
              style={{ outline: focused === d.id ? '2px solid var(--accent)' : 'none', outlineOffset: 2 }}
            >
              <div className="approval-head">
                <strong>{d.subject ?? '(no subject)'}</strong>
                <span className="pill">{d.channel}</span>
                {d.company && companyHref ? (
                  <a href={companyHref} className="muted" style={{ fontSize: 12.5 }}>
                    about {d.company.name ?? d.company.domain}
                  </a>
                ) : null}
                <span className="muted" style={{ fontSize: 12 }}>
                  drafted <When iso={d.createdAt} />
                </span>
              </div>

              <pre className="mono approval-payload">{d.body ?? ''}</pre>

              {/*
                The evidence BEFORE the decision, so the words are read against
                what was observed. Only quotable lines — observed, a gap, scored,
                from the latest successful scan, fresh — the same filter the draft
                generator reads. A stale scan lists nothing: nothing stale may be
                quoted, and the warning says so instead.
              */}
              {note ? (
                <div className={`note${note.tone === 'warn' ? ' note-warn' : ''}`} style={{ margin: '0 0 10px', fontSize: 12.5 }}>
                  {note.tone === 'warn' ? <strong>{note.text}</strong> : note.text}
                  {companyHref && note.tone === 'warn' ? (
                    <>
                      {' '}
                      <a href={companyHref}>Open the company page</a>.
                    </>
                  ) : null}
                </div>
              ) : null}
              {d.evidence && shownLines.length ? (
                <div style={{ margin: '0 0 10px', fontSize: 12.5 }}>
                  <span className="muted">{evidenceHeading(d.evidence)}</span>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {shownLines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                  {moreLines > 0 && companyHref ? (
                    <span className="hint">
                      …and {moreLines} more on <a href={companyHref}>the company page</a>.
                    </span>
                  ) : null}
                </div>
              ) : null}

              {done ? (
                <p className="muted">{done.message}</p>
              ) : !canDecide ? (
                <p className="muted">Waiting for someone who can approve this.</p>
              ) : (
                <>
                  {addressed ? (
                    <p className="hint" style={{ margin: '0 0 2px' }}>
                      {addressed}
                    </p>
                  ) : null}
                  <p className="hint" style={{ margin: 0 }}>
                    {checkedUnderLabel(d.checkedUnder, d.channel)}
                  </p>
                  <div className="draft-choices">
                    <label>
                      To
                      <select
                        value={chosen.contactId}
                        onChange={(e) => pick(d.id, { contactId: e.target.value })}
                        disabled={d.candidates.length === 0}
                      >
                        <option value="">
                          {d.candidates.length === 0 ? 'No contacts at this company yet' : 'Choose a person'}
                        </option>
                        {d.candidates.map((c) => (
                          <option
                            key={c.id}
                            value={c.id}
                            // Nobody may approve past these, so they are not offered — except
                            // the person the row came addressed to, who must stay visible.
                            disabled={approveBlock(c.decision) !== null && c.id !== d.contactId}
                          >
                            {c.label} — {candidateLine(c.decision)}
                          </option>
                        ))}
                      </select>
                      {chosenPerson ? (
                        <span className="hint">
                          {candidateLine(decision)}.
                          {decision?.reason && decision.code !== 'unchecked' ? <> The rule: {decision.reason}</> : null}
                        </span>
                      ) : null}
                      {d.candidates.length === 0 && companyHref ? (
                        <span className="hint">
                          Add a contact on <a href={companyHref}>the company page</a> first — with their timezone, or
                          nothing can be sent to them.
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
                            {c.status !== 'active' ? ` (${c.status})` : ''}
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
                        {chosenCampaign && d.checkedUnder && chosenCampaign.id !== d.checkedUnder.id ? (
                          <> {OTHER_CAMPAIGN_NOTE}</>
                        ) : null}
                      </span>
                    </label>

                    <label>
                      Note <span className="muted">(optional; kept with the decision)</span>
                      <input value={chosen.note} onChange={(e) => pick(d.id, { note: e.target.value })} maxLength={500} />
                    </label>
                  </div>

                  {errors[d.id] ? <div className="err-line">{errors[d.id]}</div> : null}
                  {explained[d.id] ? <div className="err-line">{explained[d.id]}</div> : null}
                  {armed === d.id ? (
                    <div className="note" style={{ margin: '6px 0 8px', fontSize: 12.5 }}>
                      <strong>Press Enter to approve</strong> — to {chosenPerson?.label ?? 'the chosen person'} under{' '}
                      {chosenCampaign?.name ?? 'the chosen campaign'}. Any other key cancels.
                    </div>
                  ) : null}

                  <div className="approval-actions">
                    <button
                      type="button"
                      disabled={busy === d.id || !chosen.contactId || !chosen.campaignId || block !== null}
                      onClick={() => void decide(d, 'approved')}
                    >
                      Approve
                    </button>
                    <button type="button" className="deny" disabled={busy === d.id} onClick={() => void decide(d, 'denied')}>
                      Deny
                    </button>
                    {block ? (
                      <span className="err-line" style={{ marginTop: 0 }}>
                        {block}
                      </span>
                    ) : (
                      <span className="muted">{approveFootnote(noSenderNote)}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
