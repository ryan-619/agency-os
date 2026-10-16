/**
 * Light, dark or the system's (2026-10-09). Pure, so `apps/web/test` reads it
 * directly: the names, where the choice is kept, and the line that applies it
 * before the first paint (layout.tsx), which must agree with the switch
 * (theme-switch.tsx) about both.
 */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/** Where a person's choice is kept: this browser only, and nothing else is stored with it. */
export const THEME_KEY = 'agency-os:theme'

/** A stored value read back: anything but light or dark is the system's choice. */
export function themeFrom(stored: string | null | undefined): Theme {
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/**
 * Runs in the document head before anything is painted, so a page never
 * flashes the other theme: a stored light or dark becomes `data-theme` on
 * <html>, and globals.css reads it. Storage that cannot be read (a private
 * window, blocked site data) leaves the system's choice in charge.
 */
export const THEME_BEFORE_PAINT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`
