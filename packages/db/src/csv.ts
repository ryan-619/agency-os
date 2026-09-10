/**
 * Parsing the `domain,name` list the CSV import and the seed both accept.
 *
 * Its own module, with no filesystem import, so the web app can use it without
 * dragging paths.ts (and its import.meta.url resolution) into the bundle.
 */
/** A hostname: labels of letters/digits/hyphens, at least one dot, no scheme or path. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * Parse the `domain,name` seed list, ignoring blank lines and comments.
 *
 * De-duplicates on domain so the caller's inserted/already-present counts add
 * up: `ON CONFLICT DO NOTHING` collapses a repeated domain into one insert, so
 * counting the raw line total would over-report "already present".
 */
export function parseCompanySeeds(csv: string): Array<{ domain: string; name: string }> {
  const out: Array<{ domain: string; name: string }> = []
  const seen = new Set<string>()

  for (const raw of csv.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [domain = '', ...rest] = line.split(',')
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!d || d === 'domain') continue // header
    if (!DOMAIN.test(d)) {
      throw new Error(`Seed list contains something that is not a domain: "${domain.trim()}"`)
    }
    if (seen.has(d)) continue
    seen.add(d)
    // A quoted field keeps its commas; strip the surrounding quotes only.
    const name = rest.join(',').trim().replace(/^"(.*)"$/s, '$1')
    out.push({ domain: d, name })
  }
  return out
}

/**
 * Seed inside a single transaction.
 *
 * Without it a partial run leaves debris: the org is created before the owner
 * is validated, so a mismatched SEED_ORG_NAME used to create a second
 * organisation and *then* fail — leaving exactly the split-brain the check
 * exists to prevent. All or nothing.
 */
