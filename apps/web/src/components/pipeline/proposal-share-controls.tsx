'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { When } from '../when'
import { SHARE_SHOWN_ONCE, shareStateLabel, type ShareState } from './proposal-share-copy'

/** One link, as the slot hands it over: ISO strings, and a state decided on the server. */
export interface ShareRowView {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly acceptedAt: string | null
  readonly acceptedByName: string | null
  readonly state: ShareState
  readonly viewCount: number
  readonly firstViewedAt: string | null
  readonly lastViewedAt: string | null
}

interface Created {
  readonly url: string
  readonly expiresAt: string
  readonly cappedByEvidence: boolean
}

/**
 * Create, copy and revoke a buyer's link; the list of every link so far.
 *
 * The URL arrives once, in the create answer, and lives only in this
 * component's state — the server keeps a hash and cannot show it again. The
 * list is refreshed from the server around it, so the URL stays on screen
 * while the new row appears beneath.
 */
export function ProposalShareControls({
  proposalId, shares, canWrite, blocked,
}: {
  proposalId: string
  shares: readonly ShareRowView[]
  canWrite: boolean
  /** Why Create is not offered, or null when it is. */
  blocked: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)

  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(typeof b.error === 'string' ? b.error : 'That did not work.')
        return null
      }
      return b
    } catch {
      setError('The request did not complete.')
      return null
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    const b = await post({ action: 'create' })
    const share = (b?.share ?? null) as { expiresAt?: unknown; cappedByEvidence?: unknown } | null
    if (!b || typeof b.url !== 'string' || !share || typeof share.expiresAt !== 'string') return
    setCopied(false)
    setCreated({ url: b.url, expiresAt: share.expiresAt, cappedByEvidence: share.cappedByEvidence === true })
    router.refresh()
  }

  const revoke = async (id: string): Promise<void> => {
    if (!window.confirm('Revoke this link? Anyone holding it will see a page that does not exist. This cannot be undone.')) return
    if (await post({ action: 'revoke', shareId: id })) router.refresh()
  }

  const copy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setError('The browser would not copy it. Select the address and copy it by hand.')
    }
  }

  return (
    <div>
      {error ? <div className="err-line" role="alert">{error}</div> : null}

      {canWrite ? (
        blocked ? (
          <p className="err-line" style={{ margin: '6px 0 0' }}>{blocked}</p>
        ) : (
          <div className="row-actions" style={{ marginTop: 6 }}>
            <button type="button" disabled={busy} onClick={() => void create()}>Create a buyer link</button>
          </div>
        )
      ) : null}

      {created ? (
        <div className="note" style={{ marginTop: 10 }}>
          <strong>New link.</strong> {SHARE_SHOWN_ONCE}
          <div className="row-actions" style={{ marginTop: 8, alignItems: 'center' }}>
            <input
              type="text"
              readOnly
              value={created.url}
              aria-label="The buyer link"
              onFocus={(e) => e.currentTarget.select()}
              className="mono"
              style={{
                flex: 1, minWidth: 260, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6,
                background: 'var(--bg)', color: 'var(--ink)', fontSize: 12.5,
              }}
            />
            <button type="button" onClick={() => void copy(created.url)}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
            It stops working on <When iso={created.expiresAt} />
            {created.cappedByEvidence
              ? ' — when the evidence under this proposal goes stale, sooner than the usual thirty days. After that the buyer is told it is being re-verified.'
              : '.'}
          </p>
        </div>
      ) : null}

      {shares.length > 0 ? (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Created</th><th>Stops working</th><th>Views</th><th>Last opened</th><th>State</th><th /></tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.id} className={s.state === 'live' || s.state === 'accepted' ? undefined : 'row-stale'}>
                <td><When iso={s.createdAt} /></td>
                <td><When iso={s.expiresAt} /></td>
                <td className="mono">{s.viewCount}</td>
                <td>{s.lastViewedAt ? <When iso={s.lastViewedAt} /> : <span className="muted">never</span>}</td>
                <td>
                  {s.state === 'accepted' && s.acceptedAt ? (
                    <>
                      <span className="tag on">accepted</span>{' '}
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        by “{s.acceptedByName}” <When iso={s.acceptedAt} />
                      </span>
                    </>
                  ) : s.state === 'live' ? (
                    <span className="tag">live</span>
                  ) : (
                    <span className="tag warn">{shareStateLabel(s.state)}</span>
                  )}
                </td>
                <td>
                  {canWrite && s.revokedAt === null && s.state !== 'expired' ? (
                    <div className="row-actions">
                      <button type="button" className="deny" disabled={busy} onClick={() => void revoke(s.id)}>Revoke</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
