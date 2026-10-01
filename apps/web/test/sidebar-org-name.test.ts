/**
 * The sidebar names the organisation on every page, from one place.
 *
 * The subtitle under "Agency OS" was a `Shell` prop. The dashboard and the
 * settings area filled it with `orgs.name`; most other pages filled it with
 * the active ICP's label — "Security-gap SaaS (US/EU)", the name of a scoring
 * profile — so the sidebar named a different thing depending on the page a
 * person was on. Found by running the app, not by reading it.
 *
 * `Shell` now reads the org's name itself, through `orgIdentity`
 * (`lib/org-identity.ts`), and has no prop a page could fill. Everything
 * here is read off the source: every page imports `@/auth`, and `Shell` is
 * `server-only` through `orgIdentity`, so neither can be imported by a test
 * in this directory (CLAUDE.md §4).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const APP = join(SRC, 'app')

/** Comments out, so prose about a pattern is not the pattern. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every file under `dir` matching `keep`, found by walking — a list is how a page gets missed. */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full, keep) : keep(entry) ? [full] : []
  })
}

const rel = (full: string): string => full.slice(SRC.length)

/**
 * Each `<Shell …>` opening tag in a source, attributes and all. A tag ends at
 * the first `>` outside braces and quotes, so `signOut={async () => { … }}`
 * — an arrow inside an attribute — does not end it early.
 */
function shellTags(src: string): string[] {
  const out: string[] = []
  const open = /<Shell(?=[\s>])/g
  for (let m = open.exec(src); m; m = open.exec(src)) {
    let depth = 0
    let quote: string | null = null
    let i = m.index + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]!
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

/** The attribute names on one tag: what sits at brace depth 0 before an `=`. */
function attributeNames(tag: string): string[] {
  let depth = 0
  let flat = ''
  for (const c of tag.slice('<Shell'.length)) {
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 0) flat += c
  }
  return [...flat.matchAll(/([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]!)
}

const SOURCES = walk(SRC, (n) => /\.tsx?$/.test(n)).map((full) => ({ file: rel(full), src: code(readFileSync(full, 'utf8')) }))
const CALLS = SOURCES.flatMap(({ file, src }) => shellTags(src).map((tag) => ({ file, tag })))
const PAGES = walk(APP, (n) => n === 'page.tsx').map((full) => ({ file: rel(full), src: code(readFileSync(full, 'utf8')) }))

describe('no caller hands the sidebar a name', () => {
  it('finds the Shell calls by walking src, so the check cannot pass on an empty list', () => {
    const files = new Set(CALLS.map((c) => c.file))
    // The dashboard, a settings page that used the org's name, pages that used
    // the ICP's label, and the permission branches that render a second Shell.
    for (const f of [
      'app/page.tsx', 'app/settings/spend/page.tsx', 'app/settings/deployment/page.tsx', 'app/companies/page.tsx',
      'app/contacts/import/page.tsx', 'app/approvals/page.tsx', 'app/proposals/[id]/page.tsx', 'app/inbox/page.tsx',
    ]) {
      expect(files).toContain(f)
    }
    expect(CALLS.filter((c) => c.file === 'app/compliance/page.tsx')).toHaveLength(2)
    expect(CALLS.filter((c) => c.file === 'app/audit/page.tsx')).toHaveLength(2)
    expect(CALLS.length).toBeGreaterThanOrEqual(33)
  })

  it('reads each tag whole, an arrow inside an attribute included', () => {
    const tag = shellTags(`<Shell user={user} signOut={async () => { 'use server'; await x({ a: '>' }) }} current="companies">`)
    expect(tag).toHaveLength(1)
    expect(attributeNames(tag[0]!)).toEqual(['user', 'signOut', 'current'])
    // The shape this file exists to catch, so the check is shown to be able to fail.
    expect(attributeNames(`<Shell user={user} orgName={icp?.label ?? 'Agency'} current="tasks">`)).toContain('orgName')
  })

  it.each(CALLS.map((c, i) => [`${c.file} #${i}`, c.tag] as const))('%s passes no orgName', (_label, tag) => {
    const names = attributeNames(tag)
    expect(names).toContain('user')
    expect(names).not.toContain('orgName')
    // Nor anything that reads the ICP, under any prop name. A quoted value is
    // a literal — `current="icp"` names the settings page, not a profile.
    expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\bicp\b|orgLabel|\.label\b/)
  })
})

describe('no page computes an org label from the ICP', () => {
  it('walks every page, the ones that render no Shell included', () => {
    const files = PAGES.map((p) => p.file)
    for (const f of ['app/page.tsx', 'app/settings/page.tsx', 'app/book/[slug]/page.tsx', 'app/p/[token]/page.tsx']) {
      expect(files).toContain(f)
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(35)
  })

  it.each(PAGES.map((p) => [p.file, p.src] as const))('%s', (_file, src) => {
    // `orgLabel` was the ICP's label under the org's name, on sixteen pages.
    expect(src).not.toMatch(/\borgLabel\b/)
    // Nor the inline form four more pages handed the sidebar.
    expect(src).not.toMatch(/\bicp\??\.label\b/)
    // The settings index shows the ICP's label, as the ICP's — the one place
    // a parsed label is read — and it is called that.
    for (const m of src.matchAll(/(\w+)\s*=\s*parseIcpDefinition\([^)]*\)\.label/g)) expect(m[1]).toBe('icpLabel')
  })
})

describe('Shell reads the org name itself', () => {
  const shell = code(readFileSync(join(SRC, 'components/shell.tsx'), 'utf8'))
  const identity = code(readFileSync(join(SRC, 'lib/org-identity.ts'), 'utf8'))

  it('has no orgName prop, and renders the name it read', () => {
    expect(shell).not.toMatch(/\borgName\b/)
    expect(shell).toMatch(/export async function Shell\(/)
    expect(shell).toMatch(/const org = await orgIdentity\(user\.orgId\)/)
    expect(shell).toContain('<div className="brand-sub">{org.name}</div>')
  })

  it('reads orgs.name, server-side, once per request', () => {
    expect(identity).toMatch(/^import 'server-only'$/m)
    expect(identity).toMatch(/export const orgIdentity = cache\(/)
    expect(identity).toContain('schema.orgs.name')
    expect(identity).not.toMatch(/icp/i)
  })

  /**
   * An async server component cannot render inside a client component, and
   * `orgIdentity` is `server-only`, so a client module importing Shell would
   * fail the build. Said here first, by file.
   */
  it.each(SOURCES.filter((s) => /^\s*['"]use client['"]/.test(s.src)).map((s) => [s.file, s.src] as const))(
    '%s (a client module) does not import Shell',
    (_file, src) => {
      expect(src).not.toMatch(/from '@\/components\/shell'/)
    },
  )
})

describe('the team copy of a proposal names the agency as the buyer copy does', () => {
  it('passes the org’s name to the document, not the ICP’s label', () => {
    const src = PAGES.find((p) => p.file === 'app/proposals/[id]/page.tsx')!.src
    expect(src).toContain('orgIdentity(user.orgId)')
    expect(src).toContain('agency={{ name: org.name }}')
  })
})
