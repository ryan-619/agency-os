/**
 * A new ideal-customer profile, derived from an existing one (0021).
 *
 * The ICP is never edited in place: a stored score names the profile it was
 * computed under, and changing that profile would change what every old score
 * claims to mean (CLAUDE.md §4). So a new market or size band is a NEW
 * profile — "Security-gap SaaS (India, 10–500 staff)" — derived from the
 * active one, with the same signals and weights unless an owner asks for
 * others, stored inactive until somebody activates it. Pure: it builds the
 * definition and validates it through `parseIcpDefinition`, the reader every
 * caller uses, so a profile this writes is one every reader can read.
 */
import { countryCode, countryName } from './country.js'
import { parseIcpDefinition, type IcpDefinition } from './icp.js'
import { icpTargeting } from './scoring.js'

/** Funding stages a company — and a profile's targeting — may name. The application's vocabulary (0021). */
export const COMPANY_STAGES = [
  'pre-seed',
  'seed',
  'series-a',
  'series-b',
  'series-c-plus',
  'bootstrapped',
  'bootstrapped-profitable',
  'public',
  'acquired',
] as const
export type CompanyStage = (typeof COMPANY_STAGES)[number]

export function isCompanyStage(value: string): value is CompanyStage {
  return (COMPANY_STAGES as readonly string[]).includes(value)
}

export interface IcpChanges {
  /** The new profile's label, which is also its name in the CRM. */
  readonly label: string
  readonly positioning?: string
  /** Markets, as people write them — "India", "IN", "UK". Each must read as a country. */
  readonly geos?: readonly string[]
  readonly headcount?: { readonly min?: number | null; readonly max?: number | null }
  readonly stages?: readonly string[]
  readonly mustHave?: readonly string[]
  /** New weights for signals the base profile already scores; nothing new is added this way. */
  readonly weights?: Readonly<Record<string, number>>
  /** Disqualify a company whose recorded country is outside `geos`. Absent: as the base profile does. */
  readonly disqualifyOutsideGeos?: boolean
  /** Disqualify a company whose recorded headcount is under `headcount.min`. Absent: as the base does. */
  readonly disqualifyTooSmall?: boolean
}

export type DeriveIcpResult =
  | { readonly ok: true; readonly definition: IcpDefinition }
  | { readonly ok: false; readonly message: string }

const MAX_WEIGHT = 50

/** A URL- and log-safe id for a label: lower-case words joined by hyphens. */
export function icpSlug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Build the new definition, or say why not. Every refusal is a sentence a
 * person can act on; nothing here is written anywhere.
 */
export function deriveIcp(base: IcpDefinition, changes: IcpChanges): DeriveIcpResult {
  const label = changes.label.replace(/\s+/g, ' ').trim()
  if (label.length < 3 || label.length > 80) {
    return { ok: false, message: 'A profile’s label is 3 to 80 characters, e.g. "Security-gap SaaS (India)".' }
  }
  const slug = icpSlug(label)
  if (!slug) return { ok: false, message: 'A profile’s label needs letters or digits in it.' }

  const baseTargeting = icpTargeting(base)
  const firmographics: Record<string, unknown> = { ...(base.firmographics ?? {}) }

  let geos = baseTargeting.geos
  if (changes.geos !== undefined) {
    const read: string[] = []
    for (const g of changes.geos) {
      const code = countryCode(g)
      if (!code) return { ok: false, message: `"${String(g).slice(0, 60)}" is not a country this system can read. Use a name or a two-letter code, e.g. India or IN.` }
      if (!read.includes(code)) read.push(code)
    }
    geos = read
    firmographics.geos = read
  }

  let min = baseTargeting.headcountMin
  let max = baseTargeting.headcountMax
  if (changes.headcount !== undefined) {
    const want = (v: number | null | undefined, keep: number | null): number | null =>
      v === undefined ? keep : v === null ? null : v
    min = want(changes.headcount.min, min)
    max = want(changes.headcount.max, max)
    for (const [which, v] of [['minimum', min], ['maximum', max]] as const) {
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 10_000_000)) {
        return { ok: false, message: `The headcount ${which} must be a whole number of people from 1 to 10,000,000.` }
      }
    }
    if (min !== null && max !== null && min > max) {
      return { ok: false, message: `The headcount minimum (${min}) is above the maximum (${max}).` }
    }
    firmographics.headcount = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) }
  }

  if (changes.stages !== undefined) {
    const bad = changes.stages.find((s) => !isCompanyStage(s))
    if (bad !== undefined) {
      return { ok: false, message: `"${String(bad).slice(0, 40)}" is not a stage. Use one of: ${COMPANY_STAGES.join(', ')}.` }
    }
    firmographics.stage = [...new Set(changes.stages)]
  }
  if (changes.mustHave !== undefined) {
    const lines = changes.mustHave.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (lines.length > 10 || lines.some((l) => l.length > 160)) {
      return { ok: false, message: 'At most 10 must-haves, each at most 160 characters.' }
    }
    firmographics.must_have = lines
  }

  const signals: Record<string, { weight: number; why: string; order?: number }> = {}
  for (const [key, sig] of Object.entries(base.signals)) signals[key] = { ...sig }
  for (const [key, weight] of Object.entries(changes.weights ?? {})) {
    const sig = signals[key]
    if (!sig) {
      return { ok: false, message: `"${key.slice(0, 40)}" is not a signal this profile scores; a new signal is a new scanner check, not a weight.` }
    }
    if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
      return { ok: false, message: `The weight for ${key} must be a whole number from 1 to ${MAX_WEIGHT}.` }
    }
    sig.weight = weight
  }

  const disqualifiers: Record<string, string> = { ...base.disqualifiers }
  if (max !== null && max !== baseTargeting.headcountMax && disqualifiers.enterprise_scale !== undefined) {
    disqualifiers.enterprise_scale = `Over ~${max.toLocaleString('en')} staff: larger than this profile targets`
  }
  if (changes.disqualifyTooSmall === true) {
    if (min === null) return { ok: false, message: 'To turn away small companies, give the profile a headcount minimum.' }
    disqualifiers.too_small = `Under ${min.toLocaleString('en')} staff: smaller than this profile targets`
  } else if (changes.disqualifyTooSmall === false) {
    delete disqualifiers.too_small
  } else if (disqualifiers.too_small !== undefined && min !== null && min !== baseTargeting.headcountMin) {
    disqualifiers.too_small = `Under ${min.toLocaleString('en')} staff: smaller than this profile targets`
  }
  if (changes.disqualifyOutsideGeos === true) {
    if (geos.length === 0) return { ok: false, message: 'To turn away companies outside the profile’s markets, give it markets (geos).' }
    disqualifiers.outside_geos = `Outside the markets this profile targets (${geos.map(countryName).join(', ')})`
  } else if (changes.disqualifyOutsideGeos === false) {
    delete disqualifiers.outside_geos
  } else if (disqualifiers.outside_geos !== undefined && changes.geos !== undefined) {
    disqualifiers.outside_geos = `Outside the markets this profile targets (${geos.map(countryName).join(', ')})`
  }

  const positioning = changes.positioning?.replace(/\s+/g, ' ').trim()
  if (positioning !== undefined && positioning.length > 1000) {
    return { ok: false, message: 'The positioning is at most 1,000 characters.' }
  }

  const candidate = {
    ...base,
    id: slug,
    label,
    ...(positioning ? { positioning } : {}),
    firmographics,
    disqualifiers,
    signals,
  }
  try {
    return { ok: true, definition: parseIcpDefinition(candidate) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'The profile does not validate.' }
  }
}
