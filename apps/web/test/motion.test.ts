/**
 * The motion layer (2026-10-09): the pure rules it runs on, and what its
 * source must keep promising — that nothing moves for a visitor who asked
 * for less motion, that a hidden element stays focusable and prints, that a
 * counter ends on exactly the text the page was rendered with, and that GSAP
 * never reaches a server component.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COUNT_MAX, countPlan, formatCount, outlinesFor, startsNavigation } from '../src/lib/motion-rules'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function sources(dir: string): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push({ file: p.slice(SRC.length + 1), src: readFileSync(p, 'utf8') })
  }
  return out
}

describe('countPlan: a counter ends on exactly the text it found', () => {
  it.each([
    ['16', { to: 16, decimals: 0, grouping: 'none' }],
    ['0', { to: 0, decimals: 0, grouping: 'none' }],
    ['1,234', { to: 1234, decimals: 0, grouping: 'en-IN' }],
    ['1,23,456', { to: 123456, decimals: 0, grouping: 'en-IN' }],
    ['123,456', { to: 123456, decimals: 0, grouping: 'en-US' }],
    ['4.6', { to: 4.6, decimals: 1, grouping: 'none' }],
    [' 42 ', { to: 42, decimals: 0, grouping: 'none' }],
  ] as const)('%s', (text, plan) => {
    expect(countPlan(text)).toEqual(plan)
    expect(formatCount(plan.to, plan)).toBe(text.trim())
  })

  it('leaves anything that is not one plain number as it is', () => {
    for (const text of ['₹1,200', '12%', '3 days', '2026-10-09', '—', '', '1,2', '12,34,5', '-4', '1e3', '4.', 'n/a', '10 – 20']) {
      expect(countPlan(text), text).toBeNull()
    }
    expect(countPlan(String(COUNT_MAX + 1))).toBeNull()
  })

  it('writes the numbers on the way in the grouping it found', () => {
    expect(formatCount(98765.4, { to: 123456, decimals: 0, grouping: 'en-IN' })).toBe('98,765')
    expect(formatCount(2.35, { to: 4.6, decimals: 1, grouping: 'none' })).toBe('2.4')
  })
})

describe('startsNavigation: the loading bar starts only for another page of this app', () => {
  const here = 'https://myagencyos.in/companies?page=2'
  const link = (href: string, target = '', download = false) => startsNavigation({ href, target, download }, here)

  it('starts for another page, or the same page with other filters', () => {
    expect(link('/contacts')).toBe(true)
    expect(link('https://myagencyos.in/')).toBe(true)
    expect(link('/companies?page=3')).toBe(true)
  })

  it('does not start for a jump within the page, another site, a new tab, a download, an API route or a mail link', () => {
    expect(link('/companies?page=2#top')).toBe(false)
    expect(link('https://wa.me/919876543210')).toBe(false)
    expect(link('/contacts', '_blank')).toBe(false)
    expect(link('/export.csv', '', true)).toBe(false)
    expect(link('/api/export/companies')).toBe(false)
    expect(link('mailto:hello@example.com')).toBe(false)
    expect(link('tel:+918041234567')).toBe(false)
  })
})

describe('outlinesFor: grey outlines stand in only where the page is sure to say it arrived', () => {
  const link = (href: string, here: string) => outlinesFor({ href, target: '', download: false }, here)

  it('for another page, the dashboard included, and for the same page with other filters', () => {
    expect(link('/contacts', 'https://myagencyos.in/companies')).toBe(true)
    expect(link('/', 'https://myagencyos.in/companies')).toBe(true)
    expect(link('/companies?page=3', 'https://myagencyos.in/companies?page=2')).toBe(true)
    expect(link('/chat/abc', 'https://myagencyos.in/chat')).toBe(true)
  })

  it('never for a page above this one, which may hand the visitor straight back here', () => {
    expect(link('/chat', 'https://myagencyos.in/chat/abc')).toBe(false)
    expect(link('/settings', 'https://myagencyos.in/settings/team')).toBe(false)
    expect(link('/chat/', 'https://myagencyos.in/chat/abc')).toBe(false)
  })

  it('never where the bar itself does not start', () => {
    expect(link('/contacts#top', 'https://myagencyos.in/contacts')).toBe(false)
    expect(link('https://wa.me/919876543210', 'https://myagencyos.in/companies')).toBe(false)
  })
})

describe('the motion source keeps its promises', () => {
  const all = sources(SRC)

  it('only a client module imports GSAP, so a server component never carries it', () => {
    const importers = all.filter((s) => /from 'gsap|from '@gsap\/react'|from '[^']*motion\/gsap'|from '\.\/gsap'/.test(s.src))
    expect(importers.length).toBeGreaterThanOrEqual(8)
    for (const { file, src } of importers) {
      if (file === 'components/motion/gsap.ts') continue
      expect(src, file).toMatch(/^'use client'/)
    }
  })

  it.each(['components/motion/motion-root.tsx', 'components/share/preview-motion.tsx', 'app/check/[slug]/form.tsx'])(
    '%s animates only where motion is allowed',
    (file) => {
      expect(read(file)).toMatch(/mm\.add\(MOTION_OK/)
    },
  )

  it('the sidebar highlight jumps rather than slides where motion is unwelcome', () => {
    expect(read('components/motion/nav-indicator.tsx')).toMatch(/matchMedia\(MOTION_OK\)\.matches/)
  })

  it('pipeline cards glide only where motion is welcome, and a win bursts only there', () => {
    const board = read('components/pipeline/board.tsx')
    expect(read('components/motion/gsap.ts')).toMatch(/gsap\.registerPlugin\(Flip, /)
    // The glide is recorded only where motion is welcome; with nothing recorded, the board just changes.
    expect(board).toMatch(/if \(el && window\.matchMedia\(MOTION_OK\)\.matches\) flipFrom\.current = Flip\.getState/)
    expect(board.match(/if \(!window\.matchMedia\(MOTION_OK\)\.matches\) return/g)).toHaveLength(2)
    // A card is matched across columns by its deal, since React remounts it in its new column.
    expect(board).toMatch(/data-flip-id=\{deal\.id\}/)
    // The hover lift moves `translate`, so it never fights GSAP for `transform` mid-glide.
    expect(read('app/globals.css')).toMatch(/\.kcard:hover \{ translate: 0 -1px;/)
  })

  it('a slow page shows grey outlines, never content, and they lift when the address changes — query included', () => {
    const root = read('components/motion/motion-root.tsx')
    expect(root).toMatch(/<div ref=\{ref\} className="page-skeleton" aria-hidden="true">/)
    expect(root).toMatch(/const query = useSearchParams\(\)/)
    expect(root).toMatch(/<Suspense fallback=\{null\}>\s*<Arrivals onArrive=\{onArrive\} \/>/)
    expect(root).toMatch(/outline \? window\.setTimeout\(showOutline, SKELETON_AFTER_MS\) : 0/)
    const css = read('app/globals.css')
    expect(css).toMatch(/\.page-skeleton \{[^}]*pointer-events: none;/)
    expect(css).toMatch(/@media print \{\s*\.toaster, \.page-skeleton, \.confetti, \.theme-switch \{ display: none !important; \}/)
  })

  it('content waiting to rise into view is hidden by opacity alone — still focusable — and prints', () => {
    const root = read('components/motion/motion-root.tsx')
    const code = root.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/autoAlpha|visibility/)
    expect(root).toContain("classList.add('motion-pending')")
    const css = read('app/globals.css')
    expect(css).toMatch(/@media print \{[\s\S]*?\.motion-pending \{ opacity: 1 !important; transform: none !important; \}/)
  })

  it('a counter rewrites the text node React keeps, never replaces it', () => {
    const root = read('components/motion/motion-root.tsx')
    expect(root).toMatch(/node\.nodeValue = /)
    expect(root).not.toMatch(/\.textContent =|\.innerText =|\.innerHTML =/)
  })

  it('the stylesheet stops every transition and keyframe for a visitor who asked for less motion', () => {
    const css = read('app/globals.css')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{\s*animation-duration: \.01ms !important; animation-iteration-count: 1 !important;\s*transition-duration: \.01ms !important;/,
    )
    // The entrances themselves sit behind the opposite query.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\/\* A page's content settles in/)
  })

  it('a heading that waits hidden for its animation shows anyway when no script runs', () => {
    const css = read('app/globals.css')
    expect(css).toContain('.motion-ok [data-split]:not(.split-ready) { visibility: hidden; animation: shown-anyway 0s linear 1.6s forwards; }')
    expect(read('components/share/site-preview.tsx')).toContain('.motion-ok .sp:not(.sp-ready) { visibility: hidden; animation: sp-shown-anyway 0s linear 1.2s forwards; }')
    // And only where motion is allowed: the class is set from the same query, before the first paint.
    expect(read('app/layout.tsx')).toMatch(/matchMedia\('\(prefers-reduced-motion: no-preference\)'\)\.matches\)document\.documentElement\.classList\.add\('motion-ok'\)/)
    expect(read('app/layout.tsx')).toMatch(/strategy="beforeInteractive"/)
  })

  it('the sidebar moves between pages without reloading, and prefetches nothing', () => {
    const shell = read('components/shell.tsx')
    expect(shell).toContain("import Link from 'next/link'")
    expect(shell).toMatch(/<Link key=\{href\} href=\{href\} prefetch=\{false\}/)
    expect(shell).not.toMatch(/<a href="\/(companies|contacts|inbox|tasks|pipeline)"/)
  })
})
