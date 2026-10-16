/**
 * Light, dark or the system's (2026-10-09): the stored choice, the line that
 * applies it before the first paint, the stylesheet that reads it, and the
 * switch that sets it — which must all agree.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEMES, THEME_BEFORE_PAINT, THEME_KEY, themeFrom } from '../src/lib/theme'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

/** Runs the before-paint line against a stored value and a document element of our own. */
function paint(stored: string | null, opts: { blocked?: boolean } = {}): string | null {
  let theme: string | null = null
  const localStorage = {
    getItem: (k: string) => {
      if (opts.blocked) throw new Error('blocked')
      return k === THEME_KEY ? stored : null
    },
  }
  const document = { documentElement: { setAttribute: (name: string, v: string) => { if (name === 'data-theme') theme = v } } }
  new Function('localStorage', 'document', THEME_BEFORE_PAINT)(localStorage, document)
  return theme
}

describe('the stored choice', () => {
  it('is light, dark, or — for anything else — the system', () => {
    expect(THEMES).toEqual(['system', 'light', 'dark'])
    expect(themeFrom('light')).toBe('light')
    expect(themeFrom('dark')).toBe('dark')
    for (const v of [null, undefined, '', 'system', 'Dark', 'blue']) expect(themeFrom(v)).toBe('system')
  })

  it('is applied before the first paint, and nothing else is', () => {
    expect(paint('dark')).toBe('dark')
    expect(paint('light')).toBe('light')
    expect(paint(null)).toBeNull()
    expect(paint('<script>')).toBeNull()
    expect(paint('dark', { blocked: true })).toBeNull()
  })

  it('runs from the root layout, before anything React renders', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toMatch(/<Script id="theme" strategy="beforeInteractive">\s*\{THEME_BEFORE_PAINT\}\s*<\/Script>/)
  })
})

describe('the stylesheet reads it', () => {
  const css = read('app/globals.css')
  const block = (re: RegExp): string => {
    const m = re.exec(css)
    expect(m, String(re)).not.toBeNull()
    return (m?.[1] ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
  }

  it('dark for the system unless Light was picked, dark whenever Dark was — the same tokens both ways', () => {
    const bySystem = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)
    const byChoice = block(/:root\[data-theme="dark"\] \{([^}]*)\}/)
    expect(bySystem).toBe(byChoice)
    expect(byChoice).toContain('color-scheme: dark;')
    expect(byChoice).toContain('--bg: #0e0e11;')
  })

  it('says which scheme native controls should draw in', () => {
    expect(block(/^:root \{([^}]*)\}/m)).toContain('color-scheme: light;')
  })

  it('has no other dark-mode rule that would ignore a choice of Light', () => {
    expect(css.match(/prefers-color-scheme: dark/g)).toHaveLength(1)
  })
})

describe('the switch', () => {
  const src = read('components/theme/theme-switch.tsx')

  it('keeps the choice under the same key the before-paint line reads', () => {
    expect(src).toContain("import { THEMES, THEME_KEY, themeFrom, type Theme } from '../../lib/theme'")
    expect(src).toMatch(/localStorage\.setItem\(THEME_KEY, next\)/)
    expect(src).toMatch(/localStorage\.removeItem\(THEME_KEY\)/)
  })

  it('animates the change only where motion is welcome, and changes it anyway', () => {
    expect(src).toMatch(/!doc\.startViewTransition \|\| !window\.matchMedia\(MOTION_OK\)\.matches/)
  })

  it('sits under the person’s name in every signed-in page’s sidebar', () => {
    expect(read('components/shell.tsx')).toMatch(/<ThemeSwitch \/>\s*<form action=\{signOut\}>/)
  })
})
