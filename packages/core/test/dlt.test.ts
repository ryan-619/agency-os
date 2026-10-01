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
  DLT_VAR_MAX_CHARS, PROMOTIONAL_WINDOW, matchesTemplate, normaliseDltHeader, parseTemplate,
  parseTemplateCategory, promotionalWindowOpen, renderTemplate, smsOptOut, templateCategoriesFor,
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
  it('is 10:00 to 21:00 in India', () => {
    expect(PROMOTIONAL_WINDOW).toMatchObject({ start: 600, end: 1260, zone: 'Asia/Kolkata' })
  })

  it.each([
    ['2026-09-15T04:29:59.000Z', false], // 09:59 IST
    ['2026-09-15T04:30:00.000Z', true], //  10:00 IST
    ['2026-09-15T15:29:00.000Z', true], //  20:59 IST
    ['2026-09-15T15:30:00.000Z', false], // 21:00 IST — the end is exclusive
  ])('at %s is open: %s', (at, open) => {
    expect(promotionalWindowOpen(new Date(at), 'Asia/Kolkata')).toBe(open)
  })

  it('is closed when it is open in India but not where the recipient is', () => {
    // 11:00 IST is 06:30 in London in September.
    expect(promotionalWindowOpen(new Date('2026-09-15T05:30:00.000Z'), 'Europe/London')).toBe(false)
  })

  it('answers null for a zone the runtime does not know', () => {
    expect(promotionalWindowOpen(new Date(), 'Not/AZone')).toBeNull()
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

  it.each([
    'Cancel tomorrow’s call please',
    'end of day works',
    'Can we stop by your office on Friday?',
    'I will stop at 5',
    'Do not stop, this is great',
    'quit my job last week, call my colleague',
    'stoppage',
    '',
  ])('does not read %j as an opt-out — the words around it say otherwise', (text) => {
    expect(smsOptOut(text)).toBe(false)
  })

  it('does not read null or undefined as anything', () => {
    expect(smsOptOut(null)).toBe(false)
    expect(smsOptOut(undefined)).toBe(false)
  })
})
