/**
 * DLT — the rules an Indian commercial SMS must keep before an operator will
 * deliver it, as pure functions over a template's registered body.
 *
 * TRAI's Telecom Commercial Communications Customer Preference Regulations,
 * 2018 (TCCCPR) put every commercial SMS to an Indian number on a
 * Distributed Ledger (DLT): the sender's header and a content template are
 * registered there as a pair, and the operator scrubs each message against
 * them. A message whose text is not the registered body with each
 * `{#var#}` filled in is not delivered. So the send path refuses one before
 * it is handed to a provider (`decideSend`'s `no_template` and
 * `template_mismatch`), and nobody may approve past either: no approval
 * makes a scrubbed message arrive. The fix is a new draft from a registered
 * template.
 *
 * What THIS side enforces: the template is registered and active, the text
 * renders from it, a promotional message waits for its window, and consent
 * exists. The operator does the DND scrub; nothing here can see the DND
 * registry, and nothing pretends to.
 *
 * No I/O, like everything in packages/core. The database reads a template
 * row and hands its body here.
 */

// send.ts imports this module too (the template steps). The cycle is safe:
// neither module reads the other at module scope, only inside functions, and
// `localMinutes` is a hoisted function declaration.
import { localMinutes } from './send.js'
import { normalisePhone } from './normalise.js'

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * DLT's content-template categories (TCCCPR 2018, as the DLT portals list
 * them), for SMS and voice.
 *
 *  - `promotional`       to non-DND numbers only, and only inside TRAI's
 *                        daily band (`PROMOTIONAL_WINDOW`) for an Indian
 *                        number, and 10:00–21:00 where the recipient is for
 *                        any number (`promotionalBand`);
 *  - `transactional`     reserved by the operators for banks' OTPs and
 *                        alerts — an agency template in it is the operator's
 *                        problem to refuse, not ours to guess at;
 *  - `service_implicit`  a message a customer relationship implies;
 *  - `service_explicit`  needs the recipient's explicit consent. Here that is
 *                        a granted SMS consent row — which `decideSend`
 *                        already requires for EVERY SMS (`OPT_IN_ONLY_CHANNELS`),
 *                        so the category adds no second check: an SMS with no
 *                        recorded opt-in is `cold_channel_forbidden` before
 *                        its template is read.
 */
export const SMS_TEMPLATE_CATEGORIES = [
  'promotional', 'transactional', 'service_implicit', 'service_explicit',
] as const
export type SmsTemplateCategory = (typeof SMS_TEMPLATE_CATEGORIES)[number]

/** Meta's WhatsApp template categories. No sending window is attached to them here. */
export const WHATSAPP_TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number]

export type TemplateCategory = SmsTemplateCategory | WhatsAppTemplateCategory

/** The channels a `message_templates` row can be for (0019's CHECK). */
export type TemplateChannel = 'sms' | 'whatsapp' | 'voice'

/** The categories a template on this channel may carry — 0019's CHECK, restated. */
export function templateCategoriesFor(channel: TemplateChannel): readonly TemplateCategory[] {
  return channel === 'whatsapp' ? WHATSAPP_TEMPLATE_CATEGORIES : SMS_TEMPLATE_CATEGORIES
}

/**
 * A category as an export or a person spells it, folded to the stored word,
 * or null. `Service Implicit`, `service-implicit` and `SERVICE_IMPLICIT` are
 * one category; a parenthesised note (`Service Explicit (SE)`) is dropped.
 * Anything that is not one of the channel's categories is null — never the
 * nearest guess, because the category decides the sending window.
 */
export function parseTemplateCategory(raw: string, channel: TemplateChannel): TemplateCategory | null {
  const folded = raw
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  const known = templateCategoriesFor(channel) as readonly string[]
  return known.includes(folded) ? (folded as TemplateCategory) : null
}

/**
 * A DLT header (the SMS sender id), folded to the stored form, or null.
 *
 * Six characters: letters for transactional and service headers, digits for
 * promotional ones. Upper-cased, which is how the portals issue them and
 * what 0019's CHECK stores, so a lower-case copy is the same header rather
 * than a second one.
 */
export function normaliseDltHeader(raw: string): string | null {
  const header = raw.trim().toUpperCase()
  return /^[A-Z0-9]{6}$/.test(header) ? header : null
}

// ---------------------------------------------------------------------------
// The promotional band
// ---------------------------------------------------------------------------

/**
 * TRAI's band for promotional SMS: delivered between 10:00 and 21:00, Indian
 * time — not the 09:00–21:00 of the 2010 regulations it replaced. TCCCPR
 * 2018 divides the day into the time bands TRAI's preference page lists
 * ("00:00 Hrs to 06:00 Hrs, 06:00 Hrs to 08:00 Hrs, 08:00 Hrs to 10:00 Hrs,
 * … 21:00 Hrs to 24:00 Hrs": https://trai.gov.in/preference-registration),
 * and makes the bands before 10:00 and after 21:00 "default OFF for all
 * customers irrespective of the status of registration of customer
 * preference(s)" (the regulation as published,
 * https://www.trai.gov.in/sites/default/files/2024-09/RegulationUcc19072018.pdf
 * — a scanned PDF, so that wording was read through a search index rather
 * than out of the file). The operators implement it by holding promotional
 * traffic outside 10:00–21:00 IST; one carrier-side summary:
 * https://c2sms.com/implementation-of-trai-regulation-tcccpr-2018-regarding-promotional-sms/
 * ("Promotional SMS will be delivered between 10 am – 9 pm IST").
 *
 * The END is exclusive: 21:00 is outside.
 */
export const PROMOTIONAL_WINDOW = Object.freeze({
  start: 10 * 60,
  end: 21 * 60,
  zone: 'Asia/Kolkata',
  words: '10:00–21:00 India time',
  /** The same hours with no zone, for the recipient's own clock. */
  hours: '10:00–21:00',
})

/**
 * Whether this is a number TRAI's band governs: an Indian one, `+91`.
 *
 * Read through `normalisePhone`, so `0091 98765 43210` is Indian and a
 * number with no country code is NOT — unknown is not Indian, and the band
 * it would add can only defer a message, never send one sooner.
 */
export function isIndianNumber(recipient: string): boolean {
  return normalisePhone(recipient)?.startsWith('+91') ?? false
}

/** What `promotionalBand` answers. */
export interface PromotionalBand {
  /** The message may go now. */
  readonly open: boolean
  /** TRAI's IST band applied: the recipient is an Indian number. */
  readonly india: boolean
  /**
   * Some minute of the day, at the UTC offsets in force at `now`, is inside
   * every band that applies. False only for an Indian number read in a zone
   * whose 10:00–21:00 never meets IST's — Denver and Phoenix all year, Los
   * Angeles on daylight time — which is a message that has no moment it may
   * go, not one that is early.
   */
  readonly opensToday: boolean
  /**
   * The first whole minute after the current one at which the band is open,
   * at the offsets in force at `now` — within the next 24 hours, so null
   * exactly when `opensToday` is false. The band alone: the send path asks
   * `nextOpenMinute` itself for a minute the campaign's quiet hours leave
   * open as well.
   */
  readonly nextOpen: Date | null
}

/**
 * Whether a minute is inside every promotional band that applies:
 * 10:00–21:00 on the recipient's clock, and on India's for an Indian number.
 * Both are minutes past local midnight.
 */
export function insidePromotionalBand(local: number, india: number, indianNumber: boolean): boolean {
  const inside = (m: number): boolean => m >= PROMOTIONAL_WINDOW.start && m < PROMOTIONAL_WINDOW.end
  return inside(local) && (!indianNumber || inside(india))
}

/**
 * The first whole minute after `now`'s at which `open` holds, within the
 * next 24 hours — or null when none does, or when either zone is not one the
 * runtime knows.
 *
 * `open` is asked about each minute as two wall clocks, minutes past
 * midnight in `recipientTimeZone` and in India, read at the UTC offsets in
 * force at `now`: 1,440 comparisons and no calendar maths, which is what
 * `promotionalBand` always walked. A daylight-saving change inside the next
 * day can move the true opening by the size of the change; that errs safe,
 * because whoever waits for the minute asks every rule again when it comes,
 * and a minute that turns out to be shut is deferred again, never sent early.
 *
 * The whole minute is the answer, not `now` plus a whole number of minutes:
 * a band that opens at 10:00 is open from 10:00:00, and a sender that waits
 * for it should not arrive at 10:00:42 and call that the first chance.
 */
export function nextOpenMinute(
  now: Date,
  recipientTimeZone: string,
  open: (local: number, india: number) => boolean,
): Date | null {
  const local = localMinutes(now, recipientTimeZone)
  const india = localMinutes(now, PROMOTIONAL_WINDOW.zone)
  if (local === null || india === null) return null
  const day = 24 * 60
  const wrap = (m: number): number => ((m % day) + day) % day
  const minute = Math.floor(now.getTime() / 60_000)
  for (let k = 1; k <= day; k += 1) {
    if (open(wrap(local + k), wrap(india + k))) return new Date((minute + k) * 60_000)
  }
  return null
}

/**
 * Whether a PROMOTIONAL message may go now: 10:00–21:00 where the recipient
 * is, always, AND inside TRAI's band in India when the number is Indian.
 *
 * The band is the Indian operators', in IST — they hold promotional traffic
 * to an Indian number outside it whatever zone the contact record names, and
 * it says nothing about anybody else's number. The recipient's hours are
 * §2.1's rule that the clock is always read where the person lives. For an
 * Indian number in India the two are the same; for one recorded elsewhere
 * both hold, and they can fail to overlap at all — `opensToday` says so,
 * because "it goes when the band opens" is false for a band that never does.
 * Checking both can only DEFER a message, never send one sooner.
 *
 * "Today" is the offsets in force at `now`: a daylight-saving change can
 * open or close the overlap (Los Angeles has half an hour of it in winter,
 * none in summer), and the answer is about the clocks as they are.
 *
 * `nextOpen` is the first whole minute after `now`'s at which it is open.
 * Some overlaps are half an hour wide — an Indian number read in New York or
 * Los Angeles in winter, or in Chicago in summer — and a sender that came
 * back an hour later each time stepped over one for days (review round 5),
 * so the send path names the minute instead (`SendRefusal.retryAt`).
 *
 * Null when the recipient's zone is not one the runtime knows — the caller
 * has already refused that as `unknown_timezone`.
 */
export function promotionalBand(now: Date, recipientTimeZone: string, recipient: string): PromotionalBand | null {
  const local = localMinutes(now, recipientTimeZone)
  const india = localMinutes(now, PROMOTIONAL_WINDOW.zone)
  if (local === null || india === null) return null
  const indian = isIndianNumber(recipient)
  // Every minute of the next day read through both clocks: 1,440 comparisons
  // at most, and no calendar maths. The same wall-clock minute tomorrow is the
  // last one asked, so a band open now always has a next open minute, and
  // "none in the next day" is "none at all" at today's clocks.
  const nextOpen = nextOpenMinute(now, recipientTimeZone, (l, i) => insidePromotionalBand(l, i, indian))
  return { open: insidePromotionalBand(local, india, indian), india: indian, opensToday: nextOpen !== null, nextOpen }
}

// ---------------------------------------------------------------------------
// The body: literal text and {#var#} slots
// ---------------------------------------------------------------------------

/**
 * The most a filled variable may hold: 30 characters, for English and
 * Unicode alike, spaces and punctuation included. The limit the DLT
 * portals publish for `{#var#}` (one summary of it:
 * https://www.smsdeals.co.in/blog/variable-vexations-mastering-the-var-placeholder-in-dlt-content-templates;
 * a template that needs more registers two adjacent slots). Counted in
 * CODE POINTS, so a Hindi or emoji value is measured as the operator counts
 * characters, not as JavaScript counts UTF-16 units.
 */
export const DLT_VAR_MAX_CHARS = 30

/**
 * The placeholders a registered body may carry, and what each may be filled
 * with. `{#var#}` is DLT's own; the rest are the "pre-tagged" kinds the
 * portals added for TRAI's direction of 20 August 2024 (URLs, APKs, OTT
 * links and call-back numbers in commercial SMS must be whitelisted, and a
 * variable may carry only what it was tagged for — PIB release:
 * https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2058943).
 *
 * A new kind is ONE line here. A body naming a kind that is not listed is
 * refused when it is parsed (`unknown_variable`) rather than read as literal
 * text or as a `{#var#}`: either guess would make every message from it fail
 * the operator's scrub, or pass ours while failing theirs.
 */
const VARIABLE_KINDS = {
  // A plain slot takes any text; what it must not put in the message — a
  // link, a call-back number — is judged on the RENDERED text
  // (`smuggledRuns`), because a value can make one with its neighbour.
  var: () => true,
  numeric: (v: string) => /^[0-9]+$/.test(v),
  alphanumeric: (v: string) => /^[\p{L}\p{N}]+$/u.test(v),
  url: (v: string) => /^https?:\/\/\S+$/i.test(v),
  urlott: (v: string) => /^https?:\/\/\S+$/i.test(v),
  cbn: (v: string) => /^\+?[0-9]{6,15}$/.test(v),
  email: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
} as const satisfies Readonly<Record<string, (value: string) => boolean>>

export type DltVariableKind = keyof typeof VARIABLE_KINDS

// ---------------------------------------------------------------------------
// Links and call-back numbers, judged on the rendered text
// ---------------------------------------------------------------------------

/**
 * What a slot must not put in the message unless it was registered for it.
 * Under TRAI's August 2024 direction a URL or a call-back number in a
 * commercial SMS must be whitelisted — part of the registered template, or
 * in a variable tagged for it — and the operator blocks one smuggled through
 * a plain `{#var#}`. Refused here, before anybody is asked to approve it.
 *
 * Judged on the RENDERED text, never value by value: `https:/` and
 * `/evil.example/x` in two adjacent slots are each harmless and together a
 * link, and `98765` beside a literal ` 43210` is a phone number. A run the
 * template's own fixed text makes on its own is the registered text, and
 * passes.
 */
type Smuggled = 'link' | 'number'

/**
 * The slot kinds registered to carry each: a link in `{#url#}` (and the
 * domain inside an `{#email#}`), digits in `{#cbn#}` and `{#numeric#}` —
 * numeric is exempt because an order number or an OTP is what it is for,
 * and the digits in a tagged link's path are the link's. `var` and
 * `alphanumeric` carry neither.
 */
const CARRIES: Readonly<Record<Smuggled, ReadonlySet<DltVariableKind>>> = {
  link: new Set<DltVariableKind>(['url', 'urlott', 'email']),
  number: new Set<DltVariableKind>(['cbn', 'numeric', 'url', 'urlott', 'email']),
}

/**
 * The top-level domains a BARE host must end in to read as a link with no
 * path after it: `acme.in`, `acme.co.in`, `acme.com`. A host WITH a path
 * (`tinyurl.com/abc`, `wa.me/9198…`, `bit.ly/x`) is a link whatever its TLD,
 * which is how every shortener is caught. The list leaves out the TLDs that
 * are English words (`me`, `to`, `be`, `at`, `is`, `it`, `no`, `us`), because
 * "Dr.Rao" or a missing space after a full stop must not read as a link; a
 * shortener on one of them always has a path.
 */
const BARE_LINK_TLDS: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'info', 'biz', 'in', 'co', 'io', 'ai', 'app', 'dev', 'xyz', 'online', 'site',
  'website', 'shop', 'store', 'tech', 'ly', 'gl', 'gd', 'cc', 'tv', 'uk', 'ca', 'au', 'de', 'fr', 'eu',
  'sg', 'ae', 'pk', 'bd', 'lk', 'np', 'cn', 'ru', 'top', 'club', 'live', 'link', 'page', 'cloud',
])

/** `scheme://…` — any scheme, not only http(s). */
const LINK_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/\S*/giu
/** `www.<name>.<anything>`, whatever its TLD. */
const LINK_WWW = /\bwww\.[^\s.]+\.\S+/giu
/**
 * `label.label.tld` with an optional `/path`. Not when it is part of a
 * longer word, a decimal, or an email address (after or before an `@`).
 */
const LINK_HOST =
  /(?<![\p{L}\p{N}@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?![\p{L}\p{N}@-])(\/\S*)?/giu

/**
 * A run of digits a person could dial: an optional `+`, then digits with
 * spaces, dashes, dots and brackets between them, standing apart from any
 * letter or digit — so `INV1234567` is a reference, not a number.
 */
const NUMBER_RUN = /(?<![\p{L}\p{N}+])\+?\(?\d[\d\s().-]*\d(?![\p{L}\p{N}])/gu
/**
 * Digit shapes that are not phone numbers, blanked before `NUMBER_RUN` reads
 * the text: a date (`15-09-2026`, `15.09.2026`, `2026-09-15`), a time
 * (`10:30`, `10.30`), and an amount with paise or cents (`123456.78`).
 * Amounts with thousands separators (`1,200`, `1,20,000`) need no rule: a
 * comma ends a run.
 */
const NOT_A_NUMBER = [
  /(?<!\d)(?:\d{1,2}[-./]\d{1,2}[-./](?:\d{4}|\d{2})|\d{4}[-./]\d{1,2}[-./]\d{1,2})(?!\d)/g,
  /(?<!\d)\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?!\d)/g,
  /(?<!\d)\d+\.\d{2}(?!\d)/g,
] as const
/** A currency just before a run makes it an amount: `Rs 1500000`, `₹ 2500000`. */
const CURRENCY_BEFORE = /(?:₹|\$|€|£|\b(?:rs|inr|usd|eur|gbp))\.?\s*$/iu

interface SmuggledRun {
  readonly kind: Smuggled
  /** Code points, half-open, like `matchesTemplate`'s positions. */
  readonly start: number
  readonly end: number
}

/**
 * Every link and every phone-number-shaped run in `text`, in code points.
 *
 * A phone number is 7 to 15 digits (E.164 allows no more) with at least one
 * group of three together, so a list like `10 20 30 40` or a time range is
 * not one, and anything longer than 15 digits is a reference number. Kept
 * deliberately loose about formatting and strict about shape: the cost of a
 * miss is one text the operator blocks; the cost of a false alarm is a
 * person who cannot type a date.
 */
function smuggledRuns(text: string): readonly SmuggledRun[] {
  // UTF-16 index -> code-point index, because the matcher counts code points.
  const at: number[] = []
  let cp = 0
  for (let i = 0; i < text.length; i += 1) {
    at.push(cp)
    // A high surrogate followed by a low one is the first half of ONE code
    // point; anything else, a lone half included, is one on its own — as
    // `Array.from` counts.
    const high = text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff
    const low = text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
    if (!(high && low)) cp += 1
  }
  at.push(cp)
  const runs: SmuggledRun[] = []
  const add = (kind: Smuggled, from: number, to: number): void => {
    runs.push({ kind, start: at[from] ?? 0, end: at[to] ?? cp })
  }
  for (const re of [LINK_SCHEME, LINK_WWW]) {
    for (const m of text.matchAll(re)) add('link', m.index ?? 0, (m.index ?? 0) + m[0].length)
  }
  for (const m of text.matchAll(LINK_HOST)) {
    const tld = (m[1] ?? '').toLowerCase()
    if (m[2] !== undefined || BARE_LINK_TLDS.has(tld)) add('link', m.index ?? 0, (m.index ?? 0) + m[0].length)
  }
  let digits = text
  for (const re of NOT_A_NUMBER) digits = digits.replace(re, (d) => 'x'.repeat(d.length))
  for (const m of digits.matchAll(NUMBER_RUN)) {
    const from = m.index ?? 0
    const count = m[0].replace(/\D/g, '').length
    if (count < 7 || count > 15 || !/\d{3}/.test(m[0])) continue
    if (CURRENCY_BEFORE.test(text.slice(Math.max(0, from - 8), from))) continue
    add('number', from, from + m[0].length)
  }
  return runs
}

/** The words for a slot that put one in the message. Never the value: it may be a person's name. */
const SMUGGLED_WORDS: Readonly<Record<Smuggled, string>> = {
  link:
    'it puts a link in the message (on its own, or joined to the text beside it), which TRAI requires to be ' +
    'whitelisted and sent in a variable registered for links.',
  number:
    'it puts a phone number in the message (on its own, or joined to the text beside it), which TRAI requires ' +
    'to be part of the registered template or sent in a variable registered for one ({#cbn#}).',
}

/**
 * For each code point of a rendered text, how many before it each kind of
 * run covers — so "does a slot at [from, to) touch a run its kind may not
 * carry" is two subtractions, inside `matchesTemplate`'s inner loop.
 */
function coverage(runs: readonly SmuggledRun[], length: number): Readonly<Record<Smuggled, readonly number[]>> {
  const marks: Record<Smuggled, Uint8Array> = { link: new Uint8Array(length), number: new Uint8Array(length) }
  for (const r of runs) marks[r.kind].fill(1, r.start, r.end)
  const prefix = (mark: Uint8Array): number[] => {
    const out = [0]
    for (let i = 0; i < length; i += 1) out.push((out[i] ?? 0) + (mark[i] ?? 0))
    return out
  }
  return { link: prefix(marks.link), number: prefix(marks.number) }
}

/** The kind of run a slot of `variable` at [from, to) would smuggle, or null. */
function smuggles(
  cover: Readonly<Record<Smuggled, readonly number[]>>,
  variable: DltVariableKind,
  from: number,
  to: number,
): Smuggled | null {
  for (const kind of ['link', 'number'] as const) {
    if (CARRIES[kind].has(variable)) continue
    if ((cover[kind][to] ?? 0) - (cover[kind][from] ?? 0) > 0) return kind
  }
  return null
}

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly variable: DltVariableKind }

/** A registered body read into literal text and slots, in order. */
export interface ParsedTemplate {
  readonly parts: readonly TemplatePart[]
  /** How many values `renderTemplate` needs, in order. */
  readonly slots: number
}

export type TemplateParse =
  | { readonly ok: true; readonly template: ParsedTemplate }
  | { readonly ok: false; readonly reason: 'empty' | 'unknown_variable'; readonly message: string }

const PLACEHOLDER = /\{#([A-Za-z]+)#\}/g

/**
 * Read a registered body into literal segments and `{#…#}` slots.
 *
 * The kind is read case-insensitively (`{#VAR#}` is `{#var#}`). Text that
 * merely looks like the start of one (`{#`, `{# var #}`) is literal, because
 * the portals do not read it as a variable either. Adjacent literals are
 * never produced: the parts alternate wherever a body allows it, and two
 * slots side by side (`{#var#}{#var#}`, DLT's way of carrying more than 30
 * characters) are two slots with no text between them.
 */
export function parseTemplate(body: string): TemplateParse {
  if (body.trim() === '') return { ok: false, reason: 'empty', message: 'The template has no text.' }
  const parts: TemplatePart[] = []
  let at = 0
  let slots = 0
  for (const m of body.matchAll(PLACEHOLDER)) {
    const kind = (m[1] ?? '').toLowerCase()
    if (!Object.hasOwn(VARIABLE_KINDS, kind)) {
      return {
        ok: false,
        reason: 'unknown_variable',
        message:
          `The template names a variable kind this system does not know, {#${m[1] ?? ''}#}. ` +
          `It reads ${Object.keys(VARIABLE_KINDS).map((k) => `{#${k}#}`).join(', ')}.`,
      }
    }
    const index = m.index ?? 0
    if (index > at) parts.push({ kind: 'text', text: body.slice(at, index) })
    parts.push({ kind: 'slot', variable: kind as DltVariableKind })
    slots += 1
    at = index + m[0].length
  }
  if (at < body.length) parts.push({ kind: 'text', text: body.slice(at) })
  return { ok: true, template: { parts, slots } }
}

export type RenderRefusal =
  | 'bad_template'
  | 'missing_var'
  | 'extra_var'
  | 'blank_var'
  | 'var_too_long'
  | 'var_wrong_kind'

export type TemplateRender =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false
      readonly reason: RenderRefusal
      /** 1-based, for a person; absent when the refusal is about the whole call. */
      readonly slot?: number
      /** One sentence, naming the slot and the rule. Never the value: it may be a person's name. */
      readonly message: string
    }

/**
 * Fill a registered body's slots, in order, or say why not.
 *
 * Refused: too few values, too many, a blank one, one over
 * `DLT_VAR_MAX_CHARS` code points, one its slot's kind does not accept, and
 * — judged on the rendered text, after every value passed on its own — one
 * that puts a link or a phone number in the message through a slot not
 * registered for it, alone or joined to its neighbours (`smuggledRuns`).
 * Each of those is a message the operator would scrub, so refusing it here
 * is what keeps a person from approving words that cannot arrive.
 */
export function renderTemplate(template: string | ParsedTemplate, vars: readonly string[]): TemplateRender {
  const parsed = typeof template === 'string' ? parseTemplate(template) : { ok: true as const, template }
  if (!parsed.ok) return { ok: false, reason: 'bad_template', message: parsed.message }
  const { parts, slots } = parsed.template
  if (vars.length < slots) {
    return {
      ok: false,
      reason: 'missing_var',
      slot: vars.length + 1,
      message: `The template has ${slots} variable${slots === 1 ? '' : 's'} and ${vars.length} ${vars.length === 1 ? 'was' : 'were'} given.`,
    }
  }
  if (vars.length > slots) {
    return {
      ok: false,
      reason: 'extra_var',
      slot: slots + 1,
      message: `The template has ${slots} variable${slots === 1 ? '' : 's'} and ${vars.length} were given; the extra one would not be sent as registered.`,
    }
  }
  let out = ''
  let n = 0
  let length = 0
  const placed: { readonly variable: DltVariableKind; readonly from: number; readonly to: number }[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text
      length += Array.from(part.text).length
      continue
    }
    const value = vars[n] ?? ''
    n += 1
    const refusal = refuseValue(part.variable, value)
    if (refusal) return { ok: false, reason: refusal.reason, slot: n, message: `Variable ${n}: ${refusal.message}` }
    const width = Array.from(value).length
    placed.push({ variable: part.variable, from: length, to: length + width })
    out += value
    length += width
  }
  // Every value is right on its own; now what they make together, with the
  // literal text between them. The first slot to touch a link or a number
  // it was not registered for is the one named.
  const cover = coverage(smuggledRuns(out), length)
  for (let i = 0; i < placed.length; i += 1) {
    const slot = placed[i]
    const kind = slot ? smuggles(cover, slot.variable, slot.from, slot.to) : null
    if (kind) return { ok: false, reason: 'var_wrong_kind', slot: i + 1, message: `Variable ${i + 1}: ${SMUGGLED_WORDS[kind]}` }
  }
  return { ok: true, text: out }
}

function refuseValue(
  variable: DltVariableKind,
  value: string,
): { reason: Exclude<RenderRefusal, 'bad_template' | 'missing_var' | 'extra_var'>; message: string } | null {
  if (value.trim() === '') return { reason: 'blank_var', message: 'it is blank, so the message would read as a gap.' }
  const length = Array.from(value).length
  if (length > DLT_VAR_MAX_CHARS) {
    return {
      reason: 'var_too_long',
      message: `it is ${length} characters, and a DLT variable holds at most ${DLT_VAR_MAX_CHARS}.`,
    }
  }
  if (!VARIABLE_KINDS[variable](value)) {
    return { reason: 'var_wrong_kind', message: `it is not what a {#${variable}#} slot was registered to carry.` }
  }
  return null
}

/**
 * Whether `text` is this template with every slot filled by a value that
 * slot accepts — the scrub the operator runs, run first.
 *
 * Exact: no whitespace is folded and no case is ignored, because the
 * operator does neither. Compared in CODE POINTS, so a surrogate pair is
 * never split between a literal and a slot. A dynamic-programming match over
 * (part, position) rather than a regular expression: literal text never has
 * to be escaped (a `.` or `$` in a body is a `.` or a `$`), and adjacent
 * slots cannot send a backtracking engine exponential. A template that does
 * not parse matches nothing.
 *
 * The links and phone numbers in the text are found once, over the whole
 * text (`smuggledRuns`), and a slot may not be placed over any part of one
 * its kind was not registered for — the renderer's rule, so a text the
 * renderer refuses is refused here too, whatever wrote it.
 */
export function matchesTemplate(text: string, template: string | ParsedTemplate): boolean {
  const parsed = typeof template === 'string' ? parseTemplate(template) : { ok: true as const, template }
  if (!parsed.ok) return false
  const chars = Array.from(text)
  const parts = parsed.template.parts.map((p) =>
    p.kind === 'text' ? { kind: 'text' as const, chars: Array.from(p.text) } : p,
  )
  // A link or a number in the text may lie in literal text, or in a slot
  // registered for it — never in a plain one (`smuggledRuns`).
  const cover = coverage(smuggledRuns(text), chars.length)
  // reachable[i] = the positions in `chars` at which part i can start.
  let positions = new Set<number>([0])
  for (const part of parts) {
    const next = new Set<number>()
    for (const at of positions) {
      if (part.kind === 'text') {
        const lit = part.chars
        let ok = at + lit.length <= chars.length
        for (let k = 0; ok && k < lit.length; k += 1) ok = chars[at + k] === lit[k]
        if (ok) next.add(at + lit.length)
      } else {
        for (let len = 1; len <= DLT_VAR_MAX_CHARS && at + len <= chars.length; len += 1) {
          if (smuggles(cover, part.variable, at, at + len) !== null) continue
          if (refuseValue(part.variable, chars.slice(at, at + len).join('')) === null) next.add(at + len)
        }
      }
    }
    if (next.size === 0) return false
    positions = next
  }
  return positions.has(chars.length)
}

// ---------------------------------------------------------------------------
// The SMS opt-out reader
// ---------------------------------------------------------------------------

/**
 * The keywords that are an opt-out on their own, as the whole message: the
 * industry's standard set. CANCEL, END and QUIT are opt-outs ONLY alone —
 * "cancel tomorrow's call" is somebody rearranging a meeting.
 */
const SMS_STOP_WORDS = ['stop', 'stopall', 'stop all', 'unsubscribe', 'unsub', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out']

/**
 * The keywords that may carry ONE trailing token — the "reply STOP <code>"
 * forms a commercial SMS footer asks for (`STOP 56161`, `STOP ACMEIN`,
 * `UNSUBSCRIBE ALL`), with an `all` allowed before the token
 * (`STOP ALL 56161`, `UNSUBSCRIBE ALL ACMEIN`) and a comma, colon or dash
 * allowed after the keyword (`STOP-56161`, `STOP: ACMEIN`). A token is one
 * run of letters or digits, never a sentence.
 */
const SMS_STOP_WITH_TOKEN = ['stop', 'stopall', 'unsubscribe', 'unsub', 'optout', 'opt out', 'opt-out']
const SMS_STOP_TOKEN_TAIL = /^[\s,:;-]+(?:all[\s,:;-]+)?[\p{L}\p{N}]{1,20}$/u

/**
 * SMS-shaped prose that says stop in so many words, whole-message only —
 * and, after it, the whole-message forms of the email reader
 * (`looksLikeOptOut` in packages/db), which the SMS recorder runs beside this
 * one. Restated here so that a decoration at the ends the email reader does
 * not strip ("Remove me 🙏", "Please stop :)") does not lose an opt-out both
 * readers would otherwise have read. The apostrophe may be the typewriter one
 * or the curly one a phone's keyboard puts in by default.
 *
 * Politeness is read at BOTH ends: "please" before the words, and one
 * "please", "pls", "plz", "thanks", "thank you" or "thx" after them, set off
 * by a space, a comma or a full stop ("Stop texting me, please.",
 * "Unsubscribe me. Thanks"). Review round 5 found it read only as a prefix,
 * so "stop messaging me please" and "no more messages please" were an
 * ordinary reply to both readers — paused, never suppressed, and resumable.
 * And a phone's shorthand is read where the word is: "msg" and "msgs" beside
 * "message", "txt" beside "text", "sms" beside both ("Dont msg me", "no more
 * msgs pls"). The trailing word is anchored like everything else here — it
 * follows a whole stop sentence and ends the message — so "stop by tomorrow
 * please" and "don't stop texting me please" are still not opt-outs, and
 * CANCEL, END and QUIT are still opt-outs only alone.
 */
const SMS_MESSAGES = '(?:messages?|msgs?|texts?|txts?|sms)'
const SMS_TO_MESSAGE = '(?:text|txt|message|msg|sms|contact|email)'
const SMS_STOP_PROSE = new RegExp(
  '^(?:(?:please|pls|plz|kindly)\\s+)?(?:' +
    [
      `stop\\s+(?:texting|txting|messaging|msging|msg|sms(?:ing)?|sending\\s+(?:me\\s+)?${SMS_MESSAGES})(?:\\s+me)?`,
      `(?:do\\s+not|don['’]?t)\\s+${SMS_TO_MESSAGE}\\s+me(?:\\s+again)?`,
      `no\\s+more\\s+(?:${SMS_MESSAGES}|emails?)`,
      'stop',
      'unsubscribe(?:\\s+me)?',
      'remove\\s+me(?:\\s+from\\s+(?:your|the|this)\\s+(?:(?:mailing|sms|text(?:ing)?|contact)\\s+)?list)?',
      'opt(?:\\s+me)?[\\s-]?out',
      'take\\s+me\\s+off\\s+(?:your|the)\\s+list',
      'leave\\s+me\\s+alone',
    ].join('|') +
    ')(?:[\\s,.!]+(?:please|pls|plz|thanks|thank\\s+you|thx))?$',
  'u',
)

/**
 * What may decorate an SMS at either END without changing what it says:
 * whitespace, punctuation, symbols and emoji — a `)`, a `¡`, quotes, `:)`,
 * `👍🏽`, a flag, a keycap's combining marks. Stripped only from the ends, so
 * "Don't stop! 👍" is still prose about not stopping; digits and letters are
 * never stripped, so a short code survives.
 */
const SMS_DECORATION =
  '[\\s\\p{P}\\p{S}\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200d\\ufe0e\\ufe0f\\u20e3]+'
const SMS_DECORATION_ENDS = new RegExp(`^${SMS_DECORATION}|${SMS_DECORATION}$`, 'gu')

/**
 * Is this SMS an opt-out?
 *
 * Whole-message and case-insensitive: STOP, STOPALL, UNSUBSCRIBE, CANCEL,
 * END, QUIT and OPT OUT alone; the stop keywords followed by one token (a
 * short code or a brand keyword), with an optional `all` before it; any of
 * them after "reply", "sms", "text" or "send" (somebody repeating the footer
 * back); and a few SMS-shaped sentences ("stop texting me", "don't text me
 * again", "please stop", "no more msgs pls"), with one "please" or "thanks"
 * before or after them. Whitespace, punctuation, symbols and emoji at
 * either end are ignored — `STOP)`, `¡STOP!`, `STOP 👍`, `"STOP"` — and the
 * text is NFKC-folded so full-width letters read as letters.
 *
 * Deliberately narrow in the middle, like the email reader beside the send
 * path (`looksLikeOptOut` in packages/db), which the SMS recorder runs TOO —
 * this adds the keyword forms an SMS footer teaches people, and the
 * decoration a phone keyboard adds. A match writes a SUPPRESSION, the
 * strongest thing this system does, so a message that merely contains "stop"
 * somewhere is not one ("stop by tomorrow", "don't stop"); every SMS reply
 * pauses the person anyway. But a missed STOP is the worse error — it is
 * stored as an ordinary reply, which answering it can resume — so the ends
 * are read generously. CANCEL, END and QUIT stay opt-outs only alone.
 */
export function smsOptOut(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(SMS_DECORATION_ENDS, '')
    .replace(/\s+/gu, ' ')
  if (!t) return false
  const bare = t.replace(/^(?:reply|sms|text|send)\s+/, '')
  if (SMS_STOP_WORDS.includes(bare)) return true
  for (const word of SMS_STOP_WITH_TOKEN) {
    if (bare.startsWith(word) && SMS_STOP_TOKEN_TAIL.test(bare.slice(word.length))) return true
  }
  return SMS_STOP_PROSE.test(bare)
}
