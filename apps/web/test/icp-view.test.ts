/**
 * /settings/icp's view of a definition (§2.2).
 *
 * The rule worth pinning is the one CLAUDE.md §4 records being broken once
 * already: the signals are shown in the AUTHOR's order, whatever order the
 * object's keys arrive in — because jsonb re-sorts them, and the row a page
 * reads is not the file somebody wrote. The rest are the ways a read-only
 * page could still state something the definition does not say: a tier range
 * that overlaps its neighbour, a missing freshness shown as if it were set,
 * a range object rendered as `[object Object]`, and two active profiles
 * presented as one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCORER_DISQUALIFIERS, activeProfilesNote, describeValue, icpView, tierPill } from '../src/lib/icp-view'

const SEED = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/seed/icp-security-gap-saas.json'),
    'utf8',
  ),
) as { signals: Record<string, { weight: number; order: number; why: string }> } & Record<string, unknown>

/**
 * The seed with its signal keys in jsonb's order — shortest key first, then
 * bytewise — which is how the row comes back from Postgres.
 */
function asJsonbWouldReturnIt(def: typeof SEED): typeof SEED {
  const keys = Object.keys(def.signals).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  const signals: typeof SEED.signals = {}
  for (const k of keys) signals[k] = def.signals[k]!
  return { ...def, signals }
}

function view(def: unknown) {
  const r = icpView(def)
  if (!r.ok) throw new Error(`expected a view, got: ${r.problem}`)
  return r.view
}

describe('icpView', () => {
  it("walks the signals in the author's order, not the keys' order", () => {
    const reordered = asJsonbWouldReturnIt(SEED)
    // The premise: the keys really did move, or this test proves nothing.
    expect(Object.keys(reordered.signals)[0]).toBe('csp')
    expect(Object.keys(reordered.signals)[1]).toBe('tls')
    const fromFile = view(SEED).signals.map((s) => s.key)
    const fromRow = view(reordered).signals.map((s) => s.key)
    expect(fromRow).toEqual(fromFile)
    expect(fromRow.slice(0, 4)).toEqual(['csp', 'trust_page', 'compliance_claim', 'security_txt'])
    expect(view(reordered).ordering).toBe('explicit')
  })

  it('carries weight, order and why, and the total weight the score normalises against', () => {
    const v = view(SEED)
    expect(v.totalWeight).toBe(108)
    expect(v.signals).toHaveLength(12)
    expect(v.signals[0]).toEqual({
      key: 'csp', weight: 15, order: 1, why: SEED.signals['csp']!.why, sharePct: 14,
    })
    expect(v.signals.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('says when the order is the key-name fallback rather than the author’s', () => {
    const v = view({
      label: 'x', disqualifiers: {},
      signals: { zeta: { weight: 1, why: 'z' }, alpha: { weight: 2, why: 'a' } },
      scoring: { qualify_at: 10, tiers: [] },
    })
    expect(v.ordering).toBe('key_name')
    expect(v.signals.map((s) => [s.key, s.order])).toEqual([['alpha', null], ['zeta', null]])
  })

  it('gives each tier the whole scores it covers, without overlapping its neighbour', () => {
    const v = view(SEED)
    expect(v.qualifyAt).toBe(45)
    expect(v.tiers.map((t) => [t.name, t.range, t.pill])).toEqual([
      ['A — call first', '70–100', 'pill-a'],
      ['B — sequence', '55–69', 'pill-b'],
      ['C — nurture', '45–54', 'pill-c'],
    ])
  })

  it('lists disqualifiers and firmographics sorted by key, with ranges and lists as text', () => {
    const v = view(SEED)
    expect(v.disqualifiers.map((d) => d.key)).toEqual([
      'enterprise_scale', 'has_security_team', 'is_security_vendor', 'no_public_product', 'unreachable',
    ])
    const firmo = Object.fromEntries(v.firmographics)
    expect(firmo['headcount']).toBe('15–400')
    expect(firmo['geos']).toBe('US, CA, UK, DE, NL, SE, IE, FR, ES, PT, PL')
    for (const [, text] of v.firmographics) expect(text).not.toContain('[object Object]')
  })

  it('narrows outreach key by key, never by cast', () => {
    const o = view(SEED).outreach!
    expect(o.channels).toEqual(['email', 'linkedin'])
    expect(o.maxPerDay).toBe(25)
    expect(o.autoSend).toBe(false)
    expect(o.openerRule).toMatch(/^Lead with ONE specific/)
    expect(o.note).toMatch(/Cold voice and cold SMS/)
    expect(o.other).toEqual([])

    const odd = view({ ...SEED, outreach: { channels: 'email', max_per_day: '25', extra: { a: 1 } } }).outreach!
    expect(odd.channels).toBeNull()
    expect(odd.maxPerDay).toBeNull()
    expect(odd.autoSend).toBeNull()
    expect(odd.other).toEqual([['extra', '{"a":1}']])
  })

  it('reads freshness from the profile, and says when the default applies instead', () => {
    const set = view(SEED)
    expect(set.staleAfterDays).toBe(14)
    expect(set.staleAfterDaysIsDefault).toBe(false)
    const { freshness: _unused, ...withoutFreshness } = SEED as Record<string, unknown>
    const unset = view(withoutFreshness)
    expect(unset.staleAfterDaysIsDefault).toBe(true)
    expect(unset.freshnessNote).toBeNull()
  })

  it("refuses a definition that does not parse, with the parser's reason", () => {
    const r = icpView({ label: '', signals: {}, scoring: {}, disqualifiers: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toMatch(/label must be a non-empty string/)
    expect(icpView(null).ok).toBe(false)
  })
})

/**
 * A disqualifier the profile names and the scorer never evaluates must not be
 * shown as applied. The seed names `enterprise_scale`; nothing checks it.
 */
describe('disqualifiers the scorer applies', () => {
  const scoring = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/src/scoring.ts'),
    'utf8',
  )

  it('agree with the keys scoreCompany reads', () => {
    const read = new Set([...scoring.matchAll(/icp\.disqualifiers\.(\w+)/g)].map((m) => m[1]!))
    // `unreachable` is applied from the fetch itself, before any key is read.
    expect(scoring).toMatch(/if \(!profile\.fetchOk\)/)
    expect(new Set([...read, 'unreachable'])).toEqual(new Set(SCORER_DISQUALIFIERS))
  })

  it('marks the seed’s enterprise_scale as not applied, and the rest as applied', () => {
    const byKey = Object.fromEntries(view(SEED).disqualifiers.map((d) => [d.key, d.applied]))
    expect(byKey).toEqual({
      enterprise_scale: false,
      has_security_team: true,
      is_security_vendor: true,
      no_public_product: true,
      unreachable: true,
    })
  })
})

describe('tierPill', () => {
  it('uses the house tier classes, and the plain pill past the third', () => {
    expect([0, 1, 2, 3, 7].map(tierPill)).toEqual(['pill-a', 'pill-b', 'pill-c', 'pill', 'pill'])
  })
})

describe('describeValue', () => {
  it('never renders an object as [object Object]', () => {
    expect(describeValue({ min: 1, max: 9 })).toBe('1–9')
    expect(describeValue({ a: [1, 2] })).toBe('{"a":[1,2]}')
    expect(describeValue(['a', 2, true])).toBe('a, 2, true')
    expect(describeValue(null)).toBe('—')
  })
})

describe('activeProfilesNote', () => {
  it('is silent for exactly one active profile, whatever else exists', () => {
    expect(activeProfilesNote([{ active: true }])).toBeNull()
    expect(activeProfilesNote([{ active: false }, { active: true }, { active: false }])).toBeNull()
  })

  it('flags two active profiles as a choice nobody made', () => {
    const note = activeProfilesNote([{ active: true }, { active: true }, { active: false }])
    expect(note).toMatch(/^2 profiles are marked active/)
    expect(note).toMatch(/exactly one active/)
  })

  it('flags none active, and none at all, differently', () => {
    expect(activeProfilesNote([{ active: false }])).toMatch(/No profile is active/)
    expect(activeProfilesNote([])).toMatch(/No ICP profile exists/)
  })
})
