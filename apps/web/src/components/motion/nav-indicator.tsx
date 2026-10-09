'use client'

import { useRef } from 'react'
import { MOTION_OK, gsap, useGSAP } from './gsap'

/**
 * Every page renders its own sidebar, so moving between pages mounts a new
 * one. These two outlive it — this module stays loaded across those moves,
 * and is forgotten on a full reload:
 *
 * - where the highlight was when a sidebar link was clicked, so the next
 *   page's sidebar slides it from there (only within `SLIDE_WINDOW_MS` of the
 *   click: a page reached any other way just shows its highlight);
 * - how far the sidebar was scrolled, so a long sidebar does not jump back
 *   to the top on every page.
 */
let slideFrom: { y: number; height: number; at: number } | null = null
let sidebarScroll = 0
const SLIDE_WINDOW_MS = 4000

/**
 * The highlight behind the sidebar's current page (2026-10-09): one shape
 * that slides from the page you were on to the page you went to. Before it
 * mounts — and wherever the menu is folded away — the current link's own
 * highlight stands in (`.nav.has-indicator` in globals.css), so nothing is
 * ever unmarked. It follows the `on` class the sidebar sets rather than the
 * address, because the sidebar decides which link a page lights (every
 * settings page lights Settings).
 */
export function NavIndicator() {
  const ref = useRef<HTMLSpanElement>(null)

  useGSAP(() => {
    const el = ref.current
    const nav = el?.parentElement
    if (!el || !nav) return
    const side = nav.closest<HTMLElement>('.side')
    if (side) side.scrollTop = sidebarScroll
    const from = slideFrom && performance.now() - slideFrom.at < SLIDE_WINDOW_MS ? slideFrom : null
    let placed = false
    let current: { y: number; height: number } | null = null
    const place = () => {
      const on = nav.querySelector<HTMLElement>('a.on')
      if (!on || on.offsetParent === null) {
        // Nothing to slide to (the menu is folded away): the link's own highlight shows instead.
        gsap.set(el, { opacity: 0 })
        nav.classList.remove('has-indicator')
        placed = false
        return
      }
      const to = { y: on.offsetTop, height: on.offsetHeight, opacity: 1 }
      const moving = window.matchMedia(MOTION_OK).matches
      if (placed && moving) gsap.to(el, { ...to, duration: 0.5, ease: 'power3.out', overwrite: true })
      else if (!placed && moving && from && from.y !== to.y) {
        gsap.fromTo(el, { y: from.y, height: from.height, opacity: 1 }, { ...to, duration: 0.55, ease: 'power3.out', overwrite: true })
      } else gsap.set(el, to)
      nav.classList.add('has-indicator')
      placed = true
      current = { y: to.y, height: to.height }
    }
    place()
    const clicked = (e: MouseEvent) => {
      if (current && e.target instanceof Element && e.target.closest('a')) slideFrom = { ...current, at: performance.now() }
    }
    const scrolled = () => {
      if (side) sidebarScroll = side.scrollTop
    }
    nav.addEventListener('click', clicked)
    side?.addEventListener('scroll', scrolled, { passive: true })
    // The sidebar moves its `on` class; showing a folded menu gives the link a place to measure.
    const moved = new MutationObserver((records) => {
      if (records.some((r) => r.target !== nav)) place()
    })
    moved.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] })
    const resized = new ResizeObserver(() => {
      if (!placed) place()
    })
    resized.observe(nav)
    return () => {
      nav.removeEventListener('click', clicked)
      side?.removeEventListener('scroll', scrolled)
      moved.disconnect()
      resized.disconnect()
      nav.classList.remove('has-indicator')
    }
  }, [])

  return <span ref={ref} className="nav-indicator" aria-hidden="true" />
}
