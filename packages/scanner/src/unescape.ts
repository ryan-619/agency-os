/**
 * A port of CPython's `html.unescape`.
 *
 * `html.parser.HTMLParser(convert_charrefs=True)` — which is what the
 * reference engine reads pages with — runs every text run and every attribute
 * value through this, so the port has to agree with it exactly or the two
 * engines disagree about what a page says. The tables it consults are
 * generated from Python itself (see python-tables.ts); this file is only the
 * algorithm around them.
 */

import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from './python-tables.js'

/**
 * `html._charref`. The named alternative is `[^\t\n\f <&#;]{1,32};?` — note
 * that it allows almost anything, including `\r` and `>`, and that Python
 * counts those 32 in CODE POINTS. The `u` flag is what makes the quantifier
 * count code points here too.
 */
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu

/** `str.rstrip(';')` — Python strips every trailing semicolon, not just one. */
function rstripSemicolons(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === ';') end -= 1
  return s.slice(0, end)
}

function replaceCharref(body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X'
    const digits = rstripSemicolons(body.slice(hex ? 2 : 1))
    // The regex guarantees at least one digit, so this never yields NaN.
    // Python has arbitrary-precision ints; a value too large for a double
    // still lands far above 0x10FFFF, which is the only comparison made.
    const num = Number.parseInt(digits, hex ? 16 : 10)

    const invalid = INVALID_CHARREFS.get(num)
    if (invalid !== undefined) return invalid
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�'
    if (INVALID_CODEPOINTS.has(num)) return ''
    return String.fromCodePoint(num)
  }

  const exact = HTML5_ENTITIES.get(body)
  if (exact !== undefined) return exact

  // No exact hit: Python falls back to the longest matching prefix and keeps
  // the rest as literal text, which is how `&notit;` becomes `¬it;`.
  // Sliced by code point, as Python slices.
  const cps = Array.from(body)
  for (let x = cps.length - 1; x > 1; x -= 1) {
    const prefix = cps.slice(0, x).join('')
    const hit = HTML5_ENTITIES.get(prefix)
    if (hit !== undefined) return hit + cps.slice(x).join('')
  }
  return `&${body}`
}

export function unescape(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(CHARREF, (_match, body: string) => replaceCharref(body))
}
