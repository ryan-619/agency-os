'use client'

import { useState, type DragEvent } from 'react'
import { When } from '@/components/when'

/**
 * The pipeline board (PROMPT.md §8.6).
 *
 * One column per stage, one card per deal. A card is moved by dragging it
 * to a column, or — for a keyboard, a touch screen, or a test — by the
 * "Move to" control on the card, which does exactly the same PATCH. A drop
 * on `lost` asks for the reason first, because the route refuses without
 * one and a prompt after a refusal is a worse experience than one before.
 *
 * The move is optimistic: the card lands, the request goes, and a refusal
 * puts the card back with the sentence the route returned. Nothing on this
 * board is invented — the stage vocabulary is the database's, and the
 * card shows what the row says.
 *
 * A card nobody has changed for longer than its stage allows is marked
 * `.rotten` and says "untouched for N days", and its column head counts
 * them. The rule and the thresholds are core's (`rottingState`,
 * `STAGE_ROT_DAYS`) and are applied on the SERVER, which hands each card its
 * verdict — "the rules do not live on the board". The number is counted
 * from the last change to the row, not from when the deal entered its stage
 * (there is no such column), so it never says "in stage for". Any change
 * made here — a move, a next action, an owner, a due date — touches the row,
 * so the card's count restarts when one lands.
 */

export const STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'] as const
export type Stage = (typeof STAGES)[number]

const LABEL: Record<Stage, string> = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', proposal: 'Proposal', won: 'Won', lost: 'Lost',
}

export interface DealCard {
  readonly id: string
  readonly stage: Stage
  readonly companyId: string
  readonly companyDomain: string
  readonly companyName: string | null
  readonly nextAction: string | null
  readonly valueCents: number | null
  readonly currency: string
  readonly lostReason: string | null
  readonly updatedAt: string
  readonly closedAt: string | null
  /** When the next action is due: the end of the chosen day, as an instant. */
  readonly nextActionAt: string | null
  /** Decided on the server by core's `dealIsOverdue`, so both renders agree. */
  readonly overdue: boolean
  /**
   * Days since the row last changed, and whether that is past the stage's
   * threshold — core's `rottingState`, on the server. Null for a closed stage.
   */
  readonly untouched: { readonly days: number; readonly rotten: boolean; readonly threshold: number } | null
  /** Core's wording for a rotten card ("untouched for 12 days"); null otherwise. */
  readonly rottenLabel: string | null
  readonly ownerUserId: string | null
  /** Resolved for display — null when nobody has taken it. */
  readonly ownerEmail: string | null
  readonly ownerName: string | null
}

/** Somebody who can own a deal: this org's team, for the assign control. */
export interface TeamMember {
  readonly id: string
  readonly email: string
  readonly name: string | null
}

/**
 * A date input's `YYYY-MM-DD` as the END of that day where the viewer is.
 * A due date names a day, so it is overdue once the day is over — not at
 * its first minute, which would make everything due today overdue by
 * breakfast. Runs only in an event handler, so the viewer's zone is never
 * part of a server render.
 */
function endOfLocalDay(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const next = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)
  const end = new Date(next.getTime() - 1)
  return Number.isFinite(end.getTime()) ? end.toISOString() : null
}

/** The bit before the @, which is what a person recognises on a small card. */
function shortName(member: { name: string | null; email: string }): string {
  return member.name?.trim() || (member.email.split('@')[0] ?? member.email)
}

export function PipelineBoard({
  deals: initial,
  canWrite,
  team = [],
  rotDays = {},
}: {
  deals: readonly DealCard[]
  canWrite: boolean
  team?: readonly TeamMember[]
  /** Core's `STAGE_ROT_DAYS`, passed down as data so a restarted count knows its stage's threshold. */
  rotDays?: Readonly<Record<string, number | null>>
}) {
  const [deals, setDeals] = useState<readonly DealCard[]>(initial)
  const [over, setOver] = useState<Stage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The card whose due-date input is open (one at a time), and what is typed in it. */
  const [dating, setDating] = useState<string | null>(null)
  const [dueDraft, setDueDraft] = useState<string>('')

  /**
   * A write landed, so the row's `updated_at` is now: the count restarts at
   * zero, which is inside every threshold. Not a rule re-derived here — a
   * card changed this second has not gone untouched for any length of time.
   */
  const touched = (d: DealCard, stage: Stage = d.stage): DealCard => {
    const threshold = rotDays[stage]
    return {
      ...d,
      untouched: threshold === null || threshold === undefined ? null : { days: 0, rotten: false, threshold },
      rottenLabel: null,
    }
  }
  /**
   * Filter by owner. '' is everyone and 'none' is the unassigned pile, which
   * is the one worth having: a deal nobody has taken is the failure mode
   * this whole feature exists to make visible.
   */
  const [ownerFilter, setOwnerFilter] = useState<string>('')

  const assign = async (deal: DealCard, ownerUserId: string | null): Promise<void> => {
    setBusy(deal.id)
    setError(null)
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerUserId }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; ownerUserId?: string | null }
      if (!res.ok) {
        setError(body.error ?? 'That did not save.')
        return
      }
      const member = team.find((m) => m.id === body.ownerUserId)
      setDeals((ds) =>
        ds.map((d) =>
          d.id === deal.id
            ? {
                ...touched(d),
                ownerUserId: body.ownerUserId ?? null,
                ownerEmail: member?.email ?? null,
                ownerName: member?.name ?? null,
              }
            : d,
        ),
      )
    } catch {
      setError('The request did not complete.')
    } finally {
      setBusy(null)
    }
  }

  const move = async (deal: DealCard, to: Stage): Promise<void> => {
    if (!canWrite || to === deal.stage) return
    let lostReason: string | null = null
    if (to === 'lost') {
      const answer = window.prompt(`Why was ${deal.companyName ?? deal.companyDomain} lost? (recorded — it is the only thing anyone learns from a lost deal)`)
      if (answer === null) return
      if (!answer.trim()) {
        setError('A lost deal needs a reason.')
        return
      }
      lostReason = answer.trim()
    }
    setError(null)
    setBusy(deal.id)
    const before = deals
    setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, stage: to, lostReason } : d)))
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: to, ...(lostReason ? { lostReason } : {}) }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; closedAt?: string | null }
      if (!res.ok) {
        setDeals(before)
        setError(body.error ?? 'That move was refused.')
        return
      }
      setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...touched(d, to), closedAt: body.closedAt ?? null } : d)))
    } catch {
      setDeals(before)
      setError('The request did not complete. The card is back where it was.')
    } finally {
      setBusy(null)
    }
  }

  const editNext = async (deal: DealCard): Promise<void> => {
    const answer = window.prompt(`Next action for ${deal.companyName ?? deal.companyDomain}:`, deal.nextAction ?? '')
    if (answer === null) return
    setBusy(deal.id)
    setError(null)
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nextAction: answer.trim() || null }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; nextAction?: string | null }
      if (!res.ok) {
        setError(body.error ?? 'That did not save.')
        return
      }
      setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...touched(d), nextAction: body.nextAction ?? null } : d)))
    } catch {
      setError('The request did not complete.')
    } finally {
      setBusy(null)
    }
  }

  /** `PATCH /api/deals/[id]/next-action` — its own route and its own audit row. */
  const setDue = async (deal: DealCard, nextActionAt: string | null): Promise<void> => {
    setBusy(deal.id)
    setError(null)
    try {
      const res = await fetch(`/api/deals/${deal.id}/next-action`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nextActionAt }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string; nextActionAt?: string | null; overdue?: boolean
      }
      if (!res.ok) {
        setError(body.error ?? 'That did not save.')
        return
      }
      setDeals((ds) =>
        ds.map((d) =>
          d.id === deal.id
            ? { ...touched(d), nextActionAt: body.nextActionAt ?? null, overdue: body.overdue === true }
            : d,
        ),
      )
      setDating(null)
    } catch {
      setError('The request did not complete.')
    } finally {
      setBusy(null)
    }
  }

  const onDragStart = (e: DragEvent<HTMLElement>, deal: DealCard): void => {
    e.dataTransfer.setData('text/plain', deal.id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDrop = (e: DragEvent<HTMLElement>, to: Stage): void => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/plain')
    const deal = deals.find((d) => d.id === id)
    if (deal) void move(deal, to)
  }

  return (
    <>
      {error ? <div className="err-line" role="alert" style={{ marginBottom: 10 }}>{error}</div> : null}
      {team.length > 0 ? (
        <div className="board-filter" style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="owner-filter" className="muted">Owner</label>
          <select
            id="owner-filter"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="">everyone</option>
            {/* The pile worth having: a deal nobody has taken is the failure
                this feature exists to surface. */}
            <option value="none">unassigned ({deals.filter((d) => d.ownerUserId === null).length})</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {shortName(m)} ({deals.filter((d) => d.ownerUserId === m.id).length})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="board" data-testid="board">
        {STAGES.map((stage) => {
          const cards = deals.filter(
            (d) =>
              d.stage === stage &&
              (ownerFilter === ''
                ? true
                : ownerFilter === 'none'
                  ? d.ownerUserId === null
                  : d.ownerUserId === ownerFilter),
          )
          const rotten = cards.filter((d) => d.untouched?.rotten).length
          const threshold = rotDays[stage]
          return (
            <section
              key={stage}
              className={`col${over === stage ? ' over' : ''}${stage === 'won' ? ' col-won' : stage === 'lost' ? ' col-lost' : ''}`}
              data-stage={stage}
              onDragOver={(e) => {
                if (!canWrite) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (over !== stage) setOver(stage)
              }}
              onDragLeave={() => setOver((o) => (o === stage ? null : o))}
              onDrop={(e) => onDrop(e, stage)}
            >
              <header className="col-head">
                <span>
                  {LABEL[stage]}
                  {rotten > 0 ? (
                    <span
                      style={{ color: 'var(--warn)', textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}
                      title={threshold != null ? `Untouched for ${threshold} days or more` : undefined}
                    >
                      {rotten} untouched
                    </span>
                  ) : null}
                </span>
                <em>{cards.length}</em>
              </header>
              {cards.map((deal) => (
                <article
                  key={deal.id}
                  className={`kcard${deal.untouched?.rotten ? ' rotten' : ''}${busy === deal.id ? ' busy' : ''}`}
                  draggable={canWrite}
                  onDragStart={(e) => onDragStart(e, deal)}
                  data-deal={deal.id}
                >
                  <a href={`/companies/${encodeURIComponent(deal.companyDomain)}`} className="kcard-name">
                    {deal.companyName ?? deal.companyDomain}
                  </a>
                  {deal.companyName ? <div className="mono muted kcard-domain">{deal.companyDomain}</div> : null}
                  {deal.nextAction ? (
                    <div className="kcard-next">→ {deal.nextAction}</div>
                  ) : stage !== 'won' && stage !== 'lost' ? (
                    <div className="kcard-next muted">no next action</div>
                  ) : null}
                  {deal.lostReason ? <div className="kcard-next muted">lost: {deal.lostReason}</div> : null}
                  {deal.untouched?.rotten && deal.rottenLabel ? (
                    <div
                      className="kcard-next"
                      style={{ color: 'var(--warn)' }}
                      title={`Past this stage’s ${deal.untouched.threshold} days. Counted from the last change to the card — a move, a next action, an owner, a due date — not from when it entered the stage.`}
                    >
                      {deal.rottenLabel}
                    </div>
                  ) : null}
                  {deal.nextActionAt && !deal.closedAt ? (
                    <div className={`kcard-due${deal.overdue ? ' overdue' : ''}`}>
                      {deal.overdue ? 'overdue — was due ' : 'due '}
                      <When iso={deal.nextActionAt} mode="date" />
                    </div>
                  ) : null}
                  <div className="kcard-foot">
                    {deal.ownerEmail ? (
                      <span className="muted" title={deal.ownerEmail}>
                        {shortName({ name: deal.ownerName, email: deal.ownerEmail })}
                      </span>
                    ) : (
                      <span className="muted">unassigned</span>
                    )}
                    {deal.valueCents != null ? (
                      <span className="mono">{deal.currency} {(deal.valueCents / 100).toLocaleString('en-US')}</span>
                    ) : null}
                    <span className="muted"><When iso={deal.updatedAt} mode="date" /></span>
                  </div>
                  {canWrite ? (
                    <div className="kcard-actions">
                      <select
                        aria-label={`Move ${deal.companyName ?? deal.companyDomain} to`}
                        value={deal.stage}
                        disabled={busy === deal.id}
                        onChange={(e) => void move(deal, e.target.value as Stage)}
                      >
                        {STAGES.map((s) => (
                          <option key={s} value={s}>{s === deal.stage ? `${LABEL[s]} (here)` : `Move to ${LABEL[s]}`}</option>
                        ))}
                      </select>
                      <button type="button" className="linkish" disabled={busy === deal.id} onClick={() => void editNext(deal)}>
                        next action
                      </button>
                      {!deal.closedAt ? (
                        dating === deal.id ? (
                          // A form, not an onChange: typing a year into a date
                          // input passes through 0002, 0020 and 0202 on the way
                          // to 2026, and each of those is a complete date.
                          <form
                            onSubmit={(e) => {
                              e.preventDefault()
                              const at = endOfLocalDay(dueDraft)
                              if (at) void setDue(deal, at)
                              else setError('Pick a date first.')
                            }}
                            style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                          >
                            <input
                              type="date"
                              aria-label={`Due date for ${deal.companyName ?? deal.companyDomain}`}
                              value={dueDraft}
                              disabled={busy === deal.id}
                              autoFocus
                              onChange={(e) => setDueDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setDating(null)
                              }}
                              style={{
                                flex: 1, minWidth: 0, fontSize: 11.5, padding: '3px 5px', border: '1px solid var(--line)',
                                borderRadius: 5, background: 'var(--bg)', color: 'var(--ink)',
                              }}
                            />
                            <button type="submit" className="linkish" disabled={busy === deal.id} style={{ width: 'auto' }}>
                              save
                            </button>
                            <button type="button" className="linkish" onClick={() => setDating(null)} style={{ width: 'auto' }}>
                              cancel
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="linkish"
                            disabled={busy === deal.id}
                            onClick={() => {
                              setDueDraft('')
                              setDating(deal.id)
                            }}
                          >
                            {deal.nextActionAt ? 'change due date' : 'set due date'}
                          </button>
                        )
                      ) : null}
                      {deal.nextActionAt && !deal.closedAt ? (
                        <button type="button" className="linkish" disabled={busy === deal.id} onClick={() => void setDue(deal, null)}>
                          clear due date
                        </button>
                      ) : null}
                      {team.length > 0 ? (
                        <select
                          aria-label={`Owner of ${deal.companyName ?? deal.companyDomain}`}
                          value={deal.ownerUserId ?? ''}
                          disabled={busy === deal.id}
                          onChange={(e) => void assign(deal, e.target.value || null)}
                        >
                          <option value="">unassigned</option>
                          {team.map((m) => (
                            <option key={m.id} value={m.id}>{shortName(m)}</option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {cards.length === 0 ? <div className="col-empty muted">—</div> : null}
            </section>
          )
        })}
      </div>
    </>
  )
}
