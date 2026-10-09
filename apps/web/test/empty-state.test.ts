/**
 * The empty screens (2026-10-09): every next step an empty page offers is a
 * link to a page that exists, and the pages that had one grey line now say
 * what to do.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const APP = join(SRC, 'app')

function sources(dir: string): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.tsx$/.test(name)) out.push({ file: p.slice(SRC.length + 1), src: readFileSync(p, 'utf8') })
  }
  return out
}

/** Whether `/a/b` is a page of this app: `app/a/b/page.tsx`, or a dynamic segment in its place. */
function isPage(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? ''
  const parts = path.split('/').filter(Boolean)
  let dir = APP
  for (const part of parts) {
    if (existsSync(join(dir, part))) {
      dir = join(dir, part)
      continue
    }
    const dynamic = readdirSync(dir).find((n) => /^\[[^\]]+\]$/.test(n))
    if (!dynamic) return false
    dir = join(dir, dynamic)
  }
  return existsSync(join(dir, 'page.tsx'))
}

describe('empty screens', () => {
  const users = sources(SRC).filter((s) => s.src.includes('<EmptyState') && s.file !== 'components/empty-state.tsx')

  it('are used across the app', () => {
    expect(users.length).toBeGreaterThanOrEqual(8)
  })

  it('offer next steps that are pages of this app', () => {
    const hrefs = users.flatMap(({ file, src }) =>
      [...src.matchAll(/<EmptyState[\s\S]*?\/>|<EmptyState[\s\S]*?<\/EmptyState>/g)].flatMap((m) =>
        [...m[0].matchAll(/href: '([^']+)'/g)].map((h) => ({ file, href: h[1] ?? '' })),
      ),
    )
    expect(hrefs.length).toBeGreaterThanOrEqual(10)
    for (const { file, href } of hrefs) expect(isPage(href), `${file}: ${href}`).toBe(true)
  })

  it('are links, never buttons that do something on their own', () => {
    const src = readFileSync(join(SRC, 'components/empty-state.tsx'), 'utf8')
    expect(src).not.toMatch(/onClick|'use client'|from '@\//)
    expect(src).toMatch(/<Link key=\{a\.href\} href=\{a\.href\} prefetch=\{false\}/)
  })
})
