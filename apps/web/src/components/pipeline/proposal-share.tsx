import { shareList, type AgencyDb, type ShareSummary } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { SHARE_EXPLAINER, SHARE_VIEWS_NOTE, shareCreateBlocked, shareState } from './proposal-share-copy'
import { ProposalShareControls, type ShareRowView } from './proposal-share-controls'
import type { ProposalSlotProps } from './proposal-slot'

/**
 * A link a buyer can read the proposal at, and accept it from, with no
 * account (PROMPT.md §8.6).
 *
 * The link is a copy of the stored document behind an unguessable, revocable
 * address — not the send. So it is offered only for a proposal a person has
 * already marked `sent` (§2.4: that explicit decision is what makes it
 * outbound, and a link must not be a second, implicit one), and not while the
 * evidence under it is stale (§2.2) — the same refusal the route makes, said
 * before the button is pressed rather than after.
 *
 * Every link the proposal has had is listed, revoked and expired ones too,
 * with its views and any acceptance. The URL itself is shown once, when it
 * is created, and never again: only its hash is kept.
 */
export async function ProposalShareSlot({ orgId, proposalId, status, evidenceStale, canWrite }: ProposalSlotProps): Promise<React.ReactNode> {
  let shares: ShareSummary[]
  try {
    shares = await shareList(getDb() as unknown as AgencyDb, orgId, proposalId)
  } catch (err) {
    log.warn('proposal share links could not be read', { proposalId, error: err instanceof Error ? err.name : 'UnknownError' })
    return <p className="err-line" style={{ marginTop: 10 }}>The buyer links for this proposal could not be read.</p>
  }
  // Somebody who cannot create one, looking at a proposal that never had
  // one, has nothing to read here.
  if (!canWrite && shares.length === 0) return null

  // The state is decided here, on the server's clock, so the first render in
  // the browser agrees with it.
  const now = new Date()
  const rows: ShareRowView[] = shares.map((s) => {
    const iso = {
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
      acceptedAt: s.acceptedAt ? s.acceptedAt.toISOString() : null,
    }
    return {
      id: s.id,
      ...iso,
      state: shareState(iso, now),
      viewCount: s.viewCount,
      firstViewedAt: s.firstViewedAt ? s.firstViewedAt.toISOString() : null,
      lastViewedAt: s.lastViewedAt ? s.lastViewedAt.toISOString() : null,
      acceptedByName: s.acceptedByName,
    }
  })

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Buyer link</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{SHARE_EXPLAINER}</p>
      <ProposalShareControls
        proposalId={proposalId}
        shares={rows}
        canWrite={canWrite}
        blocked={shareCreateBlocked({ status, evidenceStale })}
      />
      {rows.length > 0 ? <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>{SHARE_VIEWS_NOTE}</p> : null}
    </section>
  )
}
