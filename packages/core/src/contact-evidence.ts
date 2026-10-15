/**
 * True data only (2026-10-13): what a page, a search result or a person's
 * message SHOWS — never what a model composed.
 *
 * The chat agent stored people and addresses nobody had shown it: "Alex Chen,
 * VP Engineering, security@carbonmaps.io" when asked to test the features,
 * `akash@farmley.com` from a LinkedIn profile that carried no address, and
 * `yummybites-delhi.business.site` for a café whose listing named no website.
 * A sentence in the prompt already forbade it. So the rule moved to where the
 * write happens: an address is stored only when something real shows it, and
 * these are the readers that say whether it does.
 *
 * Pure: no I/O. The page reader that fetches is `readPublicPage` in
 * packages/scanner; the conversation ledger lives in the worker.
 */
import { normaliseDomainValue, normaliseEmail, normalisePhone } from './normalise.js'

// ---------------------------------------------------------------------------
// Email addresses
// ---------------------------------------------------------------------------

/** A last label that is a file's extension, not a TLD: `logo@2x.png`. */
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff',
  'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'pdf',
])

/** Placeholder and machinery domains a page shows that no business reads mail at. */
const NOT_A_MAILBOX_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.in', 'domain.com', 'yourdomain.com', 'yoursite.com',
  'mysite.com', 'email.com', 'test.com', 'company.com', 'yourcompany.com', 'website.com', 'sentry.io',
  'wixpress.com', 'sentry-next.wixpress.com',
])
const NOT_A_MAILBOX_SUFFIXES = ['.sentry.io', '.wixpress.com', '.ingest.sentry.io']

/** A top-level domain: letters, or an internationalised one's `xn--` form — never digits (`react@18.3.1`). */
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const EMAIL_SHAPE = /^[a-z0-9][a-z0-9_.%+'-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const MAILTO = /mailto:([^"'\s<>?#]+)/gi
/** RFC 5321's limits: a local part is at most 64 characters, a domain at most 253. */
const LOCAL_MAX = 64
const DOMAIN_MAX = 253

// `_` included: `first_last@acme.in` is an address, and reading it as `last@acme.in` was a guess.
const isLocalChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9_.%+'-]/i.test(c)
const isDomainChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9.-]/i.test(c)

/**
 * The text an address finder reads: bracketed obfuscations read back
 * (`name [at] domain [dot] com`, `name(at)domain.com`), the spelled-out form
 * only in CAPITALS (`name AT domain DOT com` — "write to us at farmley dot
 * com" is a sentence, and reading it as `us@farmley.com` would be a guess) and,
 * when the whole run is shouted, only for a role inbox (`INFO AT ACME DOT COM`,
 * never `EMAIL US AT ACME DOT COM` as `us@acme.com`),
 * HTML entities, the `\u0040` escapes of JSON a page embeds, and the
 * percent-escapes an address carries in a link — read once, so the address in
 * `mailto:sales%2Bin@acme.in` is `sales+in@acme.in` and never also
 * `sales%2bin@acme.in`. Every pattern is bounded, so a page of whitespace or
 * brackets costs linear time.
 */
function deobfuscate(text: string): string {
  return text
    .replace(/\\u00([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    // One pass over the printable escapes: `%40` is `@`, `%2B` is `+`, `%2C` the comma between two addresses.
    .replace(/%([2-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')
    .replace(/[ \t]{0,3}[[({<][ \t]{0,2}at[ \t]{0,2}[\])}>][ \t]{0,3}/gi, '@')
    .replace(/[ \t]{0,3}[[({<][ \t]{0,2}dot[ \t]{0,2}[\])}>][ \t]{0,3}/gi, '.')
    .replace(
      /\b([A-Za-z0-9][\w.%+-]{0,63}) AT ((?:[A-Za-z0-9-]{1,63} DOT )+[A-Za-z]{2,24})\b/g,
      (whole: string, local: string, domain: string) => {
        const shouted = !/[a-z]/.test(local + domain)
        if (shouted && !ROLE_LOCAL_PARTS.has(local.toLowerCase().replace(/[._-]/g, ''))) return whole
        return `${local}@${domain.replace(/ DOT /g, '.')}`
      },
    )
}

/**
 * A domain read up to where the page had a break the text lost: a label that
 * turns from lower case to a capital (`acme.inPhone`), or a capitalised word
 * after a lower-case label (`acme.in.Call us`), is the next word, not more of
 * the domain. Read whole, "Email: info@acme.inPhone: …" gave
 * `info@acme.inphone` — an address nobody published — and hid the one they did.
 */
function domainUpToABreak(domain: string): string {
  const labels = domain.split('.')
  const kept: string[] = []
  for (const [i, label] of labels.entries()) {
    const before = kept.at(-1)
    if (before !== undefined && /^[A-Z][a-z]/.test(label) && !/[A-Z]/.test(before)) break
    const turn = i > 0 && i === labels.length - 1 ? /[a-z][A-Z]/.exec(label) : null
    kept.push(turn ? label.slice(0, turn.index + 1) : label)
  }
  return kept.join('.')
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** One candidate read as a stored address, or null for anything that is not a mailbox somebody reads. */
function asMailbox(candidate: string): string | null {
  const email = normaliseEmail(candidate.replace(/^['.]+|['.]+$/g, ''))
  if (!email) return null
  const domain = email.slice(email.lastIndexOf('@') + 1)
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (!TLD.test(tld) || ASSET_EXTENSIONS.has(tld)) return null
  if (NOT_A_MAILBOX_DOMAINS.has(domain) || NOT_A_MAILBOX_SUFFIXES.some((s) => domain.endsWith(s))) return null
  return email
}

/**
 * The address around one `@`, read outwards a bounded distance: the local part
 * at most 64 characters back and the domain at most 253 on. A run longer than
 * that is not an address. Anchoring on the `@` rather than matching a pattern
 * from every position is what keeps a page holding a long run of letters (a
 * minified script, a data URI) linear; the pattern did it in quadratic time.
 */
function addressAt(text: string, at: number): { start: number; raw: string } | null {
  let start = at
  while (start > 0 && isLocalChar(text[start - 1])) {
    start--
    if (at - start > LOCAL_MAX) return null
  }
  while (start < at && !/[a-z0-9]/i.test(text[start] ?? '')) start++
  let end = at + 1
  while (end < text.length && isDomainChar(text[end])) {
    end++
    if (end - at - 1 > DOMAIN_MAX) return null
  }
  const domain = domainUpToABreak(text.slice(at + 1, end)).replace(/[.-]+$/, '')
  if (start === at || domain === '') return null
  const raw = `${text.slice(start, at)}@${domain}`
  return EMAIL_SHAPE.test(raw) ? { start, raw } : null
}

/**
 * Every email address a page or a text shows, normalised as the CRM stores
 * them, each once and in the order the page shows them: plain addresses,
 * `mailto:` links (their query left off, percent-escapes read) and
 * obfuscations (`info [at] acme [dot] in`). Placeholders (`you@example.com`),
 * image names (`logo@2x.png`), package versions (`react@18.3.1`) and a
 * tracker's machinery are not addresses.
 */
export function findEmailsIn(text: string): string[] {
  const doc = deobfuscate(text)
  const found: { at: number; email: string }[] = []
  for (const m of doc.matchAll(MAILTO)) {
    for (const part of decodePercent(m[1] ?? '').split(',')) {
      const email = asMailbox(part)
      if (email) found.push({ at: m.index ?? 0, email })
    }
  }
  for (let at = doc.indexOf('@'); at !== -1; at = doc.indexOf('@', at + 1)) {
    const hit = addressAt(doc, at)
    const email = hit ? asMailbox(hit.raw) : null
    if (hit && email) found.push({ at: hit.start, email })
  }
  return inOrder(found.map((f) => ({ at: f.at, value: f.email })))
}

/** Values by where they were found, each once at its first place. */
function inOrder(found: readonly { at: number; value: string }[]): string[] {
  const seen = new Set<string>()
  for (const f of [...found].sort((a, b) => a.at - b.at)) seen.add(f.value)
  return [...seen]
}

/** Whether a text shows this address — plainly, in a mailto, or obfuscated as `findEmailsIn` reads it. */
export function textShowsEmail(text: string, email: string): boolean {
  const wanted = normaliseEmail(email)
  if (!wanted) return false
  return findEmailsIn(text).includes(wanted)
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export interface FindPhonesOptions {
  /**
   * Read a number written without its country code as India's — only where the
   * page is known to be an Indian business's (its country, or a `.in` site).
   * `normalisePhone` itself never guesses a country, and this is the one place
   * a caller may say which one a page is in.
   */
  readonly defaultCountry?: 'IN'
}

/**
 * E.164's two-digit country codes; 1 and 7 are the one-digit ones, and every
 * other code is three digits. A prefix code, so the digits alone say where the
 * country code ends.
 */
const TWO_DIGIT_COUNTRY_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51',
  '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90',
  '91', '92', '93', '94', '95', '98',
])

function countryCodeLength(digits: string): number {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1
  return TWO_DIGIT_COUNTRY_CODES.has(digits.slice(0, 2)) ? 2 : 3
}

/**
 * How many digits follow the country code, for the countries whose numbers
 * have a fixed length. A number is read to exactly that length, so "+91 98765
 * 43210 (10am–7pm)" is +919876543210 and never +91987654321010. Elsewhere the
 * longest run of tightly written groups up to E.164's fifteen digits is read.
 */
const NATIONAL_LENGTHS: Readonly<Record<string, readonly number[]>> = {
  '1': [10], '7': [10], '27': [9], '33': [9], '44': [9, 10], '60': [9, 10], '61': [9], '65': [8], '81': [9, 10],
  '86': [10, 11], '91': [10], '92': [10], '94': [9], '234': [10], '254': [9], '852': [8], '880': [10],
  '966': [8, 9], '971': [8, 9], '974': [8],
}

interface DigitGroup {
  readonly digits: string
  readonly start: number
  readonly end: number
  /** The characters between the group before it and this one; '' for a run's first. */
  readonly joint: string
  /** A letter, `_` or `@` touches its end: "10am", "9876543210@ybl", "…3210abc". */
  readonly gluedAfter: boolean
}

/** A connector a person types inside one phone number: a space, a dash, a dot, brackets. */
const PHONE_JOINT = /^(?:[ \u00a0]?[-.\u2010-\u2013][ \u00a0]?|[ \u00a0]|[ \u00a0]?\(|\)[ \u00a0.-]?\(?)$/
/** A looser connector, for asking whether a known number is shown at all. */
const LOOSE_JOINT = /^[\s.\-\u2010-\u2015()/]{1,4}$/

/**
 * Runs of digit groups, each run held together by connectors `joint` accepts.
 * A dot after a single digit is a decimal point (`0.9876543210`), never a
 * separator. Linear.
 */
function digitRuns(text: string, joint: RegExp): DigitGroup[][] {
  const runs: DigitGroup[][] = []
  let run: DigitGroup[] = []
  let prevEnd = -1
  for (const m of text.matchAll(/\d+/g)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const between = prevEnd === -1 ? '' : text.slice(prevEnd, start)
    const group: DigitGroup = {
      digits: m[0],
      start,
      end,
      joint: between,
      gluedAfter: /[\p{L}_@]/u.test(text[end] ?? ''),
    }
    const decimal = between === '.' && run.at(-1)?.digits.length === 1
    if (run.length > 0 && between.length <= 4 && joint.test(between) && !decimal) run.push(group)
    else {
      if (run.length > 0) runs.push(run)
      run = [{ ...group, joint: '' }]
    }
    prevEnd = end
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/** A number written with its country code (`+91 98765 43210`, `0044 20 7946 0958`), read from group `i`. */
function readInternational(groups: readonly DigitGroup[], i: number, skip: number): { e164: string; next: number } | null {
  let digits = ''
  let best: { digits: string; next: number } | null = null
  for (let j = i; j < groups.length; j++) {
    const g = groups[j]!
    const part = j === i ? g.digits.slice(skip) : g.digits
    // "+44 (0)20 7946 0958": the bracketed trunk 0 is not dialled from abroad.
    if (j > i && part === '0' && g.joint.endsWith('(') && digits.length <= 3) continue
    digits += part
    if (digits.length > 15) break
    const cc = digits.length >= 3 ? digits.slice(0, countryCodeLength(digits)) : null
    const lengths = cc ? NATIONAL_LENGTHS[cc] : undefined
    if (lengths) {
      const national = digits.length - cc!.length
      if (lengths.includes(national) && !g.gluedAfter) best = { digits, next: j + 1 }
      if (national >= Math.max(...lengths)) break
    } else {
      // A country whose numbers vary in length: the longest tightly written run.
      if (j > i && g.joint.length > 2) break
      if (digits.length >= 8 && !g.gluedAfter) best = { digits, next: j + 1 }
    }
    if (g.gluedAfter) break
  }
  if (!best) return null
  const e164 = normalisePhone(`+${best.digits}`)
  return e164 ? { e164, next: best.next } : null
}

/**
 * The digits of one Indian number written without `+`, or null: a mobile
 * (ten digits from 6–9), the same with its trunk 0 or a bare 91, a landline
 * with its trunk 0 and STD code (2–4 digits from 1–8), or a toll-free
 * 1800/1860 number. A ten-digit run starting 1–5 with no trunk 0 is nobody's
 * phone number — a timestamp, an order number.
 */
function indianDigits(digits: string, firstGroup: string): string | null {
  if (digits.length === 10 && /^[6-9]/.test(digits) && !firstGroup.startsWith('0')) return `91${digits}`
  if (digits.length === 11 && /^0[1-9]/.test(digits)) return `91${digits.slice(1)}`
  if (digits.length === 12 && /^91[6-9]/.test(digits) && (firstGroup === '91' || firstGroup.length === 12)) return digits
  if (digits.length === 11 && /^1(?:800|860)/.test(digits) && /^1(?:800|860)/.test(firstGroup)) return `91${digits}`
  return null
}

/** One Indian number written without `+`, in a link or a field of its own (`tel:098765 43210`). */
function indianString(raw: string): string | null {
  const digits = raw.replace(/[\s().-]/g, '')
  if (!/^\d+$/.test(digits)) return null
  const read = indianDigits(digits.startsWith('0091') ? digits.slice(2) : digits, digits)
  return read ? normalisePhone(`+${read}`) : null
}

const TEL = /tel:([+\d\s().%-]{6,30})/gi
const WHATSAPP =
  /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s<>]{0,400}&)?phone=|whatsapp:\/\/send\?(?:[^"'\s<>]{0,400}&)?phone=)\+?(\d{7,15})/gi

/** A label that says the number after it is a phone number: "Ph:", "Mobile No.", "Call us on". */
const PHONE_LABEL =
  /(?:^|[^\p{L}])(?:phone|ph|mob|mobile|cell|tel|telephone|landline|call(?: us)?(?: on| at)?|whats ?app|wa|contact(?: us)?|helpline|hotline|fax|enquir(?:y|ies)|support|customer care|office|reach us(?: on| at)?)[^\p{L}\p{N}]{0,4}(?:no\.?|number|num)?[^\p{L}\p{N}]{0,3}$/u
/** A label that says the digits after it are NOT a phone number: an order, an invoice, a PIN code, a price. */
const NOT_A_PHONE_LABEL =
  /(?:^|[^\p{L}])(?:order|invoice|inv|bill|receipt|ref|reference|txn|transaction|utr|tracking|awb|consignment|docket|gstin?|pan|cin|pin|pin ?code|pincode|zip|postal code|account|a\/c|acct|ifsc|micr|sku|item|product|model|serial|isbn|ticket|pnr|booking|regn?|registration|licen[cs]e|fssai|udyam|iec|policy|claim|aadhaa?r|uid|id|otp|₹|rs\.?|inr|usd|\$|€|£|price|mrp|amount|total|cost|fee|salary)[\s"'’“”:#.\-–=(]*(?:no\.?|number|num|id|#|code)?[\s"'’“”:#.\-–=(]*$/iu

/**
 * Whether the digits starting at `start` are glued to something that is not
 * a phone number: a word (`SKU9876543210`, `v1.9876…`), a URL path
 * (`/p/9876543210`), a price (`₹98765`), an anchor or a query value — unless a
 * phone label stands right before them.
 */
function notAPhoneHere(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start)
  const line = before.slice(before.lastIndexOf('\n') + 1).toLowerCase()
  if (PHONE_LABEL.test(line)) return false
  const c = text[start - 1] ?? ''
  const b = text[start - 2] ?? ''
  if (/[\p{L}\p{Sc}_@#=+]/u.test(c)) return true
  if (c === '/' && /[\p{L}\p{N}_.:/-]/u.test(b)) return true
  if ((c === '.' || c === ',') && /\p{N}/u.test(b)) return true
  if (c === '-' && /\p{L}/u.test(b)) return true
  return NOT_A_PHONE_LABEL.test(line)
}

/**
 * Every phone number a page or a text shows, in E.164, each once and in the
 * order the page shows them: `tel:` and WhatsApp links, numbers written with
 * their country code (`+91 98765 43210`, `0044 20 7946 0958`), and — only with
 * `defaultCountry: 'IN'` — Indian numbers written without one, mobiles and
 * landlines (`(022) 2345 6789`). Never a number glued to a word, a URL path or
 * a price, nor one labelled as an order, an invoice or an id.
 */
export function findPhonesIn(text: string, opts: FindPhonesOptions = {}): string[] {
  const india = opts.defaultCountry === 'IN'
  const found: { at: number; value: string }[] = []
  const add = (at: number, e164: string | null): void => {
    if (e164) found.push({ at, value: e164 })
  }
  for (const m of text.matchAll(TEL)) {
    const raw = decodePercent(m[1] ?? '').trim()
    add(m.index ?? 0, normalisePhone(raw) ?? (india ? indianString(raw) : null))
  }
  for (const m of text.matchAll(WHATSAPP)) {
    const digits = m[1] ?? ''
    // WhatsApp's links take the number with its country code; an Indian page
    // that left the 91 off still means its own mobile.
    add(m.index ?? 0, india && /^[6-9]\d{9}$/.test(digits) ? normalisePhone(`+91${digits}`) : normalisePhone(`+${digits}`))
  }
  for (const run of digitRuns(text, PHONE_JOINT)) {
    const first = run[0]!
    const plus = text[first.start - 1] === '+' || (text[first.start - 1] === '(' && text[first.start - 2] === '+')
    let i = 0
    if (plus || first.digits.startsWith('00')) {
      const glued = !plus && notAPhoneHere(text, first.start)
      const read = glued ? null : readInternational(run, 0, plus ? 0 : 2)
      if (read) {
        add(first.start, read.e164)
        i = read.next
      } else i = 1
    }
    if (!india) continue
    while (i < run.length) {
      const read = readIndianRun(text, run, i)
      if (read) {
        add(run[i]!.start, read.e164)
        i = read.next
      } else i++
    }
  }
  return inOrder(found)
}

/** An Indian number written without `+` starting at group `i` of a run, or null. */
function readIndianRun(text: string, run: readonly DigitGroup[], i: number): { e164: string; next: number } | null {
  const first = run[i]!
  if (notAPhoneHere(text, first.start)) return null
  let digits = ''
  for (let j = i; j < run.length && digits.length < 12; j++) {
    const g = run[j]!
    digits += g.digits
    const read = indianDigits(digits, first.digits)
    if (read) return g.gluedAfter ? null : { e164: `+${read}`, next: j + 1 }
    if (g.gluedAfter) return null
  }
  return null
}

/**
 * Whether a text shows this number, however it is written there: as one of the
 * numbers `findPhonesIn` reads, or as digits a person would read as it once the
 * spaces, dashes, dots and brackets between them are set aside — the whole
 * number (`+91 98765 43210`, `0091…`), or its national digits alone or after a
 * trunk 0 (`98765 43210`, `098765-43210`). Never as the tail of a longer number:
 * `Invoice 202419876543210` does not show +91 98765 43210.
 */
export function textShowsPhone(text: string, e164: string, opts: FindPhonesOptions = {}): boolean {
  const wanted = normalisePhone(e164)
  if (!wanted) return false
  if (findPhonesIn(text, opts).includes(wanted)) return true
  const digits = wanted.slice(1)
  const national = digits.slice(countryCodeLength(digits))
  const forms = new Set([digits, `00${digits}`])
  if (national.length >= 7) {
    forms.add(national)
    forms.add(`0${national}`)
  }
  // Every beginning of a form, so a run of groups is followed only while it can still become one.
  const beginnings = new Set([...forms].flatMap((f) => [...f].map((_, n) => f.slice(0, n + 1))))
  for (const run of digitRuns(text, LOOSE_JOINT)) {
    for (let i = 0; i < run.length; i++) {
      let joined = ''
      for (let j = i; j < run.length; j++) {
        joined += run[j]!.digits
        if (forms.has(joined)) return true
        if (!beginnings.has(joined)) break
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// People and websites
// ---------------------------------------------------------------------------

/** Lower-case, accents off (`José` is `jose`), curly apostrophes straight (`O’Brien` is `o'brien`). */
function folded(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .toLowerCase()
}

/**
 * Whether a text names this person: every part of their name of two letters or
 * more appears as a whole word, ignoring case and accents, in any script
 * (`आकाश` as well as `Akash`). With no name at all, nobody is named.
 */
export function textNamesPerson(text: string, firstName: string | null, lastName: string | null): boolean {
  const parts = [firstName, lastName]
    .flatMap((p) => folded(p ?? '').split(/[^\p{L}\p{M}\p{N}']+/u))
    .map((p) => p.replace(/^'+|'+$/g, ''))
    .filter((p) => (p.match(/\p{L}/gu) ?? []).length >= 2)
  if (parts.length === 0) return false
  const haystack = folded(text)
  return parts.every((p) =>
    new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(p)}(?![\\p{L}\\p{M}\\p{N}])`, 'u').test(haystack),
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a text shows this website's host — on a host boundary, so
 * `127atelier.in` is in `https://www.127atelier.in/pages/about`, in
 * `shop.127atelier.in` and in "127atelier.in", but not in `x127atelier.in` or
 * `127atelier.in.example.com`. Found with indexOf and a look either side, so a
 * long run of `a.a.a.…` costs linear time.
 */
export function textShowsDomain(text: string, domain: string): boolean {
  const host = normaliseDomainValue(domain)
  if (!host) return false
  const haystack = text.toLowerCase()
  for (let at = haystack.indexOf(host); at !== -1; at = haystack.indexOf(host, at + 1)) {
    const before = haystack[at - 1] ?? ''
    const after = haystack.slice(at + host.length, at + host.length + 2)
    if (/[a-z0-9-]/.test(before)) continue
    if (/^[a-z0-9-]/.test(after) || /^\.[a-z0-9]/.test(after)) continue
    return true
  }
  return false
}

/**
 * Hosts nobody can be reached at any more. Google's Business Profile websites
 * (`<name>.business.site`) were shut down in 2024; a model that has never seen
 * a café's website still writes one there.
 */
export function isShutDownHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/\.$/, '')
  const h = normaliseDomainValue(bare) ?? bare
  return h === 'business.site' || h.endsWith('.business.site')
}

// ---------------------------------------------------------------------------
// Role inboxes and masking
// ---------------------------------------------------------------------------

/** A business's published inbox rather than a person's: not personal data, and shown whole. */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info', 'hello', 'hi', 'contact', 'contactus', 'enquiry', 'enquiries', 'inquiry', 'inquiries', 'sales',
  'support', 'help', 'care', 'customercare', 'customerservice', 'admin', 'office', 'team', 'mail', 'connect',
  'business', 'orders', 'order', 'booking', 'bookings', 'reservations', 'reservation', 'hr', 'careers', 'jobs',
  'marketing', 'accounts', 'billing', 'feedback', 'service', 'services', 'query', 'queries', 'studio', 'shop',
  'store', 'press', 'media', 'partners', 'partnerships',
])

export function isRoleAddress(email: string): boolean {
  const e = normaliseEmail(email)
  if (!e) return false
  return ROLE_LOCAL_PARTS.has(e.slice(0, e.lastIndexOf('@')).replace(/[._-]/g, ''))
}

/**
 * How an address is shown to the model: a role inbox whole
 * (`info@127atelier.in`), a person's as its first letter and the domain
 * (`a…@farmley.com`) — the tools never hand a person's whole address to a
 * model, which could then type it somewhere else.
 */
export function maskAddress(email: string): string {
  const e = normaliseEmail(email) ?? email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return '…'
  if (isRoleAddress(e)) return e
  return `${e.slice(0, 1)}…${e.slice(at)}`
}

/** A phone number as it is shown to the model: the country code and the last four digits only (`+971…4567`). */
export function maskPhone(e164: string): string {
  const wanted = normalisePhone(e164)
  if (!wanted) return '…'
  const digits = wanted.slice(1)
  return `+${digits.slice(0, countryCodeLength(digits))}…${digits.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Links on a page
// ---------------------------------------------------------------------------

export interface PageLink {
  /** Absolute, resolved against the page's own address, without its fragment. */
  readonly href: string
  /** The link's visible words, tags removed, at most 120 characters. */
  readonly text: string
}

const PAGE_LINKS_MAX = 400
const LINK_SCAN_MAX = 600_000
/** A page, or the address or number a contact link carries; nothing else a link can point at. */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * The links on an HTML page, for finding its contact page — never evidence:
 * web pages, and the `mailto:` and `tel:` links a contact page carries. Walks `<a … href=…>` openings with indexOf, so a page full of unclosed tags
 * costs linear time; at most 400 links, from the first 600 kB.
 */
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  let base: URL
  try {
    base = new URL(pageUrl)
  } catch {
    return []
  }
  const doc = html.slice(0, LINK_SCAN_MAX)
  const lower = doc.toLowerCase()
  const out: PageLink[] = []
  const seen = new Set<string>()
  let at = 0
  while (out.length < PAGE_LINKS_MAX) {
    const open = lower.indexOf('<a', at)
    if (open === -1) break
    const next = lower[open + 2]
    at = open + 2
    if (next !== ' ' && next !== '\n' && next !== '\t' && next !== '\r') continue
    const end = lower.indexOf('>', open)
    if (end === -1) break
    const tag = doc.slice(open, end + 1)
    const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
    // Its words are read from at most 300 characters on, and the closing tag is looked
    // for only there: looked for to the end of the page, 50,000 repeats of one link
    // with no closing tag took quadratic time.
    const window = lower.slice(end + 1, end + 301)
    const close = window.indexOf('</a')
    const inner = doc.slice(end + 1, close === -1 ? end + 301 : end + 1 + close)
    at = end + 1
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) continue
    let href: string
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'), base)
      // Judged on the address as resolved: the parser drops a tab or a newline inside
      // the attribute, so `java<newline>script:` is `javascript:` by now; and a `data:` page is no page.
      if (!LINK_SCHEMES.has(u.protocol)) continue
      u.hash = ''
      href = u.toString()
    } catch {
      continue
    }
    if (seen.has(href)) continue
    seen.add(href)
    const text = inner
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    out.push({ href, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// Where an address came from (0029)
// ---------------------------------------------------------------------------

/**
 * The shape `contacts.email_source` and `contacts.phone_source` hold, as the
 * 0029 CHECK spells it (a test holds the two equal): who or what put the
 * address there.
 *
 *   person            a teammate typed it (a form on /contacts or a company page)
 *   import            a contacts CSV a teammate imported
 *   inbound           a form the person filled in themselves (booking, the free check)
 *   chat              the person the assistant was helping typed it in chat
 *   connector:<name>  a connector's result the assistant was shown (apollo, exa …)
 *   http(s)://…       a page the address was seen on, read by this system
 */
export const ADDRESS_SOURCE_PATTERN = '^(person|import|inbound|chat|connector:[a-z0-9][a-z0-9-]*|https?://\\S+)$'
export const ADDRESS_SOURCE_MAX = 2048

const ADDRESS_SOURCE = new RegExp(ADDRESS_SOURCE_PATTERN)

export function isAddressSource(value: string): boolean {
  return value.length <= ADDRESS_SOURCE_MAX && ADDRESS_SOURCE.test(value)
}

/** A page's address as a person reads it: host and path, no scheme, no `www.`, bounded. */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    const label = `${u.host.replace(/^www\./, '')}${path}`
    return label.length > 80 ? `${label.slice(0, 79)}…` : label
  } catch {
    return url.length > 80 ? `${url.slice(0, 79)}…` : url
  }
}

export interface AddressSourceWords {
  readonly words: string
  readonly tone: 'ok' | 'warn'
}

/**
 * Where an address came from, in a sentence for /contacts, the company page and
 * /approvals. `contactSource` is the contact row's own `source`: an address
 * the ASSISTANT added before sources were kept is the one most likely to be a
 * guess, and is said so.
 */
export function addressSourceWords(source: string | null, contactSource?: string | null): AddressSourceWords {
  if (!source) {
    return contactSource === 'agent'
      ? { words: 'added by the assistant before sources were kept — check it before sending', tone: 'warn' }
      : { words: 'where it came from was not recorded', tone: 'ok' }
  }
  if (source === 'person') return { words: 'typed by a teammate', tone: 'ok' }
  if (source === 'import') return { words: 'from an import', tone: 'ok' }
  if (source === 'inbound') return { words: 'from a form they filled in', tone: 'ok' }
  if (source === 'chat') return { words: 'typed in chat by the person the assistant was helping', tone: 'ok' }
  const connector = /^connector:([a-z0-9][a-z0-9-]*)$/.exec(source)
  if (connector) return { words: `returned by the ${connector[1]} connector — not confirmed on a page`, tone: 'ok' }
  if (/^https?:\/\//.test(source)) return { words: `seen on ${pageLabel(source)}`, tone: 'ok' }
  return { words: 'where it came from was not recorded', tone: 'ok' }
}

// ---------------------------------------------------------------------------
// What a page reader may be pointed at
// ---------------------------------------------------------------------------

const PROBE_SEGMENTS = new Set([
  'wp-admin', 'wp-login', 'wp-login.php', 'wp-config', 'xmlrpc', 'admin', 'administrator', 'phpmyadmin', 'pma',
  'adminer', 'phpinfo', 'cpanel', 'server-status', 'server-info', 'actuator', 'cgi-bin', 'backup', 'backups',
  'config', 'configs', 'private', 'secrets', 'dump', 'db', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
])
const PROBE_EXTENSIONS = new Set([
  'sql', 'bak', 'old', 'orig', 'swp', 'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'env', 'ini', 'log', 'pem', 'key',
  'crt', 'p12', 'pfx', 'conf', 'config', 'cfg', 'yml', 'yaml', 'json', 'xml', 'db', 'sqlite', 'sqlite3', 'dump',
  'git', 'htaccess', 'htpasswd', 'ds_store', 'php~', 'save',
])

/**
 * A path segment as a server may read it: percent-escapes undone until nothing
 * changes (`%252egit` is `.git`), a control character or a space at either end
 * dropped (`admin%00.html`, `admin%20`), a `;` parameter left off
 * (`admin;jsessionid=1`), and a slash an escape put inside it read as the
 * separator a server takes it for (`foo%2f.git%2fconfig` is `foo/.git/config`).
 * Each of those walked past the first version's check.
 */
function segmentsAsRead(segment: string): string[] {
  let value = segment
  for (let i = 0; i < 3; i++) {
    const next = decodePercent(value)
    if (next === value) break
    value = next
  }
  return value
    .toLowerCase()
    .split(/[/\\]/)
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, '').split(';')[0]!.trim())
    .filter(Boolean)
}

/**
 * Why a page reader must not request this address, or null. It reads public
 * web PAGES — what a person would open from a search result — and never what
 * §2.2 forbids the scanner: a hidden file or folder (`/.git`, `/.env`), an
 * admin or login page (`/wp-admin`, `/admin.php`), a backup, a config or a
 * dump. A sitemap is a page list and is allowed; so is
 * `/.well-known/security.txt`. Nor an address with a username or password in
 * it, or a port of its own.
 */
export function readablePathProblem(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only web pages (http or https) are read.'
  if (url.username || url.password) return 'An address with a username or password in it is never read.'
  if (url.port !== '') return 'Only websites on their usual ports are read — not one on port ' + url.port + '.'
  const segments = url.pathname.split('/').filter(Boolean).flatMap(segmentsAsRead)
  const probe =
    'That address looks like a probe for something a site does not publish — a hidden file, an admin or login ' +
    'page, a backup or a configuration file — and the page reader never requests one. It reads public pages only.'
  for (const [i, segment] of segments.entries()) {
    if (segment.startsWith('.')) {
      const securityTxt = segment === '.well-known' && segments[i + 1] === 'security.txt' && segments.length === i + 2
      if (!securityTxt) return probe
    }
    // The name with and without what follows it: `/admin`, `/admin.php` and `/admin%00.html` alike.
    const stem = segment.split(/[^a-z0-9_-]/)[0] ?? segment
    if (PROBE_SEGMENTS.has(segment) || PROBE_SEGMENTS.has(stem)) return probe
  }
  const last = segments.at(-1) ?? ''
  const dot = last.lastIndexOf('.')
  if (dot > 0) {
    const ext = last.slice(dot + 1)
    const sitemap = ext === 'xml' && last.includes('sitemap')
    if (PROBE_EXTENSIONS.has(ext) && !sitemap) return probe
  }
  return null
}

// ---------------------------------------------------------------------------
// A connector that refuses
// ---------------------------------------------------------------------------

export type ConnectorFailureKind = 'auth' | 'quota'

/** Out of quota or credit, in words a page the connector read has no reason to use of itself. */
const QUOTA_OWN =
  /quota|credits? (?:are |have been )?(?:exhausted|exceeded|used up|run out)|out of credits|insufficient (?:credits|balance|funds)|payment required|\b402\b|usage limit|plan limit/
/** A key it lacks or that was refused, said in so many words. */
const AUTH_OWN =
  /invalid (?:api[ _-]?)?key|api[ _-]?keys? (?:is |are )?(?:missing|required|invalid|not (?:found|valid|provided|set|accepted))|missing (?:api[ _-]?)?key|no api[ _-]?key|keyless access is unavailable|create an api key|authentication (?:failed|required|error)|not authenticated|invalid (?:token|credentials|bearer)|(?:token|key) (?:has )?expired|(?:api[ _-]?key|token|credential)s? (?:was |were )?(?:rejected|revoked|not accepted)/
/** A status any server can answer — the connector's, or a page's it was asked to read. */
const QUOTA_STATUS = /\b429\b|too many requests|rate[- ]?limit|excessive requests/
const AUTH_STATUS = /\b401\b|unauthori[sz]ed|forbidden|\b403\b[^\n]{0,80}\b(?:key|token)\b|\b(?:key|token)\b[^\n]{0,80}\b403\b/
/** A page that failed to load, said with no address: "failed to fetch the page". */
const PAGE_FAILED = /failed to (?:fetch|load|read|retrieve|open|access) (?:the )?(?:url|page|site|website)\b/
const WEB_ADDRESS = /https?:\/\//

/**
 * Why a connector's error text is a refusal of ITS OWN — a key it lacks or
 * that was refused, a quota or a rate it ran out of — or null. The explicit
 * words ("invalid API key", "keyless access is unavailable", "quota
 * exceeded") always count. A bare status (401, 403 with "key" or "token",
 * 429, "unauthorized", "forbidden", "rate limit") counts unless it is about a
 * page the connector was asked to read: a web address BEFORE the status
 * ("Failed to scrape https://acme.in: 403 Forbidden" is that site keeping a
 * robot out, and read as the scraper refusing it would stop the scraper for
 * the rest of the turn), or "failed to fetch the page". An address AFTER the
 * status is the connector's own help link ("HTTP 401: Unauthorized. Get your
 * API key at https://…"), and a scraper's own error names its action
 * ("Unexpected error during scrape URL: Status code 401") — the first version
 * read every "scrape" and every nearby address as a page's, and so never saw
 * those two refuse. Reads the first 4,000 characters, where an error says
 * what it is.
 */
export function connectorFailureKind(text: string, server?: string): ConnectorFailureKind | null {
  const t = text.slice(0, 4000).toLowerCase()
  if (QUOTA_OWN.test(t)) return 'quota'
  if (AUTH_OWN.test(t)) return 'auth'
  const quota = t.search(QUOTA_STATUS)
  const auth = t.search(AUTH_STATUS)
  if (quota === -1 && auth === -1) return null
  const status = quota === -1 ? auth : auth === -1 ? quota : Math.min(quota, auth)
  const address = t.search(WEB_ADDRESS)
  if (PAGE_FAILED.test(t)) return null
  if (address !== -1 && address < status && !ownApiAddress(t.slice(address), server)) return null
  return quota !== -1 ? 'quota' : 'auth'
}

/**
 * Whether the web address an error opens with is the connector's OWN service —
 * "Request to https://api.tavily.com/search failed with status 401" is tavily
 * refusing us, not a page tavily was asked to read. Known only when the caller
 * names the server, and only for a name of three letters or more that the
 * address's host carries.
 */
function ownApiAddress(fromAddress: string, server: string | undefined): boolean {
  const name = server?.trim().toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
  if (name.length < 3) return false
  const host = /^https?:\/\/([^/\s:?#]+)/.exec(fromAddress)?.[1] ?? ''
  return host.replace(/[^a-z0-9.]/g, '').split('.').some((label) => label.includes(name))
}

/**
 * The start of an answer shaped like an error: `Error: …`, `HTTP 401`, `{"error": …}`, or a
 * status with its own reason phrase (`429 Too Many Requests`) — never any three digits and a
 * word, which read "429 Lexington Avenue" as a quota and "401 Best Places to Eat" as a key.
 */
const ERROR_SHAPED =
  /^(?:error\s*[:\-–]|error \d{3}\b|http \d{3}\b|[45]\d{2} (?:bad request|unauthori[sz]ed|payment required|forbidden|not found|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)\b|\{\s*"(?:error|errors|detail|message|fault)"\s*:\s*(?!null\b|false\b|""|\[\s*\]|\{\s*\}))/i
const ERROR_STATUS_FIELD = /"(?:status|statusCode|status_code|code)"\s*:\s*"?(?:401|402|403|429)\b/
/** An in-band answer longer than this is a result, not an error message. */
const IN_BAND_ERROR_MAX = 1500

/**
 * Whether one connector result is the connector refusing the call. A result
 * that reads like a page or a search answer is never one, whatever words it
 * contains — a scraped article may well say "unauthorized" or "rate limit".
 * So only an error result (`isError`), or a short answer shaped like an error
 * (`Error: …`, `{"error": …}`, `HTTP 401`, a JSON body whose status is 401,
 * 402, 403 or 429, or a sentence of a few hundred characters saying its key is
 * missing), is read at all.
 */
export function connectorResultFailure(text: string, isError: boolean, server?: string): ConnectorFailureKind | null {
  const trimmed = text.trim()
  const head = trimmed.slice(0, 1200)
  if (isError) return connectorFailureKind(head, server)
  if (trimmed.length > IN_BAND_ERROR_MAX) return null
  const shaped =
    ERROR_SHAPED.test(head) ||
    ERROR_STATUS_FIELD.test(head) ||
    (trimmed.length <= 400 && AUTH_OWN.test(head.toLowerCase()))
  return shaped ? connectorFailureKind(head, server) : null
}
