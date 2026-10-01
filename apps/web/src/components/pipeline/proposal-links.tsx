import { PROPOSAL_EXPORT_NOTE, STALE_DRAFT_EXPORT_NOTE, SUPERSEDED_DRAFT_EXPORT_NOTE } from '@/lib/proposal-markdown'
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
 * rather than after. So does a draft whose scan a newer successful scan has
 * superseded: only the latest scan is quoted (round 3, finding [6]). Print
 * stays, because the print view carries either banner onto the paper.
 */
export async function ProposalLinksSlot({
  proposalId,
  status,
  evidenceStale,
  evidenceSuperseded,
}: ProposalSlotProps & {
  /** `shareEvidenceSuperseded`, read once by the page, which warns about it too. */
  readonly evidenceSuperseded: boolean
}): Promise<React.ReactNode> {
  const id = encodeURIComponent(proposalId)
  const refused = status === 'draft' && (evidenceStale || evidenceSuperseded)
  const why = evidenceStale ? STALE_DRAFT_EXPORT_NOTE : SUPERSEDED_DRAFT_EXPORT_NOTE
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row-actions" style={{ alignItems: 'baseline', gap: 14, fontSize: 13.5 }}>
        <a href={`/proposals/${id}/print`} target="_blank" rel="noopener">Print</a>
        {refused ? (
          <span className="muted" title={why} aria-disabled="true">Download as Markdown</span>
        ) : (
          <a href={`/api/proposals/${id}/markdown`}>Download as Markdown</a>
        )}
      </div>
      {refused ? <p className="err-line" style={{ margin: '6px 0 0' }}>{why}</p> : null}
      <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{PROPOSAL_EXPORT_NOTE}</p>
    </div>
  )
}
