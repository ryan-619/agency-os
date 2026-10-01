/**
 * What /settings/templates says, and the few rules its form restates.
 *
 * Pure, and importing nothing: the panel is a client component, and the
 * house rule keeps `@agency/core`'s runtime out of the browser bundle — so
 * the categories the form offers are restated here, and
 * `apps/web/test/templates-routes.test.ts` holds them to core's own lists.
 * The server is the authority either way: `templatesCreate` refuses a
 * category the channel does not have, with a sentence.
 */

export type TemplateChannelName = 'sms' | 'whatsapp' | 'voice'

export const TEMPLATE_CHANNEL_LABEL: Readonly<Record<TemplateChannelName, string>> = {
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  voice: 'Voice',
}

/** DLT's categories for SMS and voice, and Meta's for WhatsApp — `templateCategoriesFor` in core. */
export const TEMPLATE_CATEGORY_OPTIONS: Readonly<Record<TemplateChannelName, readonly string[]>> = {
  sms: ['promotional', 'transactional', 'service_implicit', 'service_explicit'],
  whatsapp: ['marketing', 'utility', 'authentication'],
  voice: ['promotional', 'transactional', 'service_implicit', 'service_explicit'],
}

/** A category as a person reads it: `service_explicit` is "service explicit". */
export const categoryWords = (c: string): string => c.replace(/_/g, ' ')

/**
 * What each category means for sending, in one line, where it changes anything.
 *
 * The promotional band is the send path's (`promotionalBand` in core):
 * 10:00–21:00 where the recipient is, for every number, and TRAI's band in
 * India as well for an Indian one. It said "India time" alone until review
 * round 5, which is the rule for neither an American number nor an Indian
 * one read in another zone.
 */
export const CATEGORY_HINT: Readonly<Record<string, string>> = {
  promotional:
    'Held outside 10:00–21:00 where the recipient is — and outside 10:00–21:00 India time as well for an Indian ' +
    '(+91) number — and the operator drops it to a DND number.',
  transactional: 'Reserved by the operators for banks’ OTPs and alerts.',
  service_implicit: 'A message an existing relationship implies.',
  service_explicit: 'Needs the person’s explicit consent — here, their recorded SMS opt-in.',
}

/** The lede: what this page is, and what it is not. */
export const TEMPLATES_LEDE =
  'Every SMS to an Indian number must be a template registered on DLT — the header and the template id as a pair, ' +
  'and the words exactly as registered with each {#var#} filled. The registration itself happens on the operator’s ' +
  'DLT portal (SmartPing); this page only records what is registered there, so a message can be drafted from it and ' +
  'checked against it before it is sent.'

/** Said beside every non-SMS template, because storing one is not sending one. */
export const NOT_SENDABLE_NOTE: Readonly<Record<Exclude<TemplateChannelName, 'sms'>, string>> = {
  whatsapp: 'Stored for when WhatsApp sending is built. Sending WhatsApp is not available yet.',
  voice: 'Stored only. Calls are not placed from this product.',
}

/** The body as literal text and `{#…#}` slots, for display. Not a parser: the server's `parseTemplate` is. */
export function bodySegments(body: string): { readonly slot: boolean; readonly text: string }[] {
  const out: { slot: boolean; text: string }[] = []
  let at = 0
  for (const m of body.matchAll(/\{#[A-Za-z]+#\}/g)) {
    const i = m.index ?? 0
    if (i > at) out.push({ slot: false, text: body.slice(at, i) })
    out.push({ slot: true, text: m[0] })
    at = i + m[0].length
  }
  if (at < body.length) out.push({ slot: false, text: body.slice(at) })
  return out
}

/** One import line's outcome, as a word. */
export const IMPORT_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  imported: 'imported',
  already_present: 'already recorded',
  skipped: 'skipped',
  refused: 'refused',
}
