/**
 * Pop-up confirmations (2026-10-09): the channel every client component
 * raises a toast through, how long one stays, how one survives a page that
 * reloads itself, and what the toaster's source must keep promising.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TOAST_AFTER_RELOAD_KEY,
  TOAST_CARRY_MS,
  TOAST_MAX_CHARS,
  TOAST_MAX_SHOWN,
  carryToasts,
  forgetCarriedToasts,
  onToast,
  showCarried,
  takeToastsAfterReload,
  toast,
  toastLifeMs,
  type ToastItem,
} from '../src/components/toast/toast'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

/** A session storage of our own: Node has none. */
function fakeSession(start: Record<string, string> = {}): Map<string, string> {
  const m = new Map(Object.entries(start))
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
  return m
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage
})

describe('the toast channel', () => {
  it('hands each toast to the toaster, success by default, with its tone and a fresh id', () => {
    const seen: ToastItem[] = []
    const off = onToast((t) => seen.push(t))
    toast('Saved.')
    toast.error('That did not save.')
    toast.info('Asked for.')
    off()
    expect(seen.map((t) => [t.tone, t.message])).toEqual([
      ['success', 'Saved.'],
      ['error', 'That did not save.'],
      ['info', 'Asked for.'],
    ])
    expect(new Set(seen.map((t) => t.id)).size).toBe(3)
  })

  it('keeps what was raised before the toaster mounted, and only the newest few', () => {
    for (let i = 1; i <= TOAST_MAX_SHOWN + 2; i++) toast.success(`Early ${i}.`)
    const seen: string[] = []
    const off = onToast((t) => seen.push(t.message))
    off()
    expect(seen).toEqual(Array.from({ length: TOAST_MAX_SHOWN }, (_, i) => `Early ${i + 3}.`))
    // Taken once: a second toaster does not show them again.
    const again: string[] = []
    onToast((t) => again.push(t.message))()
    expect(again).toEqual([])
  })

  it('shows one line of plain text: whitespace folded, nothing blank, nothing endless', () => {
    const seen: string[] = []
    const off = onToast((t) => seen.push(t.message))
    toast.success('  Saved.\n\n  New quotes use it.  ')
    toast.success('   ')
    toast.success('x'.repeat(TOAST_MAX_CHARS + 50))
    off()
    expect(seen[0]).toBe('Saved. New quotes use it.')
    expect(seen).toHaveLength(2)
    expect([...(seen[1] ?? '')]).toHaveLength(TOAST_MAX_CHARS)
    expect(seen[1]?.endsWith('…')).toBe(true)
  })

  it('stays long enough to read: longer for more words, longer again for a fault, never for ever', () => {
    expect(toastLifeMs({ tone: 'success', message: 'Saved.' })).toBeGreaterThanOrEqual(3_500)
    expect(toastLifeMs({ tone: 'success', message: 'x'.repeat(60) })).toBeGreaterThan(toastLifeMs({ tone: 'success', message: 'Saved.' }))
    expect(toastLifeMs({ tone: 'success', message: 'x'.repeat(TOAST_MAX_CHARS) })).toBe(9_000)
    expect(toastLifeMs({ tone: 'error', message: 'No.' })).toBeGreaterThan(toastLifeMs({ tone: 'success', message: 'No.' }))
    expect(toastLifeMs({ tone: 'error', message: 'x'.repeat(TOAST_MAX_CHARS) })).toBe(12_000)
  })
})

describe('a toast across a page that reloads itself', () => {
  it('is kept for the next page, read once, then gone', () => {
    const store = fakeSession()
    toast.afterReload('Renamed to Accemy.')
    expect(store.has(TOAST_AFTER_RELOAD_KEY)).toBe(true)
    expect(takeToastsAfterReload()).toEqual([{ message: 'Renamed to Accemy.', tone: 'success' }])
    expect(takeToastsAfterReload()).toEqual([])
    expect(store.has(TOAST_AFTER_RELOAD_KEY)).toBe(false)
  })

  it('carries what was on screen, beside what an action asked for, once each and the newest few', () => {
    fakeSession()
    const now = 1_000_000
    toast.afterReload('Saved.')
    carryToasts([{ message: 'Saved.', tone: 'success' }, { message: 'Note added.', tone: 'success' }], now)
    expect(takeToastsAfterReload(now).map((t) => t.message)).toEqual(['Saved.', 'Note added.'])
    carryToasts(Array.from({ length: TOAST_MAX_SHOWN + 3 }, (_, i) => ({ message: `T${i}`, tone: 'info' as const })), now)
    expect(takeToastsAfterReload(now)).toHaveLength(TOAST_MAX_SHOWN)
  })

  it('drops toasts an old visit left, and anything else in that slot', () => {
    fakeSession()
    carryToasts([{ message: 'Saved.', tone: 'success' }], 1_000)
    expect(takeToastsAfterReload(1_000 + TOAST_CARRY_MS + 1)).toEqual([])
    fakeSession({ [TOAST_AFTER_RELOAD_KEY]: 'not json' })
    expect(takeToastsAfterReload()).toEqual([])
    fakeSession({ [TOAST_AFTER_RELOAD_KEY]: JSON.stringify({ at: Date.now(), toasts: [{ message: 4 }, { message: 'Done.', tone: 'party' }] }) })
    expect(takeToastsAfterReload()).toEqual([{ message: 'Done.', tone: 'success' }])
  })

  it('shows a carried toast marked as carried, so it appears in place', () => {
    const seen: ToastItem[] = []
    const off = onToast((t) => seen.push(t))
    showCarried({ message: 'Saved.', tone: 'success' })
    toast.success('Fresh.')
    off()
    expect(seen.map((t) => [t.message, t.carried === true])).toEqual([['Saved.', true], ['Fresh.', false]])
  })

  it('forgets them for a page the browser kept, whose toasts are still on screen', () => {
    const store = fakeSession()
    toast.afterReload('Saved.')
    forgetCarriedToasts()
    expect(store.has(TOAST_AFTER_RELOAD_KEY)).toBe(false)
  })

  it('costs nothing but the toast where storage is blocked', () => {
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => toast.afterReload('Saved.')).not.toThrow()
    expect(takeToastsAfterReload()).toEqual([])
  })
})

describe('the toaster keeps its promises', () => {
  const src = read('components/toast/toaster.tsx')

  it('is mounted once, in the root layout, so it outlives every move between pages', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toContain("import { Toaster } from '@/components/toast/toaster'")
    expect(layout.match(/<Toaster \/>/g)).toHaveLength(1)
  })

  it('announces each toast politely, and moves only where motion is welcome', () => {
    expect(src).toMatch(/aria-live="polite"/)
    expect(src).toMatch(/window\.matchMedia\(MOTION_OK\)\.matches/)
    expect(src).toMatch(/aria-label="Dismiss"/)
  })

  it('holds every clock while the stack is hovered or focused', () => {
    expect(src).toMatch(/onPointerEnter=\{\(\) => hold\(true\)\}/)
    expect(src).toMatch(/onFocus=\{\(\) => hold\(true\)\}/)
    expect(src).toMatch(/clock\.pause\(\)/)
  })

  it('says when the connection drops and when it is back', () => {
    expect(src).toMatch(/window\.addEventListener\('offline', offline\)/)
    expect(src).toMatch(/window\.addEventListener\('online', online\)/)
    expect(src).toMatch(/const offline = \(\) => toast\.error\(OFFLINE_WORDS\)/)
  })

  it('shows what a page left before it reloaded, and keeps what is on screen when a page goes away', () => {
    expect(src).toMatch(/for \(const t of takeToastsAfterReload\(\)\) showCarried\(t\)/)
    expect(src).toMatch(/if \(!item\.carried\) capture\(\)/)
    expect(src).toMatch(/window\.addEventListener\('pagehide', leaving\)/)
  })
})

describe('the approval pop-up', () => {
  it('says approved, never sent, and is short enough to read whole', async () => {
    const { approvedToast } = await import('../src/lib/approval-view')
    for (const channel of ['email', 'sms', 'linkedin']) {
      for (const note of [null, 'No worker is configured.']) {
        const words = approvedToast(channel, note)
        expect(words.startsWith('Approved'), words).toBe(true)
        expect([...words].length, words).toBeLessThanOrEqual(TOAST_MAX_CHARS)
        expect(words, words).not.toMatch(/\bwill send\b|(?<!nothing )\bwas sent\b|\bsent it\b/i)
      }
    }
    expect(approvedToast('linkedin', null)).toContain('nothing was sent')
  })
})
