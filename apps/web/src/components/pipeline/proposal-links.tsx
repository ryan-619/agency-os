import { PROPOSAL_EXPORT_NOTE, STALE_DRAFT_EXPORT_NOTE } from '@/lib/proposal-markdown'
import type { ProposalSlotProps } from './proposal-slot'

/**
 * The print view and the Markdown download, beside the status control
 * (PROMPT.md §8.6).
 *
 * Both hand over the STORED document — what was generated, not what today's
 * scan would say — and neither sends anything (§8.4). The note under them
 * says so, because a Download button beside "Mark as sent" is easy to read as
 * the thing that sends.
 *
 * A draft whose evidence has aged out gets no download link: the route would
 * refuse it (§2.2, stale findings are re-verified before they appear in
 * anything outbound), and a button should say why before it is pressed
 * rather than after. Print stays, because the print view carries the stale
 * banner onto the paper.
 */
export async function ProposalLinksSlot({ proposalId, status, evidenceStale }: ProposalSlotProps): Promise<React.ReactNode> {
  const id = encodeURIComponent(proposalId)
  const refused = status === 'draft' && evidenceStale
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row-actions" style={{ alignItems: 'baseline', gap: 14, fontSize: 13.5 }}>
        <a href={`/proposals/${id}/print`} target="_blank" rel="noopener">Print</a>
        {refused ? (
          <span className="muted" title={STALE_DRAFT_EXPORT_NOTE} aria-disabled="true">Download as Markdown</span>
        ) : (
          <a href={`/api/proposals/${id}/markdown`}>Download as Markdown</a>
        )}
      </div>
      {refused ? <p className="err-line" style={{ margin: '6px 0 0' }}>{STALE_DRAFT_EXPORT_NOTE}</p> : null}
      <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{PROPOSAL_EXPORT_NOTE}</p>
    </div>
  )
}
