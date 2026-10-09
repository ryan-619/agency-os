'use client'

import { useState } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import { When } from '@/components/when'
import { toast } from '../toast/toast'

/**
 * Research about a company, with its sources (0028), as the company page
 * shows it: each claim beside the page it came from, who recorded it and
 * when. Headed as research, never evidence — nothing here was observed by
 * the scanner, and nothing here is quoted to the company. Deleting is the
 * recorder's or an owner's, and anybody's for a claim the agent recorded;
 * hiding the button is a courtesy, the route is the rule.
 */
export interface ResearchItem {
  readonly id: string
  readonly claim: string
  readonly sourceUrl: string
  readonly sourceTitle: string | null
  readonly sourceHost: string
  readonly recordedBy: string | null
  readonly recordedByLabel: string
  readonly createdAt: string
}

export function ResearchPanel({
  items, currentUserId, isOwner, canWrite,
}: {
  items: readonly ResearchItem[]
  currentUserId: string
  isOwner: boolean
  canWrite: boolean
}) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/research/${id}`, { method: 'DELETE' })
      const out = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        setError(typeof out.error === 'string' ? out.error : 'That did not work.')
        return
      }
      setGone((g) => new Set([...g, id]))
      toast.success('Research claim removed.')
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const shown = items.filter((i) => !gone.has(i.id))
  if (shown.length === 0) return <p className="muted" style={{ fontSize: 13 }}>Nothing recorded yet. Ask the assistant to research this company and it records what it finds here, with sources.</p>
  return (
    <div>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <ul className="research">
        {shown.map((r) => (
          <li key={r.id}>
            <div className="research-claim">{r.claim}</div>
            <div className="muted research-meta">
              <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" title={r.sourceUrl}>
                {r.sourceTitle || r.sourceHost} <ExternalLink aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: '-1px' }} />
              </a>
              {' · '}recorded by {r.recordedByLabel} <When iso={r.createdAt} />
              {canWrite && (isOwner || r.recordedBy === null || r.recordedBy === currentUserId) ? (
                <>
                  {' · '}
                  <button type="button" className="linkish" disabled={busy === r.id} onClick={() => void remove(r.id)} aria-label="Remove this claim">
                    <Trash2 aria-hidden="true" style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> remove
                  </button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
