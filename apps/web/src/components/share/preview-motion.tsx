'use client'

import { MOTION_OK, ScrollTrigger, SplitText, gsap, useGSAP } from '@/components/motion/gsap'

/**
 * The website preview's motion (2026-10-09). A business owner opens a
 * preview of a site we would build them, and it should feel like one: the
 * banner drops in, their name rises letter by letter, the hero's shapes
 * drift slower than the page as it scrolls, and each section arrives as it
 * is reached.
 *
 * The markup stays `SitePreview`'s, which a test renders: this finds its
 * parts by class and adds nothing to them. The page waits hidden for this
 * intro only where motion is allowed, and shows anyway after 1.2s if no
 * script ever runs (`.motion-ok .sp:not(.sp-ready)` in site-preview.tsx).
 */
export function PreviewMotion() {
  useGSAP(() => {
    const root = document.querySelector<HTMLElement>('.sp')
    if (!root) return
    const mm = gsap.matchMedia()
    mm.add(MOTION_OK, () => {
      const q = gsap.utils.selector(root)
      const name = root.querySelector<HTMLElement>('.sp-hero h1')
      const split = name ? SplitText.create(name, { type: 'words,chars', mask: 'words' }) : null

      const intro = gsap.timeline({ defaults: { ease: 'expo.out' } })
      intro
        .from(q('.sp-blob'), { scale: 0.55, opacity: 0, duration: 1.8, stagger: 0.15, ease: 'power3.out' }, 0)
        .from(q('.sp-banner'), { yPercent: -100, opacity: 0, duration: 0.8 }, 0)
        .from(q('.sp-nav > *'), { y: -14, opacity: 0, duration: 0.7, stagger: 0.08 }, 0.15)
        .from(q('.sp-kind'), { y: 14, opacity: 0, duration: 0.8 }, 0.25)
      if (split) intro.from(split.chars, { yPercent: 120, duration: 1.1, stagger: 0.02, onComplete: () => split.revert() }, 0.3)
      intro
        .from(q('.sp-tag'), { y: 20, opacity: 0, duration: 0.9 }, 0.55)
        .from(q('.sp-rating'), { y: 14, opacity: 0, scale: 0.94, duration: 0.8 }, 0.65)
        .from(q('.sp-hero .sp-ctas > *'), { y: 18, opacity: 0, duration: 0.8, stagger: 0.08 }, 0.72)

      // Depth: the hero's shapes and words drift at their own pace as the page scrolls.
      const hero = { trigger: q('.sp-hero')[0], start: 'top top', end: 'bottom top', scrub: true }
      gsap.to(q('.sp-blob-1'), { yPercent: 40, xPercent: -12, ease: 'none', scrollTrigger: hero })
      gsap.to(q('.sp-blob-2'), { yPercent: -35, ease: 'none', scrollTrigger: hero })
      gsap.to(q('.sp-hero-in'), { yPercent: 10, ease: 'none', scrollTrigger: hero })

      // Each section's heading, then its cards, as they are reached.
      for (const h of q('.sp-sec h2') as HTMLElement[]) {
        gsap.from(h, { y: 30, opacity: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: h, start: 'top 90%', once: true } })
      }
      const cards = q('.sp-sec .sp-card') as HTMLElement[]
      gsap.set(cards, { y: 40, opacity: 0, scale: 0.96 })
      ScrollTrigger.batch(cards, {
        start: 'top 92%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, { y: 0, opacity: 1, scale: 1, duration: 0.9, ease: 'power3.out', stagger: 0.09, overwrite: true, clearProps: 'transform,opacity' }),
      })
      gsap.from(q('.sp-foot'), { opacity: 0, y: 16, duration: 0.8, scrollTrigger: { trigger: q('.sp-foot')[0], start: 'top 98%', once: true } })

      // Everything is in its first frame: the page may show now.
      root.classList.add('sp-ready')
      return () => root.classList.remove('sp-ready')
    })
  }, [])
  return null
}
