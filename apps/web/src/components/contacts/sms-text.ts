/**
 * The SMS composer's arithmetic: the live render of a template's slots, and
 * how long the result is in the units an operator bills — characters, the
 * encoding, and segments.
 *
 * Pure and importing nothing, because the composer is a client component and
 * the house rule keeps `@agency/core`'s runtime out of the browser bundle.
 * It is a PREVIEW. What is drafted is rendered on the server by core's
 * `renderTemplate`, which refuses anything the operator would scrub, and the
 * send path checks it again with `matchesTemplate`. Two rules are restated
 * here, and `test/sms-composer.test.ts` holds each to its source: 30
 * characters a variable to core's, and the GSM-7 set to the DoveSoft
 * provider's, over one table of strings.
 */

/** DLT's limit on one filled `{#var#}` — `DLT_VAR_MAX_CHARS` in core, restated for the browser. */
export const SMS_VAR_MAX_CHARS = 30

/** A template's body as the server read it: literal text and slots, in order (`TemplatePart` in core). */
export type ComposerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly variable: string }

export interface ComposerRender {
  /** The message with every filled slot in place and every empty one shown as its `{#…#}`. */
  readonly text: string
  /** Every slot has a value. */
  readonly complete: boolean
  /** What the server will refuse, said per slot (1-based). Never the value itself. */
  readonly problems: readonly { readonly slot: number; readonly message: string }[]
}

const codePoints = (s: string): number => Array.from(s).length

/**
 * Fill the slots for the preview. A value is shown as typed; a slot with
 * nothing in it shows its `{#kind#}`, so the person sees what is missing
 * where it is missing. Blank and over-long values are reported here because
 * they are the two every person meets; the rest — a link in a plain
 * `{#var#}`, digits in a `{#numeric#}` — is the server's to say.
 */
export function renderPreview(parts: readonly ComposerPart[], values: readonly string[]): ComposerRender {
  let text = ''
  let n = 0
  let empty = 0
  const problems: { slot: number; message: string }[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      text += part.text
      continue
    }
    const value = values[n] ?? ''
    n += 1
    if (value.trim() === '') {
      text += `{#${part.variable}#}`
      empty += 1
      problems.push({ slot: n, message: `Variable ${n} is empty.` })
      continue
    }
    const length = codePoints(value)
    if (length > SMS_VAR_MAX_CHARS) {
      problems.push({ slot: n, message: `Variable ${n} is ${length} characters; a DLT variable holds at most ${SMS_VAR_MAX_CHARS}.` })
    }
    text += value
  }
  return { text, complete: empty === 0, problems }
}

// ---------------------------------------------------------------------------
// Length, encoding, segments
// ---------------------------------------------------------------------------

/**
 * GSM 03.38's default alphabet — one septet each. A message entirely within
 * it is sent as GSM-7; one character outside it sends the whole message as
 * UCS-2, which is why one emoji or one Hindi letter more than halves what a
 * segment holds.
 *
 * The extension table (`€ [ ] { } ~ ^ \\ |` and the form feed) is GSM-7 on
 * paper, at two septets each, and counts as OUTSIDE here, because that is
 * what DoveSoft is sent: the provider's `needsUnicode`
 * (apps/agent/src/outreach/dovesoft.ts) puts `unicode=1` on any of it, since
 * a gateway may not apply the escape and a mangled character is a DLT text
 * the operator scrubs. A preview that counted them as GSM-7 promised one
 * segment for a text billed as three. `test/sms-composer.test.ts` runs this
 * and the provider's predicate over one table, so the two cannot drift.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const BASIC = new Set(Array.from(GSM_BASIC))

export interface SmsLength {
  readonly encoding: 'gsm7' | 'ucs2'
  /** Characters as a person counts them: code points. */
  readonly characters: number
  /** What a segment is filled with: septets for GSM-7, UTF-16 units for UCS-2. */
  readonly units: number
  readonly segments: number
  /** How many units one segment holds at this length: 160/70 alone, 153/67 once it is split. */
  readonly perSegment: number
}

/**
 * The message's length as an operator bills it. One segment holds 160
 * GSM-7 septets or 70 UCS-2 units; a longer message is split into segments
 * of 153 or 67, because each carries a header saying how to join them. A
 * character is never split across two segments — a surrogate pair moves
 * whole to the next one — so the count is a greedy packing rather than a
 * division.
 */
export function smsLength(text: string): SmsLength {
  const chars = Array.from(text)
  const gsm = chars.every((c) => BASIC.has(c))
  const cost = (c: string): number => (gsm ? 1 : c.length)
  const units = chars.reduce((sum, c) => sum + cost(c), 0)
  const single = gsm ? 160 : 70
  const multi = gsm ? 153 : 67
  if (units === 0) return { encoding: gsm ? 'gsm7' : 'ucs2', characters: 0, units: 0, segments: 0, perSegment: single }
  if (units <= single) return { encoding: gsm ? 'gsm7' : 'ucs2', characters: chars.length, units, segments: 1, perSegment: single }
  let segments = 1
  let used = 0
  for (const c of chars) {
    const w = cost(c)
    if (used + w > multi) {
      segments += 1
      used = 0
    }
    used += w
  }
  return { encoding: gsm ? 'gsm7' : 'ucs2', characters: chars.length, units, segments, perSegment: multi }
}

/** "142 characters · GSM-7 · 1 segment", for under the preview. */
export function lengthLine(l: SmsLength): string {
  const encoding = l.encoding === 'gsm7' ? 'GSM-7' : 'Unicode (UCS-2)'
  return `${l.characters} character${l.characters === 1 ? '' : 's'} · ${encoding} · ${l.segments} segment${l.segments === 1 ? '' : 's'}`
}
