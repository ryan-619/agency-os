/**
 * A country, as people write it, read as one ISO 3166-1 alpha-2 code (0021).
 *
 * `companies.country` is free text ("as people write it"), and the ICP's
 * `firmographics.geos` was written with `UK` for the United Kingdom, whose
 * code is `GB`. Comparing the two — is this company in a market the profile
 * targets? — needs both read the same way. So: a two-letter code, an English
 * name ("India", "United Kingdom"), or a short list of common aliases ("UK",
 * "USA", "UAE", "Bharat") becomes the code, and anything else is null —
 * unknown, which every caller must read as NOT ASSESSED, never as a mismatch.
 *
 * The names come from the runtime's own CLDR data (`Intl.DisplayNames`), not a
 * table typed out here, so all 270-odd regions are covered without a typo to
 * drift. Pure: no I/O, only the `Intl` global.
 */

/**
 * Region codes CLDR names that are not countries a company is in — and `UK`,
 * which CLDR names "United Kingdom" though the country's code is `GB`: left
 * in, it would claim that name and every UK company would read as `UK`.
 */
const NOT_A_COUNTRY: ReadonlySet<string> = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB', 'UK'])

/** What people write that CLDR does not call the country. Keys in `fold`ed form. */
const ALIASES: Readonly<Record<string, string>> = {
  UK: 'GB',
  'GREAT BRITAIN': 'GB',
  BRITAIN: 'GB',
  ENGLAND: 'GB',
  SCOTLAND: 'GB',
  WALES: 'GB',
  'NORTHERN IRELAND': 'GB',
  USA: 'US',
  AMERICA: 'US',
  'UNITED STATES OF AMERICA': 'US',
  UAE: 'AE',
  HOLLAND: 'NL',
  BHARAT: 'IN',
  KOREA: 'KR',
  'CZECH REPUBLIC': 'CZ',
  TURKEY: 'TR',
  'HONG KONG': 'HK',
  MACAU: 'MO',
  MACAO: 'MO',
  'IVORY COAST': 'CI',
  'VIET NAM': 'VN',
  'RUSSIAN FEDERATION': 'RU',
}

/** Upper-case, accents and dots dropped, spaces collapsed, a leading "THE" gone. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/^THE /, '')
}

let byName: Map<string, string> | null = null
let codes: Set<string> | null = null

function tables(): { byName: Map<string, string>; codes: Set<string> } {
  if (byName && codes) return { byName, codes }
  byName = new Map()
  codes = new Set()
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    names = null
  }
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b)
      if (NOT_A_COUNTRY.has(code)) continue
      let name: string | undefined
      try {
        name = names?.of(code)
      } catch {
        name = undefined
      }
      if (!name || name === code) continue
      codes.add(code)
      // The first code to claim a name keeps it.
      if (!byName.has(fold(name))) byName.set(fold(name), code)
      // "Hong Kong SAR China", "Congo - Kinshasa": the part people write.
      const short = name.replace(/\s+SAR China$/, '').replace(/\s+-\s+.*$/, '')
      if (short !== name && !byName.has(fold(short))) byName.set(fold(short), code)
    }
  }
  return { byName, codes }
}

/**
 * The ISO 3166-1 alpha-2 code for a country as written, or null when it cannot
 * be read — never a guess. `UK` is `GB`.
 */
export function countryCode(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const folded = fold(text)
  if (!folded || folded.length > 80) return null
  const alias = ALIASES[folded]
  if (alias) return alias
  const t = tables()
  if (/^[A-Z]{2}$/.test(folded)) return t.codes.has(folded) ? folded : null
  return t.byName.get(folded) ?? null
}

/** The English name for a code, for sentences; the code itself when the runtime has none. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
