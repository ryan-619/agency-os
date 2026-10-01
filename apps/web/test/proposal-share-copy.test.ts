/**
 * Why the Create-link button is not offered, for a DRAFT whose evidence a
 * newer scan has superseded.
 *
 * `shareCreateBlocked` said "Mark the proposal as sent first" for every
 * draft before it looked at the evidence. For a superseded draft that was
 * advice to do something that could not help: `shareMint` refuses a sent
 * proposal whose scan is superseded, and nothing un-supersedes a scan, so a
 * person who followed it marked an out-of-date proposal sent and was then
 * told to regenerate it. The superseded sentence comes first for a draft.
 * The other orders are pinned in `proposal-buyer-view.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { shareCreateBlocked } from '../src/components/pipeline/proposal-share-copy'

describe('a draft whose evidence a newer scan superseded', () => {
  it('says regenerate first, and that marking it sent would not make it shareable', () => {
    const said = shareCreateBlocked({ status: 'draft', evidenceStale: false, evidenceSuperseded: true })
    expect(said).toBe(
      'A newer scan exists — regenerate the proposal. This draft quotes an older scan, so it could not be linked ' +
        'even once marked sent: generate a fresh proposal from the latest scan, mark that one sent, and link it.',
    )
    expect(said).not.toContain('Mark the proposal as sent first')
  })

  it('still says mark it sent first for a draft whose evidence is current', () => {
    expect(shareCreateBlocked({ status: 'draft', evidenceStale: false, evidenceSuperseded: false })).toBe(
      'Mark the proposal as sent first. A link is a copy of what you sent, not the send.',
    )
    expect(shareCreateBlocked({ status: 'draft', evidenceStale: false })).toMatch(/sent first/)
  })

  it('leaves a sent proposal’s order as the route’s: stale, then superseded', () => {
    expect(shareCreateBlocked({ status: 'sent', evidenceStale: true, evidenceSuperseded: true })).toMatch(/^Not while the evidence/)
    expect(shareCreateBlocked({ status: 'sent', evidenceStale: false, evidenceSuperseded: true })).toBe(
      'A newer scan exists — regenerate the proposal. Only the latest scan is quoted in anything outbound; generate a fresh proposal from it, mark it sent, and link that one.',
    )
  })

  it('says a decided proposal is decided, whatever its evidence', () => {
    expect(shareCreateBlocked({ status: 'accepted', evidenceStale: false, evidenceSuperseded: true })).toMatch(/^This proposal is accepted/)
  })
})
