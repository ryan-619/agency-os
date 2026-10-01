/**
 * DLT's rules, one edge at a time (0019).
 *
 * The operator scrubs an Indian commercial SMS against its registered
 * template: the text must be the registered body with each `{#var#}` filled.
 * A wrong answer here in one direction is a message somebody approved that
 * never arrives; in the other it is words the regulator never saw. So the
 * matcher is tested where matchers break — slots at the edges, slots side
 * by side, literal text that looks like a pattern, and characters JavaScript
 * counts differently from the operator.
 */
import { describe, expect, it } from 'vitest'
import {
  DLT_VAR_MAX_CHARS, PROMOTIONAL_WINDOW, isIndianNumber, matchesTemplate, normaliseDltHeader, parseTemplate,
  parseTemplateCategory, promotionalBand, renderTemplate, smsOptOut, templateCategoriesFor,
} from '../src/index.js'

describe('parsing a registered body', () => {
  it('reads literal text and slots in order', () => {
    const p = parseTemplate('Hi {#var#}, your call is at {#var#}.')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.template.slots).toBe(2)
    expect(p.template.parts).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'slot', variable: 'var' },
      { kind: 'text', text: ', your call is at ' },
      { kind: 'slot', variable: 'var' },
      { kind: 'text', text: '.' },
    ])
  })

  it('reads slots at the very start and the very end, with no empty text around them', () => {
    const p = parseTemplate('{#var#} confirmed {#var#}')
    expect(p.ok && p.template.parts.map((x) => x.kind)).toEqual(['slot', 'text', 'slot'])
  })

  it('reads adjacent slots — DLT’s way of carrying more than 30 characters — as two', () => {
    const p = parseTemplate('Ref {#var#}{#var#}')
    expect(p.ok && p.template.parts).toEqual([
      { kind: 'text', text: 'Ref ' },
      { kind: 'slot', variable: 'var' },
      { kind: 'slot', variable: 'var' },
    ])
  })

  it('reads the kind case-insensitively, and the pre-tagged kinds', () => {
    const p = parseTemplate('{#VAR#} {#numeric#} {#url#}')
    expect(p.ok && p.template.parts.filter((x) => x.kind === 'slot')).toEqual([
      { kind: 'slot', variable: 'var' },
      { kind: 'slot', variable: 'numeric' },
      { kind: 'slot', variable: 'url' },
    ])
  })

  it('refuses a kind it does not know, rather than guessing it is text or a var', () => {
    const p = parseTemplate('Hi {#name#}')
    expect(p.ok).toBe(false)
    if (!p.ok) {
      expect(p.reason).toBe('unknown_variable')
      expect(p.message).toContain('{#name#}')
    }
  })

  it('treats what only looks like a placeholder as literal text', () => {
    const p = parseTemplate('Use {# var #} or {#} or {#var')
    expect(p.ok && p.template.slots).toBe(0)
  })

  it('refuses an empty body', () => {
    expect(parseTemplate('   ').ok).toBe(false)
  })
})

describe('rendering', () => {
  it('fills slots in order', () => {
    expect(renderTemplate('Hi {#var#}, at {#var#}.', ['Priya', '3pm'])).toEqual({ ok: true, text: 'Hi Priya, at 3pm.' })
  })

  it('refuses a missing value, naming the slot', () => {
    const r = renderTemplate('Hi {#var#}, at {#var#}.', ['Priya'])
    expect(r).toMatchObject({ ok: false, reason: 'missing_var', slot: 2 })
  })

  it('refuses an extra value', () => {
    expect(renderTemplate('Hi {#var#}.', ['Priya', 'extra'])).toMatchObject({ ok: false, reason: 'extra_var' })
  })

  it('refuses a blank value', () => {
    expect(renderTemplate('Hi {#var#}.', ['   '])).toMatchObject({ ok: false, reason: 'blank_var', slot: 1 })
  })

  it(`allows exactly ${DLT_VAR_MAX_CHARS} characters and refuses one more`, () => {
    expect(renderTemplate('{#var#}', ['a'.repeat(DLT_VAR_MAX_CHARS)]).ok).toBe(true)
    expect(renderTemplate('{#var#}', ['a'.repeat(DLT_VAR_MAX_CHARS + 1)])).toMatchObject({ ok: false, reason: 'var_too_long' })
  })

  it('counts code points, so thirty emoji or Devanagari letters fit as the operator counts them', () => {
    const emoji = '🙂'.repeat(DLT_VAR_MAX_CHARS) // 60 UTF-16 units
    expect(emoji.length).toBe(DLT_VAR_MAX_CHARS * 2)
    expect(renderTemplate('{#var#}', [emoji]).ok).toBe(true)
    expect(renderTemplate('नमस्ते {#var#}', ['प्रिया']).ok).toBe(true)
  })

  it('refuses a link in a plain {#var#}: TRAI requires links whitelisted and in a slot tagged for them', () => {
    expect(renderTemplate('See {#var#}', ['https://x.co/a'])).toMatchObject({ ok: false, reason: 'var_wrong_kind' })
    expect(renderTemplate('See {#var#}', ['www.acme.com'])).toMatchObject({ ok: false, reason: 'var_wrong_kind' })
    expect(renderTemplate('See {#url#}', ['https://x.co/a']).ok).toBe(true)
  })

  /**
   * Review round 4: a bare domain, a shortener, a call-back number, or a link split across two
   * adjacent slots all rendered. DLT needs links and call-back numbers to be part of the registered
   * template, so the RENDERED text is judged: a link or a phone-number-shaped run that a plain
   * slot contributes to — alone or joined to the text beside it — is refused.
   */
  it.each([
    ['a shortener', 'Your report: {#var#}', ['tinyurl.com/abc'], 'link'],
    ['another shortener', 'Your report: {#var#}', ['bit.ly/x'], 'link'],
    ['a bare domain', 'Your report: {#var#}', ['acme.in'], 'link'],
    ['a bare domain under a second-level suffix', 'Your report: {#var#}', ['ACME.co.in'], 'link'],
    ['a WhatsApp click-to-chat link', 'Your report: {#var#}', ['wa.me/919876543210'], 'link'],
    ['a link split across adjacent slots', 'Hi {#var#}{#var#}, thanks.', ['https:/', '/evil.example/x'], 'link'],
    ['a domain split across adjacent slots', 'Hi {#var#}{#var#}, thanks.', ['tinyurl', '.com/abc'], 'link'],
    ['a domain finished by the literal text', 'Visit {#var#}.com/offer today', ['tinyurl'], 'link'],
    ['a scheme the template does not name', 'See {#var#}', ['ftp://acme/x'], 'link'],
    ['a call-back number', 'Your report: {#var#}', ['call +91 98765 43210'], 'number'],
    ['ten bare digits', 'Your report: {#var#}', ['9876543210'], 'number'],
    ['a landline with its code in brackets', 'Your report: {#var#}', ['(022) 2345 6789'], 'number'],
    ['a toll-free number with dashes', 'Your report: {#var#}', ['1800-123-4567'], 'number'],
    ['a number split across adjacent slots', 'Call {#var#} {#var#}', ['98765', '43210'], 'number'],
    ['a number finished by the literal text', 'Call 98765 {#var#}', ['43210'], 'number'],
    ['a number in an {#alphanumeric#} slot', 'Ref {#alphanumeric#}', ['9876543210'], 'number'],
  ])('refuses %s', (_why, body, vars, what) => {
    const r = renderTemplate(body, vars)
    expect(r).toMatchObject({ ok: false, reason: 'var_wrong_kind', slot: 1 })
    if (r.ok) return
    expect(r.message).toMatch(what === 'link' ? /a link/ : /a phone number/)
    for (const v of vars) expect(r.message).not.toContain(v)
    // And the scrub refuses the same text, whatever renders it.
    const queue = [...vars]
    const text = body.replace(/\{#[a-z]+#\}/gi, () => queue.shift() ?? '')
    expect(matchesTemplate(text, body)).toBe(false)
  })

  it.each([
    ['an amount', 'Paid Rs. {#var#} today', ['1,200']],
    ['an amount in lakhs', 'Paid {#var#} today', ['₹1,20,000']],
    ['an amount with paise', 'Paid Rs {#var#} today', ['123456.78']],
    ['an amount after the currency', 'Paid {#var#} today', ['Rs 1500000']],
    ['a date with dashes', 'Your call on {#var#}', ['15-09-2026']],
    ['a date with dots', 'Your call on {#var#}', ['15.09.2026']],
    ['an ISO date', 'Your call on {#var#}', ['2026-09-15']],
    ['a date with slashes', 'Your call on {#var#}', ['15/09/2026']],
    ['a date and a time', 'Your call on {#var#}', ['15-09-2026 10:30 IST']],
    ['a time range', 'Your slot is {#var#}', ['10.30-11.30']],
    ['a short reference', 'Ref {#var#}', ['123456']],
    ['a reference glued to its prefix', 'Ref {#var#}', ['INV1234567']],
    ['an honorific with no space', 'Hi {#var#}', ['Dr.Rao']],
    ['initials', 'Hi {#var#}', ['A.K. Sharma']],
    ['a version', 'Update {#var#}', ['v2.0.1']],
    ['a file name', 'See {#var#}', ['report.pdf']],
    ['an email address', 'Mail {#var#}', ['priya.in@acme.com']],
    ['a name beside the literal full stop', 'Hi {#var#}.Your call is confirmed.', ['Priya']],
  ])('does not refuse %s', (_why, body, vars) => {
    const r = renderTemplate(body, vars)
    expect(r.ok).toBe(true)
    expect(r.ok && matchesTemplate(r.text, body)).toBe(true)
  })

  it('leaves a link or a number that is the template’s own fixed text alone', () => {
    const body = 'Call 1800 123 4567 or visit https://acme.in/offers, {#var#}.'
    const r = renderTemplate(body, ['Priya'])
    expect(r).toEqual({ ok: true, text: 'Call 1800 123 4567 or visit https://acme.in/offers, Priya.' })
    expect(r.ok && matchesTemplate(r.text, body)).toBe(true)
  })

  it('lets a slot registered for a link or a number carry one', () => {
    expect(renderTemplate('See {#url#}', ['https://acme.in/r/123456789']).ok).toBe(true)
    expect(renderTemplate('Call {#cbn#}', ['+919876543210']).ok).toBe(true)
    expect(renderTemplate('Order {#numeric#}', ['4058123987']).ok).toBe(true)
    expect(matchesTemplate('See https://acme.in/r/123456789', 'See {#url#}')).toBe(true)
    expect(matchesTemplate('Call +919876543210', 'Call {#cbn#}')).toBe(true)
  })

  it('names the first slot that makes the link, and never the value', () => {
    const r = renderTemplate('Hi {#var#}, {#var#}{#var#}', ['Priya', 'bit', '.ly/x'])
    expect(r).toMatchObject({ ok: false, reason: 'var_wrong_kind', slot: 2 })
  })

  it('holds a pre-tagged slot to its kind', () => {
    expect(renderTemplate('OTP {#numeric#}', ['12a4'])).toMatchObject({ ok: false, reason: 'var_wrong_kind' })
    expect(renderTemplate('OTP {#numeric#}', ['1234']).ok).toBe(true)
    expect(renderTemplate('Call {#cbn#}', ['+919876543210']).ok).toBe(true)
  })

  it('never puts the value in its message: it may be a person’s name', () => {
    const r = renderTemplate('{#var#}', ['Priya Raman, who is far too long a name to fit'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain('Priya')
  })

  it('refuses a template that does not parse', () => {
    expect(renderTemplate('Hi {#name#}', ['x'])).toMatchObject({ ok: false, reason: 'bad_template' })
  })
})

describe('matching a message against its template', () => {
  it('matches the rendered text', () => {
    const body = 'Hi {#var#}, your call is at {#var#}.'
    const r = renderTemplate(body, ['Priya', '3pm IST'])
    expect(r.ok && matchesTemplate(r.text, body)).toBe(true)
  })

  it('matches with slots at the start and the end', () => {
    expect(matchesTemplate('Priya, confirmed for 3pm', '{#var#}, confirmed for {#var#}')).toBe(true)
  })

  it('matches adjacent slots carrying more than 30 characters between them', () => {
    const long = 'x'.repeat(45)
    expect(matchesTemplate(`Ref ${long}`, 'Ref {#var#}{#var#}')).toBe(true)
    expect(matchesTemplate(`Ref ${'x'.repeat(61)}`, 'Ref {#var#}{#var#}')).toBe(false)
  })

  it('refuses a filled slot over the limit', () => {
    expect(matchesTemplate(`Hi ${'a'.repeat(31)}.`, 'Hi {#var#}.')).toBe(false)
  })

  it('refuses an empty slot, as the renderer does', () => {
    expect(matchesTemplate('Hi .', 'Hi {#var#}.')).toBe(false)
  })

  it('treats regular-expression metacharacters in the literal text as themselves', () => {
    const body = 'Pay $5.00 (incl. tax) [ref*] ^now? {#var#} | a+b \\ end'
    expect(matchesTemplate('Pay $5.00 (incl. tax) [ref*] ^now? Priya | a+b \\ end', body)).toBe(true)
    // `.` is a dot, not "any character".
    expect(matchesTemplate('Pay $5X00 (incl. tax) [ref*] ^now? Priya | a+b \\ end', body)).toBe(false)
  })

  it('is exact: no folding of case or whitespace, because the operator folds neither', () => {
    expect(matchesTemplate('hi Priya.', 'Hi {#var#}.')).toBe(false)
    expect(matchesTemplate('Hi  Priya.', 'Hi {#var#}.')).toBe(true) // the extra space is inside the slot
    expect(matchesTemplate('Hi Priya. ', 'Hi {#var#}.')).toBe(false)
  })

  it('refuses edited literal text', () => {
    expect(matchesTemplate('Hello Priya, your call is at 3pm.', 'Hi {#var#}, your call is at {#var#}.')).toBe(false)
  })

  it('compares in code points, so a surrogate pair is never split between text and a slot', () => {
    expect(matchesTemplate('🙂 Priya', '🙂 {#var#}')).toBe(true)
    expect(matchesTemplate('🙃 Priya', '🙂 {#var#}')).toBe(false)
    expect(matchesTemplate(`${'🙂'.repeat(30)}!`, '{#var#}!')).toBe(true)
  })

  it('matches a template with no slots only by its exact text', () => {
    expect(matchesTemplate('Your meeting is confirmed.', 'Your meeting is confirmed.')).toBe(true)
    expect(matchesTemplate('Your meeting is confirmed', 'Your meeting is confirmed.')).toBe(false)
  })

  it('refuses a link smuggled into a plain slot, as the renderer does', () => {
    expect(matchesTemplate('See https://x.co/a now', 'See {#var#} now')).toBe(false)
  })

  it('stays fast on a pathological template', () => {
    const body = Array.from({ length: 12 }, () => '{#var#}').join(' ')
    const text = Array.from({ length: 12 }, () => 'a a').join(' ') + ' b'
    const started = Date.now()
    matchesTemplate(text, body)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('matches nothing against a template that does not parse', () => {
    expect(matchesTemplate('Hi x', 'Hi {#name#}')).toBe(false)
  })
})

describe('categories and headers', () => {
  it('folds the spellings an export uses', () => {
    expect(parseTemplateCategory('Service Implicit', 'sms')).toBe('service_implicit')
    expect(parseTemplateCategory('service-explicit', 'sms')).toBe('service_explicit')
    expect(parseTemplateCategory('PROMOTIONAL', 'sms')).toBe('promotional')
    expect(parseTemplateCategory('Service Explicit (SE)', 'sms')).toBe('service_explicit')
    expect(parseTemplateCategory('Marketing', 'whatsapp')).toBe('marketing')
  })

  it('refuses a category from the wrong channel, or none at all — never the nearest guess', () => {
    expect(parseTemplateCategory('marketing', 'sms')).toBeNull()
    expect(parseTemplateCategory('promotional', 'whatsapp')).toBeNull()
    expect(parseTemplateCategory('service', 'sms')).toBeNull()
    expect(parseTemplateCategory('', 'sms')).toBeNull()
  })

  it('lists the categories each channel allows, as 0019’s CHECK does', () => {
    expect(templateCategoriesFor('sms')).toEqual(['promotional', 'transactional', 'service_implicit', 'service_explicit'])
    expect(templateCategoriesFor('voice')).toEqual(templateCategoriesFor('sms'))
    expect(templateCategoriesFor('whatsapp')).toEqual(['marketing', 'utility', 'authentication'])
  })

  it('reads a DLT header as six characters, upper-cased', () => {
    expect(normaliseDltHeader(' acmein ')).toBe('ACMEIN')
    expect(normaliseDltHeader('123456')).toBe('123456')
    expect(normaliseDltHeader('ACME')).toBeNull()
    expect(normaliseDltHeader('ACMEINX')).toBeNull()
    expect(normaliseDltHeader('ACM-IN')).toBeNull()
  })
})

describe('TRAI’s promotional band', () => {
  const INDIAN = '+919876543210'
  const AMERICAN = '+14155550100'

  it('is 10:00 to 21:00 in India', () => {
    expect(PROMOTIONAL_WINDOW).toMatchObject({ start: 600, end: 1260, zone: 'Asia/Kolkata', hours: '10:00–21:00' })
  })

  it.each([
    ['2026-09-15T04:29:59.000Z', false], // 09:59 IST
    ['2026-09-15T04:30:00.000Z', true], //  10:00 IST
    ['2026-09-15T15:29:00.000Z', true], //  20:59 IST
    ['2026-09-15T15:30:00.000Z', false], // 21:00 IST — the end is exclusive
  ])('at %s is open for an Indian number in India: %s', (at, open) => {
    expect(promotionalBand(new Date(at), 'Asia/Kolkata', INDIAN)).toEqual({ open, india: true, opensToday: true })
  })

  it('is closed for an Indian number when it is open in India but not where the recipient is', () => {
    // 11:00 IST is 06:30 in London in September.
    expect(promotionalBand(new Date('2026-09-15T05:30:00.000Z'), 'Europe/London', INDIAN)).toMatchObject({ open: false, india: true })
  })

  it('reads TRAI’s band as governing Indian numbers only, however the number is written', () => {
    expect(isIndianNumber('+919876543210')).toBe(true)
    expect(isIndianNumber('+91 98765 43210')).toBe(true)
    expect(isIndianNumber('0091-98765-43210')).toBe(true)
    expect(isIndianNumber('+14155550100')).toBe(false)
    expect(isIndianNumber('+9198')).toBe(false) // not a number at all
    expect(isIndianNumber('9876543210')).toBe(false) // no country code: unknown, not Indian
  })

  /**
   * Review round 4: the IST band and 10:00–21:00 in Los Angeles never overlap in September, so a
   * promotional SMS to an American number could never go — and was deferred as quiet hours for ever.
   * TRAI's band is the Indian operators'; an American number keeps only its own hours.
   */
  it('opens for an American number inside its own 10:00–21:00, whatever the time in India', () => {
    // 11:00 in Los Angeles is 23:30 in India.
    expect(promotionalBand(new Date('2026-09-15T18:00:00.000Z'), 'America/Los_Angeles', AMERICAN)).toEqual({
      open: true, india: false, opensToday: true,
    })
    // 09:59 and 21:00 there are outside it.
    expect(promotionalBand(new Date('2026-09-15T16:59:00.000Z'), 'America/Los_Angeles', AMERICAN)?.open).toBe(false)
    expect(promotionalBand(new Date('2026-09-16T04:00:00.000Z'), 'America/Los_Angeles', AMERICAN)?.open).toBe(false)
  })

  it('counts every quarter-hour of a day in Los Angeles: 44 open for an American number, 0 for an Indian one', () => {
    const count = (recipient: string): number => {
      let open = 0
      for (let q = 0; q < 96; q += 1) {
        if (promotionalBand(new Date(Date.UTC(2026, 8, 15, 0, q * 15)), 'America/Los_Angeles', recipient)?.open) open += 1
      }
      return open
    }
    expect(count(AMERICAN)).toBe(44)
    expect(count(INDIAN)).toBe(0)
  })

  it('says when the two bands never meet at today’s clocks, and when they do', () => {
    // Los Angeles on Pacific Daylight Time, and Denver all year: 10:00–21:00 there misses IST’s band.
    expect(promotionalBand(new Date('2026-09-15T18:00:00.000Z'), 'America/Los_Angeles', INDIAN)).toEqual({
      open: false, india: true, opensToday: false,
    })
    expect(promotionalBand(new Date('2026-01-15T18:00:00.000Z'), 'America/Denver', INDIAN)?.opensToday).toBe(false)
    // On Pacific Standard Time there is half an hour: 20:30–21:00 in Los Angeles is 10:00–10:30 in India.
    expect(promotionalBand(new Date('2026-01-15T18:00:00.000Z'), 'America/Los_Angeles', INDIAN)?.opensToday).toBe(true)
    expect(promotionalBand(new Date('2026-01-16T04:45:00.000Z'), 'America/Los_Angeles', INDIAN)).toEqual({
      open: true, india: true, opensToday: true,
    })
    // New York overlaps, and an American number in Denver always has its own hours.
    expect(promotionalBand(new Date('2026-09-15T18:00:00.000Z'), 'America/New_York', INDIAN)?.opensToday).toBe(true)
    expect(promotionalBand(new Date('2026-09-15T18:00:00.000Z'), 'America/Denver', AMERICAN)?.opensToday).toBe(true)
  })

  it('answers null for a zone the runtime does not know', () => {
    expect(promotionalBand(new Date(), 'Not/AZone', INDIAN)).toBeNull()
    expect(promotionalBand(new Date(), 'Not/AZone', AMERICAN)).toBeNull()
  })
})

describe('the SMS opt-out reader', () => {
  it.each(['STOP', 'stop', 'Stop.', ' STOP! ', 'STOPALL', 'stop all', 'UNSUBSCRIBE', 'Cancel', 'END', 'quit', 'OPT OUT', 'opt-out', 'optout'])(
    'reads %j as an opt-out',
    (text) => {
      expect(smsOptOut(text)).toBe(true)
    },
  )

  it.each(['STOP 56161', 'stop ACMEIN', 'UNSUBSCRIBE ALL', 'Reply STOP', 'sms stop', 'text STOP 56161'])(
    'reads the reply-with-keyword form %j as an opt-out',
    (text) => {
      expect(smsOptOut(text)).toBe(true)
    },
  )

  it.each(['Stop texting me', 'please stop messaging me', "don't text me again", 'Do not SMS me', 'no more texts'])(
    'reads the SMS-shaped sentence %j as an opt-out',
    (text) => {
      expect(smsOptOut(text)).toBe(true)
    },
  )

  it('reads full-width letters as letters', () => {
    expect(smsOptOut('ＳＴＯＰ')).toBe(true)
  })

  /**
   * Review round 4: each of these was stored as an ordinary reply — paused, never suppressed, and
   * resumable by answering it. A missed STOP is the worst error this reader can make.
   */
  it.each([
    'STOP ALL 56161',
    'stop all ACMEIN',
    'UNSUBSCRIBE ALL ACMEIN',
    'unsubscribe all 56161',
    'STOPALL 56161',
    'Reply STOP ALL 56161',
    'STOP 👍',
    'STOP🙏',
    'stop 🙅‍♀️',
    'STOP 👍🏽',
    'STOP)',
    'STOP :)',
    '(STOP)',
    '"STOP"',
    '¡STOP!',
    '¿Stop?',
    '*STOP*',
    '👎 STOP',
    'STOP 56161 🙏',
    'STOP-56161',
    'STOP: ACMEIN',
    'Unsubscribe, ACMEIN',
    'Opt out!!! 😡😡',
    'CANCEL 👋',
  ])('reads %j as an opt-out — punctuation, an emoji or "all" around the keyword', (text) => {
    expect(smsOptOut(text)).toBe(true)
  })

  /**
   * The email reader's whole-message forms, which the SMS recorder ORs with this one — restated so
   * a decoration it does not strip does not lose them — and the curly apostrophe a phone types.
   */
  it.each(['Please stop 🙏', 'Kindly unsubscribe.', 'Remove me :)', 'Opt me out!', 'Don’t text me again 🙏', 'don’t message me', 'Leave me alone 😡'])(
    'reads %j as an opt-out',
    (text) => {
      expect(smsOptOut(text)).toBe(true)
    },
  )

  it.each([
    'Cancel tomorrow’s call please',
    'end of day works',
    'Can we stop by your office on Friday?',
    'I will stop at 5',
    'Do not stop, this is great',
    'quit my job last week, call my colleague',
    'stoppage',
    '',
    // Punctuation and emoji are stripped only from the ENDS: prose is still prose.
    "Don't stop! 👍",
    'don’t stop 🙂',
    'stop by tomorrow 🙂',
    'Stop by tomorrow?',
    '(stop by on Friday)',
    'Please do not stop :)',
    'All good, stop worrying 😄',
    'stop all the calls until Monday please',
    'end of day? 👍',
    'cancel the 3pm, move it to 4 🙏',
    '👍',
    '!!!',
    'please stop by 🙂',
    'Please cancel 🙏',
  ])('does not read %j as an opt-out — the words around it say otherwise', (text) => {
    expect(smsOptOut(text)).toBe(false)
  })

  it('does not read null or undefined as anything', () => {
    expect(smsOptOut(null)).toBe(false)
    expect(smsOptOut(undefined)).toBe(false)
  })
})
