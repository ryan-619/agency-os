/**
 * Parsing the company lists the CSV import and the seed both accept.
 *
 * Two formats, told apart by the first line that is not blank or a comment:
 *
 *   * the `domain,name` list — one domain per line, everything after the first
 *     comma the name. The seed file, the paste box and `npm run scan --
 *     --import` have always read it this way, and still do, unchanged;
 *   * a companies EXPORT (`apps/web/src/lib/csv.ts`) — a byte-order mark, a
 *     `# internal — never prospect-facing` line, then RFC 4180 under a header
 *     row of column names. Read the first way, every new domain in a
 *     re-imported export came back named `Acme,72,A — call first,yes,…`.
 *
 * Its own module, with no filesystem import, so the web app can use it without
 * dragging paths.ts (and its import.meta.url resolution) into the bundle.
 */
/** A hostname: labels of letters/digits/hyphens, at least one dot, no scheme or path. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * Parse a company list: the `domain,name` seed format, or a companies export.
 *
 * De-duplicates on domain so the caller's inserted/already-present counts add
 * up: `ON CONFLICT DO NOTHING` collapses a repeated domain into one insert, so
 * counting the raw line total would over-report "already present".
 */
export function parseCompanySeeds(csv: string): Array<{ domain: string; name: string }> {
  const header = exportHeader(csv)
  if (header) return parseWithHeader(csv, header)

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

/** A column name as an export writes one: `domain`, `last_scan_at`. */
const COLUMN_NAME = /^[a-z][a-z0-9_]*$/

/** Where the two columns the importer reads sit in an export's header. */
interface HeaderColumns {
  readonly domain: number
  readonly name: number
}

/**
 * The export's header, if the list starts with one: the first line that is
 * not blank or a comment, read as a row of column names that names `domain`
 * and `name` and MORE besides.
 *
 * "More besides" is what keeps the seed format exactly as it was. A bare
 * `domain,name` header is the seed's own, and its rows keep their unquoted
 * commas in the name (`acme.com,Acme, Inc.`); only a wider header says the
 * rows are RFC 4180 with columns to ignore. A row of DATA is never taken for
 * a header, because a domain is not a column name — it has a dot in it.
 */
function exportHeader(csv: string): HeaderColumns | null {
  for (const raw of csv.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const columns = line.split(',').map((c) => c.trim().toLowerCase())
    if (columns.length <= 2 || !columns.every((c) => COLUMN_NAME.test(c))) return null
    const domain = columns.indexOf('domain')
    const name = columns.indexOf('name')
    return domain === -1 || name === -1 ? null : { domain, name }
  }
  return null
}

/**
 * The apostrophe `csvField` puts in front of a cell a spreadsheet would
 * evaluate, and the characters it does so for. Taken back off a NAME, so an
 * export round-trips; a name that genuinely began with an apostrophe followed
 * by one of these comes back without it, which the exporter's own output
 * cannot tell apart.
 */
const FORMULA_GUARD = /^'(?=[=+\-@\t\r])/

/** An export's rows, by its header: the domain and name columns, the rest ignored. */
function parseWithHeader(csv: string, columns: HeaderColumns): Array<{ domain: string; name: string }> {
  const out: Array<{ domain: string; name: string }> = []
  const seen = new Set<string>()
  let header = true

  for (const record of readRecords(csv)) {
    // The header is the first record readRecords yields; exportHeader has
    // already read it.
    if (header) {
      header = false
      continue
    }
    const domain = record[columns.domain] ?? ''
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!d || d === 'domain') continue // a blank cell, or a second header
    if (!DOMAIN.test(d)) {
      throw new Error(`Seed list contains something that is not a domain: "${domain.trim()}"`)
    }
    if (seen.has(d)) continue
    seen.add(d)
    out.push({ domain: d, name: (record[columns.name] ?? '').replace(FORMULA_GUARD, '').trim() })
  }
  return out
}

/**
 * RFC 4180 records: a field is quoted when it holds a comma, a quote or a line
 * break, and a quote inside one is doubled. CRLF or LF ends a record. A
 * leading byte-order mark is dropped, and a line that is blank or starts with
 * `#` — the export's notice — is skipped where a record would begin, as the
 * seed format skips one; inside a quoted field it is data.
 *
 * A quoted field that never closes is refused rather than read to the end of
 * the file: everything after it would otherwise land in one name.
 */
function readRecords(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/, '')
  const records: string[][] = []
  let i = 0

  while (i < text.length) {
    // A record starts here. A blank or comment line is not one.
    let eol = text.indexOf('\n', i)
    if (eol === -1) eol = text.length
    const line = text.slice(i, eol).trim()
    if (!line || line.startsWith('#')) {
      i = eol + 1
      continue
    }

    const record: string[] = []
    let field = ''
    for (;;) {
      if (text[i] === '"') {
        // A quoted field, to its closing quote; "" is one quote.
        i += 1
        for (;;) {
          if (i >= text.length) throw new Error('The list has a quoted field that is never closed.')
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"'
              i += 2
              continue
            }
            i += 1
            break
          }
          field += text[i]
          i += 1
        }
      }
      // Anything up to the next delimiter: an unquoted field, or what follows
      // a closing quote, which a lenient reader keeps rather than refuses.
      while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
        field += text[i]
        i += 1
      }
      record.push(field)
      field = ''
      if (text[i] === ',') {
        i += 1
        continue
      }
      // CRLF, LF, a lone CR, or the end of the text: the record is done.
      if (text[i] === '\r') i += 1
      if (text[i] === '\n') i += 1
      break
    }
    records.push(record)
  }
  return records
}

/**
 * Seed inside a single transaction.
 *
 * Without it a partial run leaves debris: the org is created before the owner
 * is validated, so a mismatched SEED_ORG_NAME used to create a second
 * organisation and *then* fail — leaving exactly the split-brain the check
 * exists to prevent. All or nothing.
 */
