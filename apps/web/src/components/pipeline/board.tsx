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

/** The bit before the @, which is what a person recognises on a small card. */
function shortName(member: { name: string | null; email: string }): string {
  return member.name?.trim() || (member.email.split('@')[0] ?? member.email)
}

export function PipelineBoard({
  deals: initial,
  canWrite,
  team = [],
}: {
  deals: readonly DealCard[]
  canWrite: boolean
  team?: readonly TeamMember[]
}) {
  const [deals, setDeals] = useState<readonly DealCard[]>(initial)
  const [over, setOver] = useState<Stage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
                ...d,
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
      setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, closedAt: body.closedAt ?? null } : d)))
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
      setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, nextAction: body.nextAction ?? null } : d)))
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
                <span>{LABEL[stage]}</span>
                <em>{cards.length}</em>
              </header>
              {cards.map((deal) => (
                <article
                  key={deal.id}
                  className={`kcard${busy === deal.id ? ' busy' : ''}`}
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
