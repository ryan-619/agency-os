/**
 * PATCH /api/proposals/[id] writes only over the status it read.
 *
 * The route reads the proposal, checks the move against that status, then
 * writes. A buyer accepting through their share link can commit in between,
 * and the write used to carry no status predicate, so a teammate's
 * "Declined" overwrote the acceptance while the deal stayed won. The
 * predicate is `setProposalStatus`'s `from` (proved against a real engine in
 * packages/db/test/proposals.test.ts); this pins that the route passes it,
 * and answers a 409 that says what happened rather than a 404. The route
 * imports `@/auth`, so it is read. Review round 3, finding [12].
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('../src/app/api/proposals/[id]/route.ts', import.meta.url)), 'utf8')

describe('PATCH /api/proposals/[id]', () => {
  it('passes the status it read as the expected one', () => {
    expect(src).toMatch(/setProposalStatus\(db, \{[^}]*\bfrom\b[^}]*\}\)/)
  })

  it('answers 409 with what the proposal became when the status changed meanwhile, and 404 only when it is gone', () => {
    const tail = src.slice(src.indexOf('const row = await setProposalStatus('))
    expect(tail).toContain('readProposal(db, user.orgId, id)')
    expect(tail).toContain('status: 409')
    expect(tail).toContain('a moment ago')
    expect(tail).toContain('by the buyer from their link')
    expect(tail).toContain('Nothing was changed')
  })
})
