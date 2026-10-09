/**
 * Pop-up confirmations (2026-10-09): `toast.success('Saved')` from any client
 * component, shown by the one `<Toaster />` in the root layout. A plain
 * module-level channel rather than a React context, so a handler deep in any
 * component can confirm what it did without threading anything through.
 *
 * A toast says what just happened; anything a person has to act on, or
 * read again later, stays on the page where it was.
 */
export type ToastTone = 'success' | 'error' | 'info'

export interface ToastItem {
  readonly id: number
  readonly tone: ToastTone
  readonly message: string
  /** Shown on the page before a reload and carried over it: it appears in place, without springing in again. */
  readonly carried?: boolean
}

type Listener = (item: ToastItem) => void

const listeners = new Set<Listener>()
/** Raised before the toaster mounted: shown as soon as it does. */
const waiting: ToastItem[] = []
let next = 1

/** The longest message a toast shows; the page keeps the whole of anything longer. */
export const TOAST_MAX_CHARS = 220

/** At most this many at once: a fifth pushes the oldest out. */
export const TOAST_MAX_SHOWN = 4

/**
 * How long a toast stays, in ms: long enough to read at an unhurried pace —
 * longer for a longer message, and longer again for something that went
 * wrong. Hovering or focusing the stack holds every toast where it is.
 */
export function toastLifeMs(item: Pick<ToastItem, 'message' | 'tone'>): number {
  const chars = [...item.message].length
  const [floor, ceiling] = item.tone === 'error' ? [6_000, 12_000] : [3_500, 9_000]
  return Math.min(ceiling, Math.max(floor, floor + chars * 45))
}

function emit(message: string, tone: ToastTone, carried = false): void {
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text) return
  const item: ToastItem = {
    id: next++,
    tone,
    message: [...text].length > TOAST_MAX_CHARS ? `${[...text].slice(0, TOAST_MAX_CHARS - 1).join('')}…` : text,
    ...(carried ? { carried: true } : {}),
  }
  if (listeners.size === 0) {
    waiting.push(item)
    if (waiting.length > TOAST_MAX_SHOWN) waiting.shift()
    return
  }
  for (const l of listeners) l(item)
}

/** Where toasts wait across a page reload: this tab only, read once and removed. */
export const TOAST_AFTER_RELOAD_KEY = 'agency-os:toasts-next'

/** Kept toasts older than this are an old visit's, not this reload's, and are dropped unread. */
export const TOAST_CARRY_MS = 30_000

interface Carried {
  readonly message: string
  readonly tone: ToastTone
}

function readCarried(now: number): Carried[] {
  try {
    const raw = sessionStorage.getItem(TOAST_AFTER_RELOAD_KEY)
    if (raw === null) return []
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return []
    const { at, toasts } = v as { at?: unknown; toasts?: unknown }
    if (typeof at !== 'number' || !(now - at <= TOAST_CARRY_MS && now >= at) || !Array.isArray(toasts)) return []
    const out: Carried[] = []
    for (const t of toasts as unknown[]) {
      if (typeof t !== 'object' || t === null) continue
      const { message, tone } = t as { message?: unknown; tone?: unknown }
      if (typeof message !== 'string') continue
      out.push({ message, tone: tone === 'error' || tone === 'info' ? tone : 'success' })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Keeps toasts for the page that loads next in this tab — a reload, or a
 * form that sends the browser to another page. Two ways in: an action that
 * reloads its page as soon as it succeeds says so (`toast.afterReload`), and
 * the toaster keeps whatever is still on screen when the page goes away, so
 * a toast raised a moment before `location.reload()` is read on the page
 * after it rather than flashing. Storage that cannot be written costs the
 * toast, never the action.
 */
export function carryToasts(toasts: readonly Carried[], now = Date.now()): void {
  if (toasts.length === 0) return
  try {
    const kept = readCarried(now)
    const all = [...kept, ...toasts.filter((t) => !kept.some((k) => k.message === t.message && k.tone === t.tone))]
    sessionStorage.setItem(TOAST_AFTER_RELOAD_KEY, JSON.stringify({ at: now, toasts: all.slice(-TOAST_MAX_SHOWN) }))
  } catch {
    // No toast after the reload; the action itself is done.
  }
}

function afterReload(message: string, tone: ToastTone = 'success'): void {
  carryToasts([{ message, tone }])
}

/** For the toaster: shows a toast an earlier page carried over, in place. */
export function showCarried(t: Carried): void {
  emit(t.message, t.tone, true)
}

/** For the toaster, once: the toasts an earlier page in this tab left for this one. */
export function takeToastsAfterReload(now = Date.now()): Carried[] {
  const out = readCarried(now)
  forgetCarriedToasts()
  return out
}

/** A page the browser kept and showed again has its toasts still on screen: nothing is waiting for a reload. */
export function forgetCarriedToasts(): void {
  try {
    sessionStorage.removeItem(TOAST_AFTER_RELOAD_KEY)
  } catch {
    // Nothing to forget.
  }
}

export const toast = Object.assign((message: string, tone: ToastTone = 'success') => emit(message, tone), {
  success: (message: string) => emit(message, 'success'),
  error: (message: string) => emit(message, 'error'),
  info: (message: string) => emit(message, 'info'),
  afterReload,
})

/** For the toaster: every toast from now on, starting with any raised before it mounted. */
export function onToast(listener: Listener): () => void {
  listeners.add(listener)
  for (const item of waiting.splice(0)) listener(item)
  return () => {
    listeners.delete(listener)
  }
}
