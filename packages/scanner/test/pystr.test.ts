/**
 * The string semantics the port borrows from Python, pinned against what
 * CPython actually answers.
 *
 * Every length rule and every truncation in the scanner is a port of a Python
 * one, and Python counts code points where JavaScript counts UTF-16 units.
 * That is not academic: the difference decides whether a `/security` page is
 * dismissed as an SPA shell, and where a 160-character detail string is cut.
 * Cutting UTF-16 can also split a surrogate pair and leave a lone surrogate in
 * a string the app then stores as evidence and renders.
 */
import { describe, it, expect } from 'vitest'
import { pyHead, pyLen, pyStrip } from '../src/pystr.js'
import { extractProfile, probePublicPath } from '../src/extract.js'
import { PUBLIC_PATHS, type RawCapture, type RawResponse } from '../src/types.js'

const GRIN = String.fromCodePoint(0x1f600)
const FLASK = String.fromCodePoint(0x1f9ea)
/** Wrapped in U+001C FILE SEPARATOR and U+0085 NEL: whitespace to Python only. */
const PY_ONLY_SPACE = `${String.fromCharCode(0x1c)} x ${String.fromCharCode(0x85)}`
/** Wrapped in U+FEFF: whitespace to `String.trim()` only. */
const JS_ONLY_SPACE = `${String.fromCharCode(0xfeff)} x ${String.fromCharCode(0xfeff)}`

describe('pyLen counts what len() counts', () => {
  it.each([
    [`a${GRIN}b`, 3],
    [GRIN.repeat(5), 5],
    [`cafe${FLASK}`, 5],
    [PY_ONLY_SPACE, 5],
    ['', 0],
    ['plain ascii', 11],
  ])('len(%j) === %i', (s, n) => {
    expect(pyLen(s)).toBe(n)
  })

  it('disagrees with String.length exactly where an astral character is', () => {
    expect(`a${GRIN}b`.length).toBe(4)
    expect(pyLen(`a${GRIN}b`)).toBe(3)
  })
})

describe('pyHead truncates where s[:n] truncates', () => {
  it.each([
    [`cafe ${FLASK}`, 5, 'cafe '],
    [`a${GRIN}b`, 5, `a${GRIN}b`],
    [GRIN.repeat(5), 3, GRIN.repeat(3)],
    [`${'x'.repeat(50)}${GRIN.repeat(10)}`, 5, 'xxxxx'],
  ])('%j[:%i]', (s, n, expected) => {
    expect(pyHead(s, n)).toBe(expected)
  })

  it('never leaves half a surrogate pair behind', () => {
    // Slicing UTF-16 here ends the string in a lone high surrogate, which would
    // go into `findings.evidence` and out to whatever renders it.
    expect(`a${GRIN}b`.slice(0, 2)).toBe(`a${String.fromCharCode(0xd83d)}`)
    expect(pyHead(`a${GRIN}b`, 2)).toBe(`a${GRIN}`)
    const lone = [...pyHead(`a${GRIN}b`, 2)].some((c) => {
      const cp = c.codePointAt(0)!
      return cp >= 0xd800 && cp <= 0xdfff
    })
    expect(lone).toBe(false)
  })
})

describe('pyStrip strips what str.strip() strips', () => {
  it('strips the separators Python calls whitespace and JavaScript does not', () => {
    expect(pyStrip(PY_ONLY_SPACE)).toBe('x')
    expect(PY_ONLY_SPACE.trim()).not.toBe('x')
  })

  it('leaves U+FEFF alone, which String.trim() removes', () => {
    expect(pyStrip(JS_ONLY_SPACE)).toBe(JS_ONLY_SPACE)
    expect(JS_ONLY_SPACE.trim()).toBe('x')
  })
})

describe('the length rules that decide whether a page was found', () => {
  const responses = (body: string): Record<string, RawResponse> => {
    const out: Record<string, RawResponse> = {}
    for (const p of PUBLIC_PATHS.trust_page) out[p] = { status: 404, body: 'nope' }
    out['/security'] = { status: 200, body }
    return out
  }

  it('measures the 40-character floor in code points', () => {
    // 39 emoji: 39 characters to Python, 78 to JavaScript. Counting UTF-16
    // would accept a page Python rejects as too short to be a trust page.
    const short = GRIN.repeat(39)
    expect(short.length).toBe(78)
    expect(pyLen(short)).toBe(39)
    expect(probePublicPath(PUBLIC_PATHS.trust_page, responses(short), 0).kind).toBe('absent')
    expect(probePublicPath(PUBLIC_PATHS.trust_page, responses(GRIN.repeat(40)), 0).kind).toBe('found')
  })

  it('measures the SPA-shell guard against the homepage in code points', () => {
    const page = GRIN.repeat(100) // 100 to Python, 200 to JavaScript
    // A homepage of the same 100 characters: within 40, so this is the shell.
    expect(probePublicPath(PUBLIC_PATHS.trust_page, responses(page), 100).kind).toBe('absent')
    // ...and comparing 200 against 100 would have called it a real page.
    expect(probePublicPath(PUBLIC_PATHS.trust_page, responses(page), 200).kind).toBe('found')
  })
})

describe('the 160-character caps', () => {
  const capture = (body: string, headers: Record<string, string> = {}): RawCapture => ({
    domain: 'example.com',
    capturedAt: '2026-09-11T00:00:00.000Z',
    home: { ok: true, status: 200, finalUrl: 'https://example.com/', headers, body },
    paths: {},
    tls: { ok: false, error: 'not attempted' },
  })

  it('cuts the title at 160 code points, not 160 code units', () => {
    const title = extractProfile(capture(`<title>${GRIN.repeat(200)}</title>`)).title ?? ''
    expect(pyLen(title)).toBe(160)
    expect(title).toBe(GRIN.repeat(160))
  })

  it('cuts a detail string without splitting a character', () => {
    const csp = `${'a'.repeat(139)}${GRIN}${'b'.repeat(100)}`
    const detail = extractProfile(capture('<p>x</p>', { 'content-security-policy': csp }))
      .observations.csp?.detail ?? ''
    expect(pyLen(detail)).toBe(140)
    expect(detail.endsWith(GRIN)).toBe(true)
  })
})
