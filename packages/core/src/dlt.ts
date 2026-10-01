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

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * DLT's content-template categories (TCCCPR 2018, as the DLT portals list
 * them), for SMS and voice.
 *
 *  - `promotional`       to non-DND numbers only, and only inside TRAI's
 *                        daily band (`PROMOTIONAL_WINDOW`);
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
})

/**
 * Whether a PROMOTIONAL message may go now: inside TRAI's band in India,
 * AND inside the same hours where the recipient is.
 *
 * Both, because they answer different questions. The band is the
 * operator's, in IST — outside it the message is held or dropped whatever
 * zone the contact record names. The recipient's zone is §2.1's rule that
 * the clock is always read where the person lives; for an Indian number the
 * two are the same zone, and for anyone else the stricter of the two holds.
 * Checking both can only DEFER a message, never send one sooner.
 *
 * Null when the recipient's zone is not one the runtime knows — the caller
 * has already refused that as `unknown_timezone`.
 */
export function promotionalWindowOpen(now: Date, recipientTimeZone: string): boolean | null {
  const local = localMinutes(now, recipientTimeZone)
  const india = localMinutes(now, PROMOTIONAL_WINDOW.zone)
  if (local === null || india === null) return null
  const inside = (m: number): boolean => m >= PROMOTIONAL_WINDOW.start && m < PROMOTIONAL_WINDOW.end
  return inside(local) && inside(india)
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
  var: (v: string) => !carriesLink(v),
  numeric: (v: string) => /^[0-9]+$/.test(v),
  alphanumeric: (v: string) => /^[\p{L}\p{N}]+$/u.test(v),
  url: (v: string) => /^https?:\/\/\S+$/i.test(v),
  urlott: (v: string) => /^https?:\/\/\S+$/i.test(v),
  cbn: (v: string) => /^\+?[0-9]{6,15}$/.test(v),
  email: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
} as const satisfies Readonly<Record<string, (value: string) => boolean>>

export type DltVariableKind = keyof typeof VARIABLE_KINDS

/**
 * A link in a variable that was not tagged for one. Under TRAI's August 2024
 * direction a URL in a commercial SMS must be whitelisted and sit in a
 * variable tagged for it; one smuggled into a plain `{#var#}` is blocked by
 * the operator. Refused here, before anybody is asked to approve it.
 */
function carriesLink(value: string): boolean {
  return /\bhttps?:\/\/|\bwww\.[^\s.]+\.[^\s]/i.test(value)
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
 * `DLT_VAR_MAX_CHARS` code points, and one its slot's kind does not accept —
 * a link in a plain `{#var#}` included. Each of those is a message the
 * operator would scrub, so refusing it here is what keeps a person from
 * approving words that cannot arrive.
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
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text
      continue
    }
    const value = vars[n] ?? ''
    n += 1
    const refusal = refuseValue(part.variable, value)
    if (refusal) return { ok: false, reason: refusal.reason, slot: n, message: `Variable ${n}: ${refusal.message}` }
    out += value
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
    return {
      reason: 'var_wrong_kind',
      message:
        variable === 'var'
          ? 'it carries a link, which TRAI requires to be whitelisted and sent in a variable registered for links.'
          : `it is not what a {#${variable}#} slot was registered to carry.`,
    }
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
 */
export function matchesTemplate(text: string, template: string | ParsedTemplate): boolean {
  const parsed = typeof template === 'string' ? parseTemplate(template) : { ok: true as const, template }
  if (!parsed.ok) return false
  const chars = Array.from(text)
  const parts = parsed.template.parts.map((p) =>
    p.kind === 'text' ? { kind: 'text' as const, chars: Array.from(p.text) } : p,
  )
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
 * `UNSUBSCRIBE ALL`). A token is one run of letters or digits, never a
 * sentence.
 */
const SMS_STOP_WITH_TOKEN = ['stop', 'stopall', 'unsubscribe', 'optout', 'opt out', 'opt-out']

/** SMS-shaped prose that says stop in so many words, whole-message only. */
const SMS_STOP_PROSE =
  /^(?:please\s+)?(?:stop\s+(?:texting|messaging|sms(?:ing)?|sending\s+(?:me\s+)?(?:texts|messages|sms))(?:\s+me)?|(?:do\s+not|don'?t)\s+(?:text|message|sms)\s+me(?:\s+again)?|no\s+more\s+(?:texts|messages|sms))$/

/**
 * Is this SMS an opt-out?
 *
 * Whole-message and case-insensitive: STOP, STOPALL, UNSUBSCRIBE, CANCEL,
 * END, QUIT and OPT OUT alone; the stop keywords followed by one token (a
 * short code or a brand keyword); any of them after "reply", "sms", "text"
 * or "send" (somebody repeating the footer back); and a few SMS-shaped
 * sentences ("stop texting me", "don't text me again"). Surrounding
 * whitespace and closing punctuation are ignored, and the text is NFKC-folded
 * so full-width letters read as letters.
 *
 * Deliberately narrow, like the email reader beside the send path
 * (`looksLikeOptOut` in packages/db), which the SMS recorder runs TOO — this
 * adds the keyword forms an SMS footer teaches people, and leaves prose to
 * the reader that already decides it. A match writes a SUPPRESSION, the
 * strongest thing this system does, so a message that merely contains "stop"
 * somewhere is not one; every SMS reply pauses the person anyway.
 */
export function smsOptOut(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.!,;:]+$/u, '')
    .replace(/^\s+/u, '')
    .replace(/\s+/gu, ' ')
  if (!t) return false
  const bare = t.replace(/^(?:reply|sms|text|send)\s+/, '')
  if (SMS_STOP_WORDS.includes(bare)) return true
  for (const word of SMS_STOP_WITH_TOKEN) {
    if (bare.startsWith(`${word} `) && /^[\p{L}\p{N}]{1,20}$/u.test(bare.slice(word.length + 1))) return true
  }
  return SMS_STOP_PROSE.test(bare)
}
