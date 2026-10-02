/**
 * /audit's notes say what the log holds today.
 *
 * `advanceDeal` writes its own `deal.created` / `deal.advanced` line —
 * subject the deal, actor System — for every automatic move: a send, a
 * reply, a booking, a generated proposal. The notes and the deal-filter hint
 * were written before it did, and told a person filtering to Deals that
 * such lines did not exist, directly above the lines. Review round 3,
 * finding [21]. The page imports `@/auth`, so it is read rather than imported.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('../src/app/audit/page.tsx', import.meta.url)), 'utf8')
/** The prose as a person reads it: tags, entities and line breaks collapsed. */
const prose = src
  .replace(/<[^>]+>/g, '')
  .replace(/\{' '\}/g, ' ')
  .replace(/&apos;/g, "'")
  .replace(/\s+/g, ' ')

describe('/audit on automatic deal moves', () => {
  it('no longer says an automatic move has no deal line of its own', () => {
    expect(prose).not.toContain('A deal moved automatically has no deal line of its own')
    expect(prose).not.toContain('Filtering to Deals shows the moves people made on the board')
  })

  it('no longer tells a person filtering by a deal that its moves are filed elsewhere', () => {
    expect(prose).not.toContain('is recorded under that message, contact or meeting instead')
  })

  it('says an automatic move is its own System line beside what caused it', () => {
    expect(prose).toContain('A deal moved automatically has a line of its own, from System')
    expect(prose).toContain('beside the send.sent, contact.replied, meeting.booked or proposal.generated line that caused it')
  })

  it('names the moves that still have no deal line, as CLAUDE.md lists them', () => {
    expect(prose).toContain('update_deal')
    expect(prose).toContain('a proposal accepted as won')
    expect(prose).toContain('any automatic move made before this release')
  })
})
