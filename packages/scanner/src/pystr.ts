/**
 * Python string semantics, for the handful of places where JavaScript's differ
 * and the difference is observable in a finding.
 *
 * Two of them matter here:
 *
 *   * A Python string is a sequence of CODE POINTS; a JavaScript string is a
 *     sequence of UTF-16 code units. An emoji is one character to `len()` and
 *     two to `.length`. The scanner's length rules and truncations are ported
 *     from Python, so a page with astral characters — an emoji in a title, a
 *     CJK extension glyph, a mathematical alphanumeric — is measured
 *     differently by each engine. `detail[:160]` and `.slice(0, 160)` can even
 *     cut in different places, and slicing UTF-16 can split a surrogate pair
 *     and leave a lone surrogate in a string that gets stored as evidence.
 *
 *   * `str.strip()` and `String.prototype.trim()` disagree about which
 *     characters are whitespace: Python strips U+001C..U+001F and U+0085,
 *     JavaScript strips U+FEFF.
 *
 * Nothing here is a micro-optimisation of the obvious thing; each is the
 * obvious thing being wrong.
 */

import { PY_SPACE_CLASS as S } from './python-tables.js'

/** Any string with no surrogate can take the fast path in all three. */
const HAS_SURROGATE = /[\uD800-\uDFFF]/

/** `len(s)` — code points, not UTF-16 code units. */
export function pyLen(s: string): number {
  if (!HAS_SURROGATE.test(s)) return s.length
  let n = 0
  for (const _ of s) n += 1
  return n
}

/** `s[:end]` — truncation by code point, which never splits a surrogate pair. */
export function pyHead(s: string, end: number): string {
  if (s.length <= end) return s
  if (!HAS_SURROGATE.test(s)) return s.slice(0, end)
  return Array.from(s).slice(0, end).join('')
}

const STRIP = new RegExp(`^[${S}]+|[${S}]+$`, 'g')

/** `str.strip()`. */
export function pyStrip(s: string): string {
  return s.replace(STRIP, '')
}
