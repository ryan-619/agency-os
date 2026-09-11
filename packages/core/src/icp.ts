/**
 * The shape of `icp_profiles.definition`.
 *
 * PROMPT.md §8.3: "The signal set, weights, and tier boundaries move into
 * `icp_profiles.definition` so they are editable in the UI." Nothing in this
 * package hard-codes a weight or a threshold — they all arrive from the row.
 * The seeded default is packages/db/seed/icp-security-gap-saas.json (§11).
 */

/** One weighted, observable signal. */
export interface IcpSignal {
  /** Points added when the gap IS present. */
  readonly weight: number
  /** Why it matters, in the language an opener would use. */
  readonly why: string
  /**
   * Where this signal sits in the author's ordering, which is the tie-break
   * when two signals share a weight. Explicit because object key order does
   * NOT survive the database: `definition` is `jsonb`, and jsonb sorts keys by
   * length and then bytewise. The same profile therefore iterates in one order
   * when read from the seed file and another when read from the row it was
   * seeded into — which reorders `strengths`, reorders equal-weight gaps, and
   * so changes the evidence lines an operator reads in an outbound draft.
   *
   * Optional so that a hand-written profile still works; see `orderedSignals`
   * for what happens without it. Either every signal has one or none does.
   */
  readonly order?: number
}

export interface IcpTier {
  readonly name: string
  /** Inclusive lower bound on the normalised 0-100 score. */
  readonly floor: number
}

export interface IcpDefinition {
  readonly id?: string
  readonly label: string
  readonly positioning?: string
  readonly firmographics?: Record<string, unknown>
  /** Human-readable reason per disqualifier key. */
  readonly disqualifiers: Readonly<Record<string, string>>
  /**
   * Read through `orderedSignals()`, never by iterating this object: the order
   * of its keys depends on where the definition was loaded from.
   */
  readonly signals: Readonly<Record<string, IcpSignal>>
  readonly scoring: {
    readonly qualify_at: number
    /** Highest floor first. */
    readonly tiers: readonly IcpTier[]
    readonly note?: string
  }
  readonly freshness?: {
    readonly stale_after_days: number
    readonly note?: string
  }
  readonly outreach?: Record<string, unknown>
}

/** The keys the scanner is expected to produce, in the seeded profile's order. */
export type SignalKey = string

/**
 * Narrow an unknown jsonb value to an IcpDefinition, or explain why not.
 * Used at the database boundary — a profile row is user-editable data.
 */
export function parseIcpDefinition(value: unknown): IcpDefinition {
  const problems: string[] = []
  const d = value as Partial<IcpDefinition> | null

  if (!d || typeof d !== 'object') throw new Error('ICP definition is not an object')
  if (typeof d.label !== 'string' || !d.label) problems.push('label must be a non-empty string')
  if (!d.signals || typeof d.signals !== 'object') problems.push('signals must be an object')
  else {
    const entries = Object.entries(d.signals)
    for (const [key, sig] of entries) {
      if (typeof sig?.weight !== 'number' || !Number.isFinite(sig.weight) || sig.weight < 0) {
        problems.push(`signals.${key}.weight must be a non-negative number`)
      }
      if (typeof sig?.why !== 'string') problems.push(`signals.${key}.why must be a string`)
      if (sig?.order !== undefined && (typeof sig.order !== 'number' || !Number.isFinite(sig.order))) {
        problems.push(`signals.${key}.order must be a finite number`)
      }
    }
    // Half an ordering is worse than none: it looks deliberate and is not.
    const ordered = entries.filter(([, s2]) => s2?.order !== undefined)
    if (ordered.length > 0 && ordered.length !== entries.length) {
      const missing = entries.filter(([, s2]) => s2?.order === undefined).map(([k]) => k)
      problems.push(`every signal needs an order once any has one; missing on ${missing.join(', ')}`)
    }
    const orders = new Set(ordered.map(([, s2]) => s2.order))
    if (orders.size !== ordered.length) problems.push('signals.*.order must be unique')
  }
  if (!d.scoring || typeof d.scoring !== 'object') problems.push('scoring must be an object')
  else {
    if (typeof d.scoring.qualify_at !== 'number') problems.push('scoring.qualify_at must be a number')
    if (!Array.isArray(d.scoring.tiers)) problems.push('scoring.tiers must be an array')
    else {
      d.scoring.tiers.forEach((t, i) => {
        if (typeof t?.name !== 'string') problems.push(`scoring.tiers[${i}].name must be a string`)
        if (typeof t?.floor !== 'number') problems.push(`scoring.tiers[${i}].floor must be a number`)
      })
      // The tier walk returns the FIRST match, so a mis-ordered list would
      // silently hand every qualifying company the lowest tier.
      const floors = d.scoring.tiers.map((t) => t?.floor)
      for (let i = 1; i < floors.length; i++) {
        if ((floors[i] ?? 0) > (floors[i - 1] ?? 0)) {
          problems.push('scoring.tiers must be ordered highest floor first')
          break
        }
      }
    }
  }
  if (!d.disqualifiers || typeof d.disqualifiers !== 'object') {
    problems.push('disqualifiers must be an object')
  }

  if (problems.length) {
    throw new Error(`Invalid ICP definition:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  }
  return d as IcpDefinition
}

/** Sum of every signal weight. The denominator when everything is observed. */
export function totalWeight(icp: IcpDefinition): number {
  return Object.values(icp.signals).reduce((a, s) => a + s.weight, 0)
}

/**
 * The signals in a defined order — the ONLY way anything should walk them.
 *
 * The order is observable in the product: `strengths` is built by walking the
 * signals, and equal-weight gaps keep the walk's order through the stable sort
 * that follows, which decides the evidence lines in an outbound draft. Walking
 * `Object.entries(icp.signals)` makes that depend on where the definition came
 * from, because jsonb reorders object keys by length and then bytewise. The
 * seeded profile is authored heaviest-first and carries explicit `order` to
 * survive the round trip.
 *
 * Without `order` the fallback is the key name: not the author's intent, but a
 * total order that does not change between the file and the row.
 */
export function orderedSignals(icp: IcpDefinition): readonly (readonly [string, IcpSignal])[] {
  const entries = Object.entries(icp.signals)
  const explicit = entries.every(([, s]) => s.order !== undefined)
  return [...entries].sort(([ka, a], [kb, b]) =>
    explicit ? a.order! - b.order! : ka < kb ? -1 : ka > kb ? 1 : 0,
  )
}
