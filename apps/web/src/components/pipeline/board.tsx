'use client'

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { Flip, MOTION_OK, gsap } from '@/components/motion/gsap'
import { toast } from '@/components/toast/toast'
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
 * Cards glide (2026-10-09): every card's place is recorded just before the
 * board changes — a move, a move put back after a refusal, the owner
 * filter — and each card then slides from where it was to where it is
 * (GSAP Flip), so a card dropped on another column travels there and the
 * cards it leaves and joins close up and make room. Once the server has the
 * move, the card rings where it landed — a win with a burst of colour — and
 * a pop-up says what happened. None of it moves for a visitor who asked for
 * less motion; the board works the same either way.
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
  /** Why the card needs a look (2026-10-09): `dealHealth`'s level and reasons; null when it is fine or closed. */
  readonly health?: { readonly level: 'ok' | 'watch' | 'act'; readonly reasons: readonly string[] } | null
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

/** A burst of colour from a card that was just won. Decoration only, and only where motion is welcome. */
function celebrate(card: HTMLElement): void {
  if (!window.matchMedia(MOTION_OK).matches) return
  const r = card.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + Math.min(r.height / 2, 40)
  const colours = ['#22c55e', '#2b59e8', '#7c3aed', '#f59e0b', '#ec4899', '#14b8a6']
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement('span')
    bit.className = 'confetti'
    bit.setAttribute('aria-hidden', 'true')
    bit.style.left = `${x}px`
    bit.style.top = `${y}px`
    bit.style.background = colours[i % colours.length] ?? '#22c55e'
    document.body.appendChild(bit)
    const angle = (i / 28) * Math.PI * 2 + gsap.utils.random(-0.2, 0.2)
    const reach = gsap.utils.random(60, 150)
    gsap
      .timeline({ onComplete: () => bit.remove() })
      .to(bit, { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach - 50, rotation: gsap.utils.random(-300, 300), duration: 0.75, ease: 'power3.out' })
      .to(bit, { y: '+=110', opacity: 0, duration: 0.85, ease: 'power1.in' }, '-=0.2')
  }
}

/** The card rings where it landed, in the accent — or in green for a win. */
function ring(card: HTMLElement, won: boolean): void {
  if (!window.matchMedia(MOTION_OK).matches) return
  const token = getComputedStyle(document.documentElement).getPropertyValue(won ? '--ok' : '--accent').trim()
  const [r, g, b] = gsap.utils.splitColor(token || '#2b59e8')
  gsap.fromTo(
    card,
    // The card's own box-shadow transition is held off while GSAP draws the ring.
    { boxShadow: `0 0 0 0px rgba(${r}, ${g}, ${b}, 0.6)`, transition: 'none' },
    { boxShadow: `0 0 0 12px rgba(${r}, ${g}, ${b}, 0)`, duration: won ? 1.3 : 1.05, ease: 'power2.out', clearProps: 'boxShadow,transition' },
  )
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
  /** The card being dragged, faded in its old place while its ghost travels. */
  const [dragging, setDragging] = useState<string | null>(null)
  /** A move the server has just accepted: the card rings where it landed. */
  const [landed, setLanded] = useState<{ readonly id: string; readonly won: boolean; readonly at: number } | null>(null)
  const board = useRef<HTMLDivElement>(null)
  const flipFrom = useRef<Flip.FlipState | null>(null)

  /** Where every card is now, so the next render can glide each one from here to where it lands. */
  const capture = (): void => {
    const el = board.current
    if (el && window.matchMedia(MOTION_OK).matches) flipFrom.current = Flip.getState(el.querySelectorAll('.kcard'))
  }
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

  useLayoutEffect(() => {
    const state = flipFrom.current
    const el = board.current
    flipFrom.current = null
    if (!state || !el) return
    Flip.from(state, {
      targets: el.querySelectorAll('.kcard'),
      duration: 0.62,
      ease: 'power3.inOut',
      prune: true,
      toggleClass: 'flipping',
      onEnter: (entering) => gsap.fromTo(entering, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'power2.out' }),
    })
  }, [deals, ownerFilter])

  useEffect(() => {
    if (!landed) return
    const card = board.current?.querySelector<HTMLElement>(`[data-deal="${CSS.escape(landed.id)}"]`)
    if (!card) return
    ring(card, landed.won)
    if (landed.won) celebrate(card)
  }, [landed])

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
      const name = deal.companyName ?? deal.companyDomain
      toast.success(member ? `${name} is ${shortName(member)}’s now.` : `${name} is unassigned now.`)
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
    capture()
    setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, stage: to, lostReason } : d)))
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: to, ...(lostReason ? { lostReason } : {}) }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; closedAt?: string | null }
      if (!res.ok) {
        capture()
        setDeals(before)
        setError(body.error ?? 'That move was refused.')
        return
      }
      setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...touched(d, to), closedAt: body.closedAt ?? null } : d)))
      setLanded({ id: deal.id, won: to === 'won', at: Date.now() })
      const name = deal.companyName ?? deal.companyDomain
      toast.success(
        to === 'won'
          ? `${name} won. The deal is closed.`
          : to === 'lost'
            ? `${name} moved to Lost, with the reason recorded.`
            : `${name} moved to ${LABEL[to]}.`,
      )
    } catch {
      capture()
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
      toast.success(body.nextAction ? 'Next action saved.' : 'Next action cleared.')
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
      toast.success(body.nextActionAt ? 'Due date set.' : 'Due date cleared.')
    } catch {
      setError('The request did not complete.')
    } finally {
      setBusy(null)
    }
  }

  const onDragStart = (e: DragEvent<HTMLElement>, deal: DealCard): void => {
    e.dataTransfer.setData('text/plain', deal.id)
    e.dataTransfer.effectAllowed = 'move'
    // A frame later, so the ghost the browser drags is the card as it was, not faded.
    requestAnimationFrame(() => setDragging(deal.id))
  }
  const onDrop = (e: DragEvent<HTMLElement>, to: Stage): void => {
    e.preventDefault()
    setOver(null)
    setDragging(null)
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
            onChange={(e) => {
              capture()
              setOwnerFilter(e.target.value)
            }}
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
      <div className="board" data-testid="board" ref={board}>
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
                  className={`kcard${deal.untouched?.rotten ? ' rotten' : ''}${busy === deal.id ? ' busy' : ''}${dragging === deal.id ? ' dragging' : ''}`}
                  draggable={canWrite}
                  onDragStart={(e) => onDragStart(e, deal)}
                  onDragEnd={() => setDragging(null)}
                  data-deal={deal.id}
                  data-flip-id={deal.id}
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
                  {deal.health ? (
                    <div className={`kcard-health kcard-health-${deal.health.level}`} title={deal.health.reasons.join(' · ')}>
                      {deal.health.reasons[0]}
                      {deal.health.reasons.length > 1 ? <span className="muted"> +{deal.health.reasons.length - 1}</span> : null}
                    </div>
                  ) : null}
                  {deal.untouched?.rotten && deal.rottenLabel && !deal.health ? (
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
