/**
 * The search box's rules that coverage cannot prove, read off the source.
 *
 * Three of them are about what a later edit could quietly add. An `ilike(`
 * taking the raw query turns `%` into "every row"; a join or a helper that
 * names `chatSessions` or `connectors` puts a prompt or a token-bearing URL
 * one keystroke from the box; a log line carrying `q` writes whatever
 * somebody pasted — a phone number, a sign-in link — somewhere `redact()`
 * cannot see, because it keys off field names and not values. The behaviour
 * is tested against a real engine in `packages/db/test/search.test.ts`;
 * these make the shapes that would break it impossible to add unnoticed.
 * The same instrument keeps `return null` out of `can-use-tool.ts`.
 *
 * The rest are the box's own pure parts — how it reads what was typed, and
 * where the keys go — since there is no DOM test environment here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SearchHit } from '@agency/db/queries'
import {
  SEARCH_BOX_MIN_CHARS, searchBoxEnter, searchBoxFlat, searchBoxGroups, searchBoxMove, searchBoxQuery,
} from '../src/components/search-box'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** Comments out, so prose about an excluded table is not a reference to it. */
const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/**
 * Comments and quoted strings out: `'approvals:decide'` is a capability the
 * module asks about, not a reference to the approvals table. Template
 * literals stay, since their `${}` holes are code.
 */
const codeOnly = (src: string): string =>
  withoutComments(src).replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')

/** The argument list of every call to `name(`, split at its top-level commas. */
function callsTo(code: string, name: string): string[][] {
  const calls: string[][] = []
  const re = new RegExp(`(?<![\\w.$])${name.replace(/\./g, '\\.')}\\(`, 'g')
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const args: string[] = []
    let depth = 0
    let start = m.index + m[0].length
    let i = start
    for (; i < code.length; i++) {
      const c = code[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) {
        args.push(code.slice(start, i).trim())
        start = i + 1
      }
    }
    const last = code.slice(start, i).trim()
    if (last !== '') args.push(last)
    calls.push(args)
  }
  return calls
}

const SEARCH = codeOnly(read('../../../packages/db/src/search.ts'))
const ROUTE = codeOnly(read('../src/app/api/search/route.ts'))
const BOX = codeOnly(read('../src/components/search-box.tsx'))

describe('packages/db/src/search.ts', () => {
  it('passes every ilike( the variable `pattern`, never the query', () => {
    const calls = callsTo(SEARCH, 'ilike')
    // Not vacuous: seven sections, most over several columns.
    expect(calls.length).toBeGreaterThanOrEqual(15)
    for (const args of calls) {
      expect(args, `ilike(${args.join(', ')})`).toHaveLength(2)
      expect(args[1], `ilike(${args.join(', ')}) — the needle must go through containsPattern`).toBe('pattern')
    }
  })

  it('binds `pattern` only from containsPattern', () => {
    const bindings = [...SEARCH.matchAll(/\bpattern\s*=(?![=>])\s*([^\n;]*)/g)].map((m) => m[1]!)
    expect(bindings.length).toBeGreaterThan(0)
    for (const rhs of bindings) expect(rhs, `pattern = ${rhs}`).toMatch(/^containsPattern\(/)
  })

  /** A second LIKE-family operator, or raw SQL, is a second way for a needle to reach the engine unescaped. */
  it('uses no other LIKE operator and no raw SQL', () => {
    expect(SEARCH).not.toMatch(/(?<![\w.$])(like|notLike|notIlike)\s*\(/)
    expect(SEARCH).not.toMatch(/(?<![\w.$])sql\s*[`(.]/)
    expect(SEARCH).not.toMatch(/\bexecute\s*\(/)
  })

  /**
   * The columns the box reads, exactly. Adding one is a §2.3 decision —
   * check it against the exclusions below and the research's table — and
   * this list is where that decision is made visible in review.
   */
  it('searches exactly the reviewed columns', () => {
    const columns = new Set(callsTo(SEARCH, 'ilike').map((args) => args[0]))
    expect([...columns].sort()).toEqual([
      'schema.campaigns.name',
      'schema.companies.country',
      'schema.companies.domain',
      'schema.companies.name',
      'schema.companies.stage',
      'schema.companies.title',
      'schema.contacts.email',
      'schema.contacts.firstName',
      'schema.contacts.lastName',
      'schema.contacts.linkedinUrl',
      'schema.contacts.phone',
      'schema.contacts.title',
      'schema.deals.lostReason',
      'schema.deals.nextAction',
      'schema.meetings.notes',
      'schema.meetings.title',
      'schema.proposals.title',
      'schema.touches.body',
      'schema.touches.recipient',
      'schema.touches.subject',
    ])
  })

  /**
   * §2.3: connectors and their config, stored credentials, agent prompts,
   * chat (a thread's title IS its first prompt), approval payloads, audit
   * detail, raw scan headers, findings, the roster and its sign-in rows, and
   * the Message-IDs inbound mail is matched by. Kept out by absence: a file
   * that never names them cannot widen to them through a filter somebody
   * forgets.
   */
  it.each([
    'chatSessions', 'chatMessages', 'connectors', 'secrets', 'agentDefs', 'approvals', 'auditLog',
    'verificationTokens', 'users', 'sessions', 'accounts', 'findings', 'scans',
    'providerId', 'systemPrompt', 'secretRef', 'payload', 'raw',
  ])('never references %s', (name) => {
    expect(SEARCH).not.toMatch(new RegExp(`\\b${name}\\b`))
  })

  it('reaches tables only through the schema namespace, and imports nothing that could reach others', () => {
    // codeOnly blanks strings, so the specifiers are read off the source.
    const raw = withoutComments(read('../../../packages/db/src/search.ts'))
    const specifiers = [...raw.matchAll(/^import\s[^\n]*?\sfrom\s+'([^']+)'/gm)].map((m) => m[1])
    expect([...SEARCH.matchAll(/^import\s/gm)]).toHaveLength(specifiers.length)
    expect(specifiers.sort()).toEqual(['./repository.js', './schema.js', '@agency/core', 'drizzle-orm', 'drizzle-orm/pg-core'])
    expect(raw).toMatch(/^import \* as schema from '\.\/schema\.js'$/m)
    expect(raw).toMatch(/^import type \{ AgencyDb \} from '\.\/repository\.js'$/m)
    expect(SEARCH).not.toMatch(/\bschema\s*\[/)
  })

  it('agrees with the box on the minimum', () => {
    const min = /\bSEARCH_MIN_CHARS\s*=\s*(\d+)/.exec(SEARCH)
    expect(min).not.toBeNull()
    expect(Number(min![1])).toBe(SEARCH_BOX_MIN_CHARS)
  })
})

describe('apps/web/src/app/api/search/route.ts', () => {
  it('is dynamic, on node, and never cached', () => {
    const src = read('../src/app/api/search/route.ts')
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(src).toMatch(/export const runtime = 'nodejs'/)
    expect(ROUTE).toMatch(/export const revalidate = 0\b/)
  })

  /** Sections come from `can()`, never from a literal someone set to true. */
  it('searches with the sections searchSectionsFor gave it, and refuses when it gave none', () => {
    expect(ROUTE).toMatch(/const sections = searchSectionsFor\(/)
    expect(ROUTE).toMatch(/if \(!sections\) return NextResponse\.json\([^)]*\{ status: 403 \}\)/)
    const calls = callsTo(ROUTE, 'searchOrg')
    expect(calls).toHaveLength(1)
    expect(calls[0]![3]).toBe('sections')
  })

  /**
   * `q` is content. Its length may be logged; it may not, and nor may the
   * hits (they are names), the URL it arrived in, or a driver error's
   * message — drizzle's quotes the bound parameters.
   */
  it('never logs the query, the hits or an error message', () => {
    const calls = ['log.debug', 'log.info', 'log.warn', 'log.error'].flatMap((name) => callsTo(ROUTE, name))
    expect(calls.length, 'no log call was found; if logging was removed on purpose, drop this line').toBeGreaterThan(0)
    for (const args of calls) {
      const text = args.join(', ').replace(/\bparsed\.q\.length\b/g, 'LENGTH').replace(/\bresult\.hits\.length\b/g, 'COUNT')
      expect(text, text).not.toMatch(/\bq\b/)
      expect(text, text).not.toMatch(/\b(request|searchParams|url|hits)\b(?!:)/)
      expect(text, text).not.toMatch(/\.(message|stack|cause)\b/)
      expect(text, text).not.toMatch(/\berr\b(?!\s+instanceof\b|\.name\b)/)
    }
    expect(ROUTE).not.toMatch(/\bconsole\./)
  })
})

describe('the search box', () => {
  const hit = (kind: SearchHit['kind'], id: string): SearchHit => ({ kind, id, label: id, sub: null, href: `/x/${id}` })

  it('reads what was typed the way the route does', () => {
    expect(searchBoxQuery('  rent \t\n  man ')).toBe('rent man')
    expect(searchBoxQuery('   ')).toBe('')
    expect(searchBoxQuery(' a ').length).toBeLessThan(SEARCH_BOX_MIN_CHARS)
  })

  it('groups hits under one heading per kind, in the order they came', () => {
    const groups = searchBoxGroups([hit('company', 'c1'), hit('company', 'c2'), hit('contact', 'p1'), hit('touch', 't1')])
    expect(groups.map((g) => [g.heading, g.hits.map((h) => h.id)])).toEqual([
      ['Companies', ['c1', 'c2']],
      ['People', ['p1']],
      ['Messages', ['t1']],
    ])
  })

  /** The highlight walks the list as drawn, even if a kind arrived split. */
  it('walks the hits in the order they are drawn', () => {
    const flat = searchBoxFlat(searchBoxGroups([hit('company', 'c1'), hit('deal', 'd1'), hit('company', 'c2')]))
    expect(flat.map((h) => h.id)).toEqual(['c1', 'c2', 'd1'])
  })

  it('moves the highlight with the arrow keys, wrapping at both ends', () => {
    expect(searchBoxMove(-1, 'ArrowDown', 3)).toBe(0)
    expect(searchBoxMove(0, 'ArrowDown', 3)).toBe(1)
    expect(searchBoxMove(2, 'ArrowDown', 3)).toBe(0)
    expect(searchBoxMove(-1, 'ArrowUp', 3)).toBe(2)
    expect(searchBoxMove(0, 'ArrowUp', 3)).toBe(2)
    expect(searchBoxMove(2, 'ArrowUp', 3)).toBe(1)
    expect(searchBoxMove(1, 'Home', 3)).toBe(0)
    expect(searchBoxMove(1, 'End', 3)).toBe(2)
    expect(searchBoxMove(1, 'a', 3)).toBe(1)
    expect(searchBoxMove(-1, 'ArrowDown', 0)).toBe(-1)
  })

  it('opens the highlighted hit, or the only one, and never guesses between several', () => {
    const one = [hit('company', 'c1')]
    const two = [hit('company', 'c1'), hit('contact', 'p1')]
    expect(searchBoxEnter(one, -1)).toBe('/x/c1')
    expect(searchBoxEnter(two, -1)).toBeNull()
    expect(searchBoxEnter(two, 1)).toBe('/x/p1')
    expect(searchBoxEnter([], -1)).toBeNull()
  })

  it('shows the copy the brief fixed', () => {
    const src = read('../src/components/search-box.tsx')
    expect(src).toContain('Search companies, people, deals…')
    expect(src).toContain('Nothing matches in what you can see.')
    // The box decides nothing about access, and asks only its own route.
    expect(BOX).toMatch(/fetch\(`\/api\/search\?q=\$\{encodeURIComponent\(q\)\}`/)
    expect(src).not.toMatch(/^import(?!\s+type)[^\n]*'@agency\/db/m)
  })
})
