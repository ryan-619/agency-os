/**
 * The ICP definition has to mean the same thing in the row as in the file.
 *
 * `icp_profiles.definition` is `jsonb`, and jsonb does not store an object's
 * keys in the order they were written — it sorts them by length and then
 * bytewise. So a profile walked by `Object.entries(icp.signals)` iterates one
 * way when the parity harness reads the seed file and another way when the app
 * reads the row it was seeded into.
 *
 * That is not cosmetic. The walk order is what `strengths` is built in, and
 * what equal-weight gaps keep through the stable sort that follows — which
 * decides the evidence lines an operator reads in an outbound draft. The
 * seeded profile has three pairs of signals sharing a weight, and the jsonb
 * ordering flips two of them.
 *
 * These tests migrate a real Postgres engine, store the real seed definition,
 * read it back, and assert the engine cannot tell the difference.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  orderedSignals, parseIcpDefinition, scoreCompany,
  type IcpDefinition, type Observation, type SiteProfile,
} from '@agency/core'
import { migratedDb,type TestDb } from './helpers.js'
import { SEED_DIR } from '../src/paths.js'

const source = readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')
const fromFile: IcpDefinition = parseIcpDefinition(JSON.parse(source))

/** Every signal observed and a gap, so ordering is the only thing that varies. */
function allGaps(icp: IcpDefinition): SiteProfile {
  const observations: Record<string, Observation> = {}
  for (const [key] of orderedSignals(icp)) {
    observations[key] = { observed: true, gap: true, detail: `${key} absent`, evidence: { header: key } }
  }
  return {
    domain: 'acme.test', company: 'Acme', title: 'Acme',
    fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
  }
}

describe('the ICP definition survives the round trip through jsonb', () => {
  let db: TestDb
  let fromRow: IcpDefinition

  beforeAll(async () => {
    db = await migratedDb()
    await db.driver.exec(
      `INSERT INTO orgs (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Round Trip')`,
    )
    const rows = await db.driver.select<{ definition: unknown }>(
      `INSERT INTO icp_profiles (org_id, name, definition, active)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, $2::jsonb, true)
       RETURNING definition`,
      [fromFile.label, source],
    )
    fromRow = parseIcpDefinition(rows[0]!.definition)
  }, 30_000)

  afterAll(async () => {
    await db?.close()
  })

  it('confirms jsonb really does reorder the keys — otherwise this suite proves nothing', () => {
    const fileKeys = Object.keys(fromFile.signals)
    const rowKeys = Object.keys(fromRow.signals)
    expect(rowKeys.sort()).toEqual([...fileKeys].sort()) // same set
    expect(rowKeys).not.toEqual(fileKeys) // different order
  })

  it('walks the signals in the same order either way', () => {
    expect(orderedSignals(fromRow).map(([k]) => k)).toEqual(orderedSignals(fromFile).map(([k]) => k))
  })

  it('has ties for the ordering to get wrong', () => {
    const weights = orderedSignals(fromFile).map(([, s]) => s.weight)
    expect(weights.length - new Set(weights).size).toBeGreaterThan(0)
  })

  it('scores a company identically, gaps and strengths in the same order', () => {
    const profile = allGaps(fromFile)
    const a = scoreCompany(profile, fromFile)
    const b = scoreCompany(profile, fromRow)
    expect(b.score).toBe(a.score)
    expect(b.gaps.map((g) => g.key)).toEqual(a.gaps.map((g) => g.key))
    expect(b.strengths.map((s) => s.key)).toEqual(a.strengths.map((s) => s.key))
    expect(b.evidence).toEqual(a.evidence)
    expect(b.headlineFinding).toBe(a.headlineFinding)
  })

  it('orders strengths identically too', () => {
    const profile = allGaps(fromFile)
    const noGaps: SiteProfile = {
      ...profile,
      observations: Object.fromEntries(
        Object.entries(profile.observations).map(([k, o]) => [k, { ...o, gap: false }]),
      ),
    }
    expect(scoreCompany(noGaps, fromRow).strengths.map((s) => s.key))
      .toEqual(scoreCompany(noGaps, fromFile).strengths.map((s) => s.key))
  })
})

describe('an ordering that is half there is rejected rather than guessed at', () => {
  type Editable = { signals: Record<string, Record<string, unknown> | undefined> }

  it('refuses a definition where only some signals carry an order', () => {
    const half = JSON.parse(source) as Editable
    delete half.signals.csp!['order']
    expect(() => parseIcpDefinition(half)).toThrow(/every signal needs an order once any has one/)
  })

  it('refuses duplicate orders', () => {
    const dup = JSON.parse(source) as Editable
    dup.signals.csp!['order'] = dup.signals.trust_page!['order']
    expect(() => parseIcpDefinition(dup)).toThrow(/order must be unique/)
  })

  it('falls back to the key name when no signal carries an order, so it is still total', () => {
    const none = JSON.parse(source) as Editable
    for (const sig of Object.values(none.signals)) delete sig!['order']
    const parsed = parseIcpDefinition(none)
    const keys = orderedSignals(parsed).map(([k]) => k)
    expect(keys).toEqual([...keys].sort())
  })
})
