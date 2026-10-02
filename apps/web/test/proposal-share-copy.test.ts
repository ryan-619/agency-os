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
    expect(shareCreateBlocked({ status: 'accepted', evidenceStale: true, evidenceSuperseded: false })).toMatch(/^This proposal is accepted/)
    expect(shareCreateBlocked({ status: 'accepted', evidenceStale: false, evidenceSuperseded: true })).toMatch(/^This proposal is accepted/)
  })
})

/**
 * The same for a DRAFT whose evidence is stale. `shareMint` refuses a sent
 * proposal over a stale scan, and the only thing that freshens a company's
 * evidence is a new scan — which supersedes this proposal's — so a stale
 * draft can never be linked, sent or not. "Mark it sent first" sent a person
 * to mark an out-of-date proposal sent, to be refused for its evidence next.
 * Round 4 (integrator).
 */
describe('a draft whose evidence is stale', () => {
  it('says the evidence first, and that marking it sent would not make it shareable', () => {
    const said = shareCreateBlocked({ status: 'draft', evidenceStale: true, evidenceSuperseded: false })
    expect(said).toBe(
      'Not while the evidence under this proposal is stale: re-verify before it appears in anything outbound. This ' +
        'draft could not be linked even once marked sent: re-scan the company, generate a fresh proposal, mark that ' +
        'one sent, and link it.',
    )
    expect(said).not.toContain('Mark the proposal as sent first')
  })

  it('puts the stale reason before the superseded one, as the route does for a sent proposal', () => {
    expect(shareCreateBlocked({ status: 'draft', evidenceStale: true, evidenceSuperseded: true })).toMatch(/^Not while the evidence/)
    expect(shareCreateBlocked({ status: 'draft', evidenceStale: true })).toMatch(/^Not while the evidence/)
  })
})
