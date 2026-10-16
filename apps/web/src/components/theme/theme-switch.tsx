'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState, type MouseEvent } from 'react'
import { THEMES, THEME_KEY, themeFrom, type Theme } from '../../lib/theme'
import { MOTION_OK } from '../motion/gsap'

const LABEL: Record<Theme, string> = { system: 'Match this device', light: 'Light', dark: 'Dark' }
const ICON = { system: Monitor, light: Sun, dark: Moon } as const

/** The browser's View Transitions, where it has them: one call that crossfades or reveals the whole page. */
type WithTransitions = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> } }

/** What this page has learned the choice is, kept across the moves between pages that remount the sidebar. */
let known: Theme | null = null

function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/**
 * Light, dark, or whatever this device is set to (2026-10-09), under the
 * person's name in the sidebar. The choice is kept in this browser
 * (`THEME_KEY`) and applied before the first paint of every page
 * (layout.tsx), the client pages included, so nothing flashes. Where the
 * browser can, the new look opens out in a circle from the button that
 * chose it; otherwise, and for anybody who asked for less motion, it just
 * changes.
 */
export function ThemeSwitch() {
  // The server cannot know the stored choice, so a page's first render says "system" and the effect corrects
  // it; every page renders its own sidebar, and a later one starts from what this module already learned.
  const [theme, setTheme] = useState<Theme>(known ?? 'system')
  // The pill slides only between choices a person makes, never into place as the page opens.
  const [ready, setReady] = useState(known !== null)
  useEffect(() => {
    try {
      known = themeFrom(localStorage.getItem(THEME_KEY))
    } catch {
      known = 'system' // Storage blocked: the system's choice it is.
    }
    setTheme(known)
    const frame = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const choose = (next: Theme, e: MouseEvent<HTMLButtonElement>) => {
    if (next === theme) return
    known = next
    setTheme(next)
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // Not kept past this page, but still applied to it.
    }
    const doc = document as WithTransitions
    if (!doc.startViewTransition || !window.matchMedia(MOTION_OK).matches) {
      apply(next)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    const root = document.documentElement
    root.classList.add('theme-transition')
    const t = doc.startViewTransition(() => apply(next))
    t.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`] },
          { duration: 560, easing: 'cubic-bezier(.22, 1, .36, 1)', pseudoElement: '::view-transition-new(root)' },
        )
      })
      .catch(() => {})
    t.finished.finally(() => root.classList.remove('theme-transition')).catch(() => {})
  }

  return (
    <div
      className={`theme-switch${ready ? ' ready' : ''}`}
      role="group"
      aria-label="Colour theme"
      style={{ ['--at' as string]: THEMES.indexOf(theme) }}
    >
      <span className="theme-switch-pill" aria-hidden="true" />
      {THEMES.map((t) => {
        const Icon = ICON[t]
        return (
          <button key={t} type="button" className="theme-option" aria-pressed={theme === t} aria-label={LABEL[t]} title={LABEL[t]} onClick={(e) => choose(t, e)}>
            <Icon aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
