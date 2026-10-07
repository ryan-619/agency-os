import { FIRMOGRAPHIC_DISQUALIFIERS, orderedSignals, parseIcpDefinition, staleAfterDaysOf, totalWeight } from '@agency/core'

/**
 * An ICP profile row, reduced to what /settings/icp shows (§2.2).
 *
 * Read only. A stored score names the definition it was computed from, and
 * every finding carries the weight that definition gave it — so editing a
 * definition in place changes what every number already on screen MEANS
 * without changing a single number. There is no edit control, and this
 * module is where that is true by construction: it turns a definition into
 * rows and sentences and has no way to produce anything else.
 *
 * The signals are walked with `orderedSignals()` and nothing else. The
 * definition is `jsonb`, which reorders object keys by length and then
 * bytewise, so `Object.entries(def.signals)` gives a different order from the
 * row than from the seed file (CLAUDE.md §4). `firmographics` and `outreach`
 * are `Record<string, unknown>` in the type; they are narrowed here, key by
 * key, rather than cast.
 *
 * Pure: no `server-only`, no `@/` import, no database — a test imports it.
 */

export interface IcpSignalView {
  readonly key: string
  readonly weight: number
  /** The author's `order`, or null when the profile has none and the key name orders it. */
  readonly order: number | null
  readonly why: string
  /** This signal's share of the total weight, as a whole percentage. */
  readonly sharePct: number
}

/** The house tier classes, highest first. A fourth tier and beyond gets the plain pill. */
export type TierPill = 'pill-a' | 'pill-b' | 'pill-c' | 'pill'

export interface IcpTierView {
  readonly name: string
  readonly floor: number
  /** The whole scores this tier covers, e.g. `55–69`, or `70–100` for the top one. */
  readonly range: string
  readonly pill: TierPill
}

/**
 * The disqualifiers the scorer actually evaluates (`scoreCompany` in
 * packages/core/src/scoring.ts): `unreachable` from the fetch itself, three
 * from what the scan observed, and since 0021 the firmographic three —
 * `enterprise_scale`, `too_small` and `outside_geos` — from what the CRM
 * records about the company, applied only when that headcount or country is
 * recorded. A profile can name more, and the page must not present those as
 * applied, because nothing checks them. `apps/web/test/icp-view.test.ts`
 * reads scoring.ts and fails if this list and the scorer disagree.
 */
export const SCORER_DISQUALIFIERS: ReadonlySet<string> = new Set([
  'unreachable', 'is_security_vendor', 'has_security_team', 'no_public_product', ...FIRMOGRAPHIC_DISQUALIFIERS,
])

/** When a firmographic disqualifier applies: only once the fact it reads is recorded. */
export const FIRMOGRAPHIC_WHEN: Readonly<Record<string, string>> = {
  enterprise_scale: 'when its headcount is recorded',
  too_small: 'when its headcount is recorded',
  outside_geos: 'when its country is recorded',
}

export interface IcpDisqualifierView {
  readonly key: string
  readonly why: string
  /** The scorer evaluates this key. False: it is written in the profile and checked by nothing. */
  readonly applied: boolean
  /** For a firmographic disqualifier, when it applies: "when its headcount is recorded". */
  readonly when: string | null
}

export interface IcpOutreachView {
  readonly channels: readonly string[] | null
  readonly maxPerDay: number | null
  readonly autoSend: boolean | null
  readonly openerRule: string | null
  readonly note: string | null
  /** Any other key, described as text. */
  readonly other: readonly (readonly [string, string])[]
}

export interface IcpView {
  readonly label: string
  readonly positioning: string | null
  readonly signals: readonly IcpSignalView[]
  readonly totalWeight: number
  /** Whether the order shown is the author's (`order` on every signal) or the key-name fallback. */
  readonly ordering: 'explicit' | 'key_name'
  readonly qualifyAt: number
  readonly tiers: readonly IcpTierView[]
  readonly scoringNote: string | null
  readonly disqualifiers: readonly IcpDisqualifierView[]
  /** The threshold every reader uses — `staleAfterDaysOf`'s answer, never the raw value. */
  readonly staleAfterDays: number
  /** True when the product default applies: the profile sets no freshness, or one no reader can use. */
  readonly staleAfterDaysIsDefault: boolean
  /**
   * The value the profile SETS when no reader can use it (`isStale` throws on
   * anything but a positive number), as written — so the page says the
   * default applies and why, rather than "stale after 0 days". Null otherwise.
   */
  readonly staleAfterDaysRefused: string | null
  readonly freshnessNote: string | null
  readonly firmographics: readonly (readonly [string, string])[]
  readonly outreach: IcpOutreachView | null
}

export type IcpViewResult =
  | { readonly ok: true; readonly view: IcpView }
  /** The definition does not parse. The problem is the parser's own sentence. */
  | { readonly ok: false; readonly problem: string }

/** The pill class for the tier at `index` in the (highest-first) list. */
export function tierPill(index: number): TierPill {
  return index === 0 ? 'pill-a' : index === 1 ? 'pill-b' : index === 2 ? 'pill-c' : 'pill'
}

/**
 * The whole scores each tier covers. Scores are integers on 0–100 and the
 * tier walk returns the first tier whose floor the score reaches, so a tier
 * runs from its floor up to one below the floor above it.
 */
function tierRange(floor: number, above: number | null): string {
  const top = above === null ? 100 : Math.ceil(above) - 1
  const bottom = Math.ceil(floor)
  return top <= bottom ? String(bottom) : `${bottom}–${top}`
}

/**
 * Any jsonb value as one line of text. Arrays are joined, a `{min, max}`
 * range reads as one, and anything else is its JSON — never `[object Object]`.
 */
export function describeValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map((x) => describeValue(x)).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 2 && typeof o['min'] === 'number' && typeof o['max'] === 'number') {
      return `${o['min']}–${o['max']}`
    }
    return JSON.stringify(v)
  }
  return String(v)
}

const OUTREACH_KNOWN = new Set(['channels', 'max_per_day', 'auto_send', 'opener_rule', 'note'])

function outreachView(o: Record<string, unknown> | undefined): IcpOutreachView | null {
  if (!o || typeof o !== 'object') return null
  const channels = Array.isArray(o['channels']) && o['channels'].every((c) => typeof c === 'string')
    ? (o['channels'] as string[])
    : null
  const maxPerDay = typeof o['max_per_day'] === 'number' && Number.isFinite(o['max_per_day']) ? o['max_per_day'] : null
  const autoSend = typeof o['auto_send'] === 'boolean' ? o['auto_send'] : null
  const openerRule = typeof o['opener_rule'] === 'string' ? o['opener_rule'] : null
  const note = typeof o['note'] === 'string' ? o['note'] : null
  const other = Object.keys(o)
    .filter((k) => !OUTREACH_KNOWN.has(k))
    .sort()
    .map((k) => [k, describeValue(o[k])] as const)
  return { channels, maxPerDay, autoSend, openerRule, note, other }
}

/** A definition as the page shows it, or the parser's reason it cannot be shown. */
export function icpView(definition: unknown): IcpViewResult {
  let def
  try {
    def = parseIcpDefinition(definition)
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : 'The definition could not be read.' }
  }

  const total = totalWeight(def)
  const walked = orderedSignals(def)
  const signals: IcpSignalView[] = walked.map(([key, s]) => ({
    key,
    weight: s.weight,
    order: s.order ?? null,
    why: s.why,
    sharePct: total > 0 ? Math.round((s.weight / total) * 100) : 0,
  }))

  const tiers: IcpTierView[] = def.scoring.tiers.map((t, i, all) => ({
    name: t.name,
    floor: t.floor,
    range: tierRange(t.floor, i === 0 ? null : all[i - 1]!.floor),
    pill: tierPill(i),
  }))

  // Sorted by key so the table does not depend on jsonb's key order either.
  const disqualifiers = Object.keys(def.disqualifiers)
    .sort()
    .map((k) => ({
      key: k,
      why: def.disqualifiers[k] ?? '',
      applied: SCORER_DISQUALIFIERS.has(k),
      when: FIRMOGRAPHIC_WHEN[k] ?? null,
    }))
  const firmographics = def.firmographics
    ? Object.keys(def.firmographics).sort().map((k) => [k, describeValue(def.firmographics![k])] as const)
    : []

  // The threshold every other reader takes, so this page cannot show one
  // the scorer, the proposal page and the agent are not using.
  const staleAfterDays = staleAfterDaysOf(def)
  const set: unknown = def.freshness?.stale_after_days
  const staleIsSet = set !== undefined && set === staleAfterDays

  return {
    ok: true,
    view: {
      label: def.label,
      positioning: typeof def.positioning === 'string' ? def.positioning : null,
      signals,
      totalWeight: total,
      ordering: signals.length > 0 && signals.every((s) => s.order !== null) ? 'explicit' : 'key_name',
      qualifyAt: def.scoring.qualify_at,
      tiers,
      scoringNote: typeof def.scoring.note === 'string' ? def.scoring.note : null,
      disqualifiers,
      staleAfterDays,
      staleAfterDaysIsDefault: !staleIsSet,
      // JSON, so a quoted "14" reads as the text it is rather than a number.
      staleAfterDaysRefused: set === undefined || staleIsSet ? null : JSON.stringify(set),
      freshnessNote: typeof def.freshness?.note === 'string' ? def.freshness.note : null,
      firmographics,
      outreach: outreachView(def.outreach),
    },
  }
}

/**
 * The warning for the org's set of profiles, or null when exactly one is
 * active. `activeIcpProfile` takes the first active row with no ORDER BY, so
 * with two the scanner is choosing between them and nobody chose which.
 */
export function activeProfilesNote(rows: readonly { readonly active: boolean }[]): string | null {
  const active = rows.filter((r) => r.active).length
  if (active === 1) return null
  if (rows.length === 0) {
    return 'No ICP profile exists for this organisation, so nothing can be scored. Seed it — npm run db:seed locally, ./tools/remote-setup.sh against a deployed database.'
  }
  if (active === 0) {
    return 'No profile is active, so the scanner, the agent’s scoring tools and every page that reads the ICP find none, and nothing new is scored.'
  }
  return (
    `${active} profiles are marked active. The scanner reads the first active row the database returns, ` +
    'with no ordering, so which of these a new score is computed against is not a choice anybody made. ' +
    'Every profile is listed below; the fix is to leave exactly one active.'
  )
}
