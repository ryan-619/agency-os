'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef } from 'react'
import { countPlan, formatCount, outlinesFor, startsNavigation } from '@/lib/motion-rules'
import { FINE_POINTER, MOTION_OK, ScrollTrigger, SplitText, gsap, useGSAP } from './gsap'

/**
 * The motion every page shares (2026-10-09), mounted once in the root layout:
 *
 * - content below the fold rises into view as it is scrolled to (never
 *   content already on screen, which would flash: that gets the stylesheet's
 *   entrance instead);
 * - plain numbers on cards count up from zero to exactly the text the page
 *   was rendered with;
 * - a heading marked `data-split` reveals word by word;
 * - a button marked `data-magnetic` leans toward a mouse pointer;
 * - every button press ripples out from where it was pressed;
 * - a thin bar at the top shows a page is on its way, from the click until
 *   it arrives — and when it takes longer than a moment, grey outlines of a
 *   page stand where the page will be (`.page-skeleton`), so a slow page
 *   never looks like a click that did nothing;
 * - a long document read by a client (`data-read-progress`) shows how far
 *   down it the reader is.
 *
 * All of it is decoration over pages that work without it: none of it runs
 * for a visitor who asked their system for less motion (`MOTION_OK`), a
 * hidden element stays focusable (opacity, never visibility), and printing
 * shows everything (`.motion-pending` in globals.css).
 */

/** What rises into view when scrolled to. A match inside another match rises with its parent. */
export const REVEAL_SELECTOR = [
  '[data-reveal]',
  '.main .card',
  '.main .row-card',
  '.main .note',
  '.main .catalog-card',
  '.main .kcard',
  '.main .touch',
  '.main table',
  '.main .brief > *',
  '.main .timeline-item',
  '.main .inbox-row',
  '.main .task-row',
  '.report-section',
  '.report-score',
  '.quote-lines tbody tr',
  '.buyer .proposal section',
].join(', ')

/** What counts up from zero, when its whole text is one plain number. */
export const COUNT_SELECTOR = '.main .card .n, .report-score-n, [data-count]'

/** A page is late, not loading, after this: the bar fades rather than creep for ever. */
const PROGRESS_GIVE_UP_MS = 15_000

/** A page that arrives sooner than this never shows its outlines, so a quick move does not flash. */
export const SKELETON_AFTER_MS = 220

/**
 * Tells MotionRoot each time the address — path AND query — changes. Apart
 * from MotionRoot because reading the query needs a Suspense boundary;
 * without the query, a move to the same page with other filters (the next
 * page of /companies) never said it had arrived, and the bar crept on.
 */
function Arrivals({ onArrive }: { readonly onArrive: (at: string) => void }) {
  const pathname = usePathname()
  const query = useSearchParams()
  const at = `${pathname}?${query.toString()}`
  useEffect(() => onArrive(at), [at, onArrive])
  return null
}

function revealOnScroll(): () => void {
  const fold = window.innerHeight * 0.95
  const els = gsap.utils
    .toArray<HTMLElement>(REVEAL_SELECTOR)
    .filter((el) => !el.parentElement?.closest(REVEAL_SELECTOR) && el.getBoundingClientRect().top > fold)
  if (els.length === 0) return () => {}
  for (const el of els) el.classList.add('motion-pending')
  gsap.set(els, { opacity: 0, y: 28 })
  ScrollTrigger.batch(els, {
    start: 'top 92%',
    once: true,
    onEnter: (batch) => {
      gsap.to(batch, {
        opacity: 1,
        y: 0,
        duration: 0.75,
        ease: 'power3.out',
        stagger: 0.07,
        overwrite: true,
        onComplete: () => {
          for (const el of batch) el.classList.remove('motion-pending')
          gsap.set(batch, { clearProps: 'opacity,transform' })
        },
      })
    },
  })
  return () => {
    for (const el of els) el.classList.remove('motion-pending')
  }
}

function countUp(): () => void {
  const restore: Array<() => void> = []
  for (const el of gsap.utils.toArray<HTMLElement>(COUNT_SELECTOR)) {
    const node = el.firstChild
    // Only an element whose one child is its text: React keeps that node, so it is rewritten, never replaced.
    if (!node || node.nodeType !== Node.TEXT_NODE || el.childNodes.length !== 1) continue
    const original = node.nodeValue ?? ''
    const plan = countPlan(original)
    if (!plan || plan.to === 0) continue
    const state = { value: 0 }
    let written = formatCount(0, plan)
    node.nodeValue = written
    const tween = gsap.to(state, {
      value: plan.to,
      duration: Math.min(1.5, 0.7 + Math.log10(plan.to + 1) * 0.22),
      ease: 'power2.out',
      paused: true,
      onUpdate: () => {
        // React rewrote it meanwhile (a refresh): its value stands.
        if (node.nodeValue !== written) {
          tween.kill()
          return
        }
        written = formatCount(state.value, plan)
        node.nodeValue = written
      },
      onComplete: () => {
        if (node.nodeValue === written) node.nodeValue = original
      },
    })
    ScrollTrigger.create({ trigger: el, start: 'top 96%', once: true, onEnter: () => void tween.play() })
    restore.push(() => {
      tween.kill()
      if (node.nodeValue === written) node.nodeValue = original
    })
  }
  return () => {
    for (const r of restore) r()
  }
}

function splitHeadings(): () => void {
  for (const el of gsap.utils.toArray<HTMLElement>('[data-split]')) {
    const split = SplitText.create(el, { type: 'words', mask: 'words' })
    el.classList.add('split-ready')
    // Once risen, the words go back to being plain text: nothing left to clip a descender or to re-split on resize.
    gsap.from(split.words, { yPercent: 115, duration: 1.05, ease: 'expo.out', stagger: 0.06, delay: 0.08, onComplete: () => split.revert() })
  }
  return () => {
    for (const el of gsap.utils.toArray<HTMLElement>('[data-split]')) el.classList.remove('split-ready')
  }
}

function readingProgress(bar: HTMLElement | null): () => void {
  if (!bar || !document.querySelector('[data-read-progress]')) return () => {}
  gsap.set(bar, { opacity: 1, scaleX: 0 })
  ScrollTrigger.create({
    start: 0,
    end: 'max',
    onUpdate: (self) => gsap.set(bar, { scaleX: self.progress }),
  })
  return () => {
    gsap.set(bar, { opacity: 0, scaleX: 0 })
  }
}

function magnetic(): () => void {
  const off: Array<() => void> = []
  for (const el of gsap.utils.toArray<HTMLElement>('[data-magnetic]')) {
    const toX = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' })
    const toY = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' })
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      toX((e.clientX - (r.left + r.width / 2)) * 0.22)
      toY((e.clientY - (r.top + r.height / 2)) * 0.32)
    }
    const leave = () => {
      toX(0)
      toY(0)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    off.push(() => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    })
  }
  return () => {
    for (const f of off) f()
  }
}

export function MotionRoot() {
  const pathname = usePathname()
  const loading = useRef<HTMLDivElement>(null)
  const reading = useRef<HTMLDivElement>(null)
  const skeleton = useRef<HTMLDivElement>(null)

  // What belongs to one page, set up afresh when the page changes.
  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION_OK, () => {
        const undo = [splitHeadings(), revealOnScroll(), countUp(), readingProgress(reading.current)]
        return () => {
          for (const u of undo) u()
        }
      })
      mm.add(`${MOTION_OK} and ${FINE_POINTER}`, () => magnetic())
      // Fonts and images move things after the first measure.
      const late = window.setTimeout(() => ScrollTrigger.refresh(), 600)
      return () => window.clearTimeout(late)
    },
    { dependencies: [pathname], revertOnUpdate: true },
  )

  // A press ripples from where it landed, on any button but a text-only one.
  useEffect(() => {
    const ok = window.matchMedia(MOTION_OK)
    const onDown = (e: PointerEvent) => {
      if (!ok.matches || e.button !== 0) return
      const host = e.target instanceof Element ? e.target.closest<HTMLElement>('button, .button-like, .sp-btn, [data-ripple]') : null
      if (!host || host.matches('.linkish, .link-like, :disabled, [aria-disabled="true"]')) return
      const r = host.getBoundingClientRect()
      const size = Math.max(r.width, r.height) * 2.2
      const dot = document.createElement('span')
      dot.className = 'ripple'
      dot.setAttribute('aria-hidden', 'true')
      dot.style.width = `${size}px`
      dot.style.height = `${size}px`
      dot.style.left = `${e.clientX - r.left - size / 2}px`
      dot.style.top = `${e.clientY - r.top - size / 2}px`
      host.appendChild(dot)
      gsap.fromTo(dot, { scale: 0, opacity: 0.32 }, { scale: 1, opacity: 0, duration: 0.65, ease: 'power2.out', onComplete: () => dot.remove() })
    }
    document.addEventListener('pointerdown', onDown, { passive: true })
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  // The loading bar, and the page's outlines when it is slow: start on a click that loads another page.
  const pending = useRef<{ giveUp: number; outline: number } | null>(null)
  const arrivedAt = useRef<string | null>(null)

  const hideOutline = useCallback((instantly: boolean) => {
    const sk = skeleton.current
    if (!sk) return
    gsap.killTweensOf(sk)
    if (instantly || !window.matchMedia(MOTION_OK).matches) gsap.set(sk, { opacity: 0 })
    else gsap.to(sk, { opacity: 0, duration: 0.18, ease: 'power1.out' })
  }, [])

  const settle = useCallback(() => {
    if (pending.current) {
      window.clearTimeout(pending.current.giveUp)
      window.clearTimeout(pending.current.outline)
      pending.current = null
    }
  }, [])

  useEffect(() => {
    const bar = loading.current
    const sk = skeleton.current
    if (!bar || !sk) return
    const showOutline = () => {
      const main = document.querySelector<HTMLElement>('.main')
      if (!main) return
      const r = main.getBoundingClientRect()
      gsap.set(sk, { left: r.left, width: r.width, top: Math.max(r.top, 0) })
      if (window.matchMedia(MOTION_OK).matches) gsap.fromTo(sk, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power1.out' })
      else gsap.set(sk, { opacity: 1 })
    }
    const start = (outline: boolean) => {
      settle()
      hideOutline(true)
      gsap.killTweensOf(bar)
      gsap.set(bar, { opacity: 1, scaleX: 0.02 })
      gsap.to(bar, { scaleX: 0.86, duration: 9, ease: 'power4.out' })
      pending.current = {
        outline: outline ? window.setTimeout(showOutline, SKELETON_AFTER_MS) : 0,
        giveUp: window.setTimeout(() => {
          gsap.to(bar, { opacity: 0, duration: 0.3 })
          hideOutline(false)
          pending.current = null
        }, PROGRESS_GIVE_UP_MS),
      }
    }
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(a instanceof HTMLAnchorElement) || a.closest('[data-no-progress]')) return
      const link = { href: a.href, target: a.target, download: a.hasAttribute('download') }
      if (startsNavigation(link, window.location.href)) start(outlinesFor(link, window.location.href))
    }
    // Back to a page the browser kept: nothing is loading.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return
      settle()
      gsap.set(bar, { opacity: 0, scaleX: 0 })
      hideOutline(true)
    }
    // Capturing, so the click is seen before a client-side link cancels its default.
    document.addEventListener('click', onClick, true)
    window.addEventListener('pageshow', onShow)
    return () => {
      settle()
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('pageshow', onShow)
    }
  }, [settle, hideOutline])

  // The page arrived: finish the bar, lift the outlines.
  const onArrive = useCallback(
    (at: string) => {
      const before = arrivedAt.current
      arrivedAt.current = at
      if (before === null || before === at) return
      settle()
      hideOutline(false)
      const bar = loading.current
      if (!bar || Number(gsap.getProperty(bar, 'opacity')) === 0) return
      gsap.killTweensOf(bar)
      gsap.timeline()
        .to(bar, { scaleX: 1, duration: 0.25, ease: 'power2.out' })
        .to(bar, { opacity: 0, duration: 0.3 })
        .set(bar, { scaleX: 0 })
    },
    [settle, hideOutline],
  )

  return (
    <>
      <div ref={loading} className="route-progress" aria-hidden="true" />
      <div ref={reading} className="read-progress" aria-hidden="true" />
      <PageOutline ref={skeleton} />
      <Suspense fallback={null}>
        <Arrivals onArrive={onArrive} />
      </Suspense>
    </>
  )
}

/**
 * Grey outlines of a page — a title, a line under it, a row of cards and a
 * table — laid over the page area while the next page is on its way. Every
 * page here is some arrangement of those, so the shape reads as "the page
 * is coming" without pretending to know what will be in it. Nothing in it
 * can be read, focused or clicked.
 */
function PageOutline({ ref }: { readonly ref: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="page-skeleton" aria-hidden="true">
      <div className="sk sk-title" />
      <div className="sk sk-line" />
      <div className="sk sk-line sk-short" />
      <div className="sk-cards">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sk sk-card" />
        ))}
      </div>
      <div className="sk-rows">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="sk sk-row" />
        ))}
      </div>
    </div>
  )
}
