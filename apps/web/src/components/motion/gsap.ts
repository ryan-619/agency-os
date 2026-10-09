/**
 * GSAP, registered once, for the client components that animate
 * (2026-10-09). Imported only by `'use client'` modules — a server component
 * has nothing to animate — and `apps/web/test/motion.test.ts` holds that.
 *
 * GSAP 3.15 and every plugin used here (ScrollTrigger, SplitText) are free
 * under GSAP's standard licence, commercial use included; its one
 * restriction is on no-code animation builders that compete with Webflow,
 * which nothing here is.
 */
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { useGSAP } from '@gsap/react'

if (typeof window !== 'undefined') gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP)

/**
 * Motion runs only for a visitor who has not asked their system for less of
 * it. Every animation in this folder sits behind this query (through
 * `gsap.matchMedia`), and the stylesheet's own transitions and keyframes
 * behind the same one.
 */
export const MOTION_OK = '(prefers-reduced-motion: no-preference)'

/** A pointer that hovers precisely — a mouse or a trackpad, never a finger. */
export const FINE_POINTER = '(hover: hover) and (pointer: fine)'

export { gsap, ScrollTrigger, SplitText, useGSAP }
