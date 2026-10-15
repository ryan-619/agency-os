/**
 * True data only (2026-10-13): which of the agency's own tools count as having
 * SHOWN the agent something is asked twice — by the worker's ledger, before a
 * result is kept (`READS_FROM_OUTSIDE`), and by the tools that write, before a
 * name, a profile or a website is stored (`AGENCY_OUTSIDE_READERS`, through
 * `showsIt`). The write side asks again so the rule holds whatever ledger is
 * handed in. The two lists must be one list: a reader added to one and not the
 * other would either let the agency's replay of its own records vouch for a
 * guess, or refuse what a real page showed.
 */
import { describe, expect, it } from 'vitest'
import { AGENCY_OUTSIDE_READERS, showsIt } from '@agency/tools'
import { READS_FROM_OUTSIDE, resultCountsAsShown } from '../src/chat/ledger.js'

describe('the agency tools that read from outside', () => {
  it('are the same names to the ledger and to the tools that write', () => {
    expect([...AGENCY_OUTSIDE_READERS].sort()).toEqual([...READS_FROM_OUTSIDE].sort())
  })

  it('are read the same way: a connector counts, the agency’s replay of its own records does not', () => {
    for (const tool of [
      'mcp__exa__web_search_exa',
      'mcp__agency__read_page',
      'mcp__agency__find_contact_details',
      'mcp__agency__get_company',
      'mcp__agency__get_research',
      'mcp__agency__check_contacts',
      'Agent',
      'WebFetch',
    ]) {
      expect(showsIt({ kind: 'tool', tool }), tool).toBe(resultCountsAsShown(tool))
    }
  })
})
