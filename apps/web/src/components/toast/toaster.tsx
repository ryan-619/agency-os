'use client'

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Flip, MOTION_OK, gsap } from '../motion/gsap'
import { TOAST_MAX_SHOWN, carryToasts, forgetCarriedToasts, onToast, showCarried, takeToastsAfterReload, toastLifeMs, type ToastItem } from './toast'

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const

/**
 * Where pop-up confirmations appear (2026-10-09), mounted once in the root
 * layout so it outlives every move between pages: a stack in the bottom
 * corner, newest nearest the corner.
 *
 * A toast springs in, the others make room for it (Flip), it leaves on its
 * own after `toastLifeMs` — the shrinking line along its foot is that
 * clock — or when dismissed, and the stack closes up behind it. Hovering or
 * focusing the stack holds every clock, so nothing leaves while being read.
 * A toast still on screen when the page reloads — most forms here reload
 * as soon as they save — is shown again on the page that loads next.
 * The list is a polite live region that exists before any toast, so a
 * screen reader announces each one as it is added. With reduced motion the
 * same toasts appear and leave without moving.
 */
export function Toaster() {
  const [items, setItems] = useState<readonly ToastItem[]>([])
  const list = useRef<HTMLOListElement>(null)
  const flip = useRef<Flip.FlipState | null>(null)
  const clocks = useRef(new Map<number, gsap.core.Tween>())
  /** What is on screen, kept in step with every toast added or dismissed — what `pagehide` carries over. */
  const live = useRef<readonly ToastItem[]>([])
  const held = useRef(false)

  /** Where every toast is now, so the next render can glide them from here. */
  const capture = useCallback(() => {
    const el = list.current
    if (el && window.matchMedia(MOTION_OK).matches) flip.current = Flip.getState(el.querySelectorAll('.toast'))
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      live.current = live.current.filter((x) => x.id !== id)
      clocks.current.get(id)?.kill()
      clocks.current.delete(id)
      const gone = () => {
        capture()
        setItems((xs) => xs.filter((x) => x.id !== id))
      }
      const el = list.current?.querySelector<HTMLElement>(`[data-toast="${id}"]`)
      if (el && window.matchMedia(MOTION_OK).matches) {
        gsap.to(el, { x: 56, opacity: 0, scale: 0.94, duration: 0.3, ease: 'power2.in', overwrite: true, onComplete: gone })
      } else gone()
    },
    [capture],
  )

  useEffect(() => {
    const off = onToast((item) => {
      live.current = [...live.current, item].slice(-TOAST_MAX_SHOWN)
      // A toast carried over a reload was already seen arriving: it appears in place.
      if (!item.carried) capture()
      setItems((xs) => [...xs, item].slice(-TOAST_MAX_SHOWN))
    })
    // What the page before this one left on screen, or asked to say once it had reloaded.
    for (const t of takeToastsAfterReload()) showCarried(t)
    // A page about to be replaced keeps what is still on screen for the next one; a page the browser
    // kept and shows again still has them, so nothing waits.
    const leaving = () => carryToasts(live.current)
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) forgetCarriedToasts()
    }
    window.addEventListener('pagehide', leaving)
    window.addEventListener('pageshow', back)
    return () => {
      off()
      window.removeEventListener('pagehide', leaving)
      window.removeEventListener('pageshow', back)
    }
  }, [capture])

  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    // A clock for each new toast; a toast pushed out by a newer one takes its clock with it.
    for (const item of items) {
      if (clocks.current.has(item.id)) continue
      const bar = el.querySelector<HTMLElement>(`[data-toast="${item.id}"] .toast-life`)
      if (!bar) continue
      const clock = gsap.fromTo(bar, { scaleX: 1 }, { scaleX: 0, duration: toastLifeMs(item) / 1000, ease: 'none', onComplete: () => dismiss(item.id) })
      if (held.current) clock.pause()
      clocks.current.set(item.id, clock)
    }
    for (const [id, clock] of clocks.current) {
      if (!items.some((i) => i.id === id)) {
        clock.kill()
        clocks.current.delete(id)
      }
    }
    const state = flip.current
    flip.current = null
    if (!state) return
    Flip.from(state, {
      targets: el.querySelectorAll('.toast'),
      duration: 0.45,
      ease: 'power3.out',
      onEnter: (entering) =>
        gsap.fromTo(entering, { y: 26, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(1.6)' }),
    })
  }, [items, dismiss])

  useEffect(() => {
    const running = clocks.current
    return () => {
      for (const clock of running.values()) clock.kill()
    }
  }, [])

  const hold = (on: boolean) => {
    held.current = on
    for (const clock of clocks.current.values()) {
      if (on) clock.pause()
      else clock.resume()
    }
  }

  return (
    <section className="toaster" aria-label="Notifications">
      <ol
        ref={list}
        aria-live="polite"
        onPointerEnter={() => hold(true)}
        onPointerLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold(false)
        }}
      >
        {items.map((item) => {
          const Icon = ICON[item.tone]
          return (
            <li key={item.id} className={`toast toast-${item.tone}`} data-toast={item.id} data-flip-id={`toast-${item.id}`}>
              <Icon className="toast-icon" aria-hidden="true" />
              <p className="toast-text">{item.message}</p>
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
                <X aria-hidden="true" />
              </button>
              <span className="toast-life" aria-hidden="true" />
            </li>
          )
        })}
      </ol>
    </section>
  )
}
