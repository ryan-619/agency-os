/**
 * The free website check's route (review, 2026-10-08). It cannot be imported
 * here (`@/` and `server-only`), so its order is pinned by reading it: a site
 * or an address already on file is answered with the thank-you BEFORE
 * anything is scanned or any page is made — the agency's findings about a
 * prospect are not a stranger's to read, and a new scan would supersede the
 * one every draft and proposal quotes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECK_THANKS } from '../src/lib/check-copy'

const route = readFileSync(fileURLToPath(new URL('../src/app/api/check/[slug]/route.ts', import.meta.url)), 'utf8')
const form = readFileSync(fileURLToPath(new URL('../src/app/check/[slug]/form.tsx', import.meta.url)), 'utf8')

describe('the free website check route', () => {
  it('answers a site or an address on file before it scans or mints a page', () => {
    const answer = route.indexOf('if (r.recognised) return NextResponse.json({ ok: true, url: null }')
    expect(answer).toBeGreaterThan(0)
    expect(route.indexOf('scanDomain(')).toBeGreaterThan(answer)
    expect(route.indexOf('recordScan(')).toBeGreaterThan(answer)
    expect(route.indexOf('shareLinkMint(')).toBeGreaterThan(answer)
  })

  it('thanks the visitor in words true whether or not anything will be emailed', () => {
    expect(form).toContain('{CHECK_THANKS}')
    expect(CHECK_THANKS).not.toMatch(/email you/i)
  })
})
