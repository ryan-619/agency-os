/**
 * The settings panel's copy of how many tools one server's disabled list may
 * hold. The panel is a client module and cannot import the db package, so it
 * carries the number itself; a copy that drifted below the schema would stop
 * an owner saving a list the server would take, and one above it would let
 * them press Save on a list the server refuses.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_DISABLED_TOOLS_MAX } from '@agency/db/queries'

const PANEL = new URL('../src/components/settings/connectors.tsx', import.meta.url)

describe('the connectors panel’s disabled-tool cap', () => {
  it('is the schema’s, exactly', () => {
    const source = readFileSync(PANEL, 'utf8')
    const match = /^const MAX_DISABLED = (\d+)$/m.exec(source)
    expect(match, 'MAX_DISABLED is declared as a plain number').not.toBeNull()
    expect(Number(match![1])).toBe(CONNECTOR_DISABLED_TOOLS_MAX)
  })

  it('holds every tool of a 98-tool server but a handful', () => {
    expect(CONNECTOR_DISABLED_TOOLS_MAX).toBeGreaterThanOrEqual(98)
  })
})
