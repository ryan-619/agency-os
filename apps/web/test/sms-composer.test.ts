/**
 * The SMS composer on /contacts (0019): its live render, its length and
 * segment arithmetic, and `POST /api/contacts/[id]/sms`'s mapping of
 * `smsDraft`'s answers to the wire.
 *
 * The render is a PREVIEW — the server renders with core's `renderTemplate`
 * and the send path matches again — so the one rule it restates (30
 * characters a variable) is held to core's here, and a preview of filled
 * values is checked to be exactly what core renders.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DLT_VAR_MAX_CHARS, parseTemplate, renderTemplate, type SendRefusal } from '@agency/core'
import type { SmsDraftRefusal } from '@agency/db/queries'
import { SMS_VAR_MAX_CHARS, lengthLine, renderPreview, smsLength, type ComposerPart } from '../src/components/contacts/sms-text'
import {
  SMS_DRAFTED_NOTE, SMS_DRAFT_STATUS, smsCheckAnswer, smsDraftAnswer, smsDraftSchema, smsRenderAnswer,
} from '../src/app/api/contacts/[id]/sms/outcome'
import { sendCheckSentence } from '../src/lib/consent-view'
// The provider's own predicate, imported rather than restated: the composer's preview must
// name the encoding DoveSoft will actually put on the wire (`unicode=1` or not).
import { needsUnicode } from '../../agent/src/outreach/dovesoft'

const BODY = 'Hi {#var#}, your posture review for {#var#} is ready. Reply STOP to opt out.'
const parts = (body: string): readonly ComposerPart[] => {
  const p = parseTemplate(body)
  if (!p.ok) throw new Error(p.message)
  return p.template.parts
}

describe('the live render', () => {
  it('restates core’s variable limit, and nothing else', () => {
    expect(SMS_VAR_MAX_CHARS).toBe(DLT_VAR_MAX_CHARS)
  })

  it('shows an empty slot as its {#kind#}, where it is', () => {
    const r = renderPreview(parts(BODY), ['Priya'])
    expect(r.text).toBe('Hi Priya, your posture review for {#var#} is ready. Reply STOP to opt out.')
    expect(r.complete).toBe(false)
    expect(r.problems).toEqual([{ slot: 2, message: 'Variable 2 is empty.' }])
  })

  it('renders filled values exactly as core renders them', () => {
    const values = ['Priya', 'Rentman']
    const r = renderPreview(parts(BODY), values)
    const core = renderTemplate(BODY, values)
    expect(core.ok && core.text).toBe(r.text)
    expect(r.complete).toBe(true)
    expect(r.problems).toEqual([])
  })

  /**
   * A link or a phone number in a plain slot is the server's to refuse — core judges the rendered
   * text, so a value can make one with its neighbour — and the preview shows the words as typed.
   * A company's DOMAIN is a link to an operator's scrub; name the company instead.
   */
  it('leaves a link or a number in a plain slot to the server, which refuses it with a sentence', () => {
    for (const values of [['Priya', 'rentman.io'], ['Priya', 'call 98765 43210']]) {
      expect(renderPreview(parts(BODY), values).problems).toEqual([])
      const core = renderTemplate(BODY, values)
      expect(core).toMatchObject({ ok: false, reason: 'var_wrong_kind', slot: 2 })
      if (!core.ok) expect(core.message).toMatch(/^Variable 2: it puts a (link|phone number) in the message/)
    }
  })

  it('counts a value in code points, as the operator does, and says when one is too long', () => {
    expect(renderPreview(parts('{#var#}'), ['😀'.repeat(30)]).problems).toEqual([])
    expect(renderPreview(parts('{#var#}'), ['x'.repeat(31)]).problems).toEqual([
      { slot: 1, message: 'Variable 1 is 31 characters; a DLT variable holds at most 30.' },
    ])
  })
})

describe('length and segments', () => {
  it('counts plain text as GSM-7: 160 in one segment, then 153 each', () => {
    expect(smsLength('a'.repeat(160))).toEqual({ encoding: 'gsm7', characters: 160, units: 160, segments: 1, perSegment: 160 })
    expect(smsLength('a'.repeat(161))).toMatchObject({ segments: 2, perSegment: 153 })
    expect(smsLength('a'.repeat(306))).toMatchObject({ segments: 2 })
    expect(smsLength('a'.repeat(307))).toMatchObject({ segments: 3 })
  })

  /**
   * The extension table (`€ [ ] { } ~ ^ \\ |`) is GSM-7 on paper, two septets each — and DoveSoft's
   * provider sends any of it as `unicode=1` on purpose (a gateway may not apply the escape, and a
   * mangled character is a DLT text the operator scrubs). The preview names what will be sent and
   * billed, so one of these makes the whole message UCS-2 here too.
   */
  it('counts an extension-table character as the provider sends it: the whole message as UCS-2', () => {
    expect(smsLength('€'.repeat(80))).toMatchObject({ encoding: 'ucs2', characters: 80, units: 80, segments: 2, perSegment: 67 })
    // 149 plain characters and one '[': 150 GSM-7 septets would be one segment; as UCS-2 it is three.
    expect(smsLength(`${'a'.repeat(149)}[`)).toMatchObject({ encoding: 'ucs2', units: 150, segments: 3 })
    expect(smsLength('{}[]~|^\\')).toMatchObject({ encoding: 'ucs2', units: 8, segments: 1 })
  })

  /**
   * One table, run through BOTH the composer and the provider, so the two cannot disagree about a
   * character again. The rows are the provider's own test cases plus every extension-table
   * character on its own.
   */
  it.each([
    ['plain English', 'Your meeting is at 3pm. Reply STOP to opt out.'],
    ['every accented letter the basic set holds', 'èéùìòÇØøÅåÆæßÉÄÖÑÜäöñüà¡¿'],
    ['the Greek capitals it holds', 'ΔΦΓΛΩΠΨΣΘΞ'],
    ['£ $ ¥ ¤ § @ and line breaks', '£5 $5 ¥5 ¤ § @home\r\nok'],
    ['the rupee sign', '₹500'],
    ['Devanagari', 'नमस्ते'],
    ['an emoji', 'see you 👋'],
    ['a curly quote', 'it’s'],
    ['a tab', 'a\tb'],
    ['a lower-case ç', 'ça'],
    ['the escape character itself', 'a\u001bb'],
    ['a form feed, the extension table’s page break', 'a\fb'],
    ...Array.from('€[]{}~^\\|', (c) => [`the extension character ${c}`, `Ref ${c}12`] as [string, string]),
  ])('names the encoding the provider sends: %s', (_why, text) => {
    expect(smsLength(text).encoding).toBe(needsUnicode(text) ? 'ucs2' : 'gsm7')
  })

  it('agrees with the provider on every character from U+0000 to U+03FF, and on € and ₹', () => {
    const chars = [...Array.from({ length: 0x400 }, (_, i) => String.fromCodePoint(i)), '€', '₹']
    const disagree = chars.filter((c) => (smsLength(`a${c}`).encoding === 'ucs2') !== needsUnicode(`a${c}`))
    expect(disagree).toEqual([])
  })

  it('sends the whole message as UCS-2 for one character outside GSM-7: 70, then 67', () => {
    expect(smsLength(`${'a'.repeat(69)}न`)).toMatchObject({ encoding: 'ucs2', units: 70, segments: 1, perSegment: 70 })
    expect(smsLength(`${'a'.repeat(70)}न`)).toMatchObject({ encoding: 'ucs2', units: 71, segments: 2, perSegment: 67 })
  })

  it('counts an emoji as two UCS-2 units and one character, and never splits the pair', () => {
    expect(smsLength('😀')).toMatchObject({ encoding: 'ucs2', characters: 1, units: 2, segments: 1 })
    // 66 units then an emoji: 68 > 67, so the pair moves whole.
    expect(smsLength(`${'a'.repeat(66)}😀${'a'.repeat(10)}`)).toMatchObject({ units: 78, segments: 2 })
  })

  it('reads GSM-7’s own accented letters as GSM-7, and an empty message as no segments', () => {
    expect(smsLength('Café à Zürich — ').encoding).toBe('ucs2') // the em dash is not in GSM-7
    expect(smsLength('Café à Zürich').encoding).toBe('gsm7')
    expect(smsLength('')).toMatchObject({ characters: 0, segments: 0 })
  })

  it('says it in one line', () => {
    expect(lengthLine(smsLength('Hi there'))).toBe('8 characters · GSM-7 · 1 segment')
    expect(lengthLine(smsLength('😀'.repeat(40)))).toBe('40 characters · Unicode (UCS-2) · 2 segments')
  })
})

describe('POST /api/contacts/[id]/sms', () => {
  const ID = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'

  it('reads two ids and the values, and bounds them', () => {
    expect(smsDraftSchema.safeParse({ campaignId: ID, templateId: ID, vars: ['Priya'] }).success).toBe(true)
    expect(smsDraftSchema.safeParse({ campaignId: ID, templateId: ID, vars: [], dryRun: true }).success).toBe(true)
    expect(smsDraftSchema.safeParse({ campaignId: 'nope', templateId: ID, vars: [] }).success).toBe(false)
    expect(smsDraftSchema.safeParse({ campaignId: ID, templateId: ID, vars: ['x'.repeat(501)] }).success).toBe(false)
    expect(smsDraftSchema.safeParse({ campaignId: ID, templateId: ID, vars: Array(51).fill('x') }).success).toBe(false)
  })

  it('gives every refusal a status: 404 for another org’s, 422 for values that do not render, 409 for the rest of the world', () => {
    const expected: Record<SmsDraftRefusal, number> = {
      no_such_contact: 404, no_phone: 409, no_such_campaign: 404, not_an_sms_campaign: 400, campaign_not_active: 409,
      no_such_template: 404, not_an_sms_template: 400, template_inactive: 409, render_failed: 422, already_queued: 409,
      refused: 409,
    }
    expect(SMS_DRAFT_STATUS).toEqual(expected)
  })

  it('answers a refusal with the query’s own sentence, the send path’s code and the slot', () => {
    expect(
      smsDraftAnswer(
        { ok: false, reason: 'refused', code: 'cold_channel_forbidden', message: 'No SMS opt-in is recorded. Nothing was drafted.' },
        null,
      ),
    ).toEqual({
      status: 409,
      body: { error: 'No SMS opt-in is recorded. Nothing was drafted.', reason: 'refused', code: 'cold_channel_forbidden' },
    })
    expect(smsDraftAnswer({ ok: false, reason: 'render_failed', slot: 2, message: 'Variable 2: it is blank.' }, null)).toMatchObject({
      status: 422,
      body: { slot: 2 },
    })
  })

  it('answers a draft 201, says nothing was sent, and says when no worker will send it', () => {
    const r = smsDraftAnswer(
      { ok: true, touchId: ID, body: 'Hi Priya', wouldHold: { code: 'quiet_hours', reason: 'It is 23:00 where they are.' } },
      'No agent worker is connected to this deployment, so nothing queued here will be sent.',
    )
    expect(r.status).toBe(201)
    expect(r.body).toEqual({
      touchId: ID,
      body: 'Hi Priya',
      wouldHold: { code: 'quiet_hours', reason: 'It is 23:00 where they are.' },
      note: SMS_DRAFTED_NOTE,
      deployment: 'No agent worker is connected to this deployment, so nothing queued here will be sent.',
    })
    expect(SMS_DRAFTED_NOTE).toMatch(/^Drafted, and nothing was sent\./)
  })

  /** The dry run: a refusal nobody may approve past blocks the draft; one a person can resolve does not. */
  it('blocks the draft on a refusal nobody may approve past, and not on one a person can resolve', () => {
    const refusal = (code: SendRefusal['code'], humanCanResolve: boolean): SendRefusal => ({
      allowed: false, code, reason: 'The rule says so.', humanCanResolve,
    })
    const blocked = smsCheckAnswer({ decision: refusal('suppressed', false), wouldNeedApproval: true, body: 'Hi' })
    expect(blocked).toEqual({
      status: 200,
      body: {
        rendered: true,
        body: 'Hi',
        decision: { allowed: false, code: 'suppressed', reason: 'The rule says so.', humanCanResolve: false },
        wouldNeedApproval: true,
        blocked: true,
      },
    })
    expect(sendCheckSentence(blocked.body as never)).toContain('Nobody may approve past this.')
    expect(smsCheckAnswer({ decision: refusal('quiet_hours', true), wouldNeedApproval: true, body: 'Hi' }).body.blocked).toBe(false)
    expect(smsCheckAnswer({ decision: { allowed: true, code: 'send_now' }, wouldNeedApproval: true, body: 'Hi' }).body).toMatchObject({
      blocked: false,
      decision: { allowed: true, code: 'send_now' },
    })
  })

  it('answers values that do not render as the answer to the question, not as an error', () => {
    expect(smsRenderAnswer({ message: 'Variable 1: it is blank, so the message would read as a gap.', slot: 1 })).toEqual({
      status: 200,
      body: { rendered: false, error: 'Variable 1: it is blank, so the message would read as a gap. Nothing was drafted.', slot: 1 },
    })
  })

  /**
   * The dry run is `smsDraft` itself with `dryRun: true`, which writes
   * nothing (packages/db/test/sms.test.ts); sms-route.test.ts drives it, the
   * no-number sentence included, against a real database.
   */
  it('asks campaigns:write before it reads anything, and has no copy of smsDraft’s checks', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/app/api/contacts/[id]/sms/route.ts', import.meta.url)), 'utf8')
    expect(src.indexOf("'campaigns:write'")).toBeLessThan(src.indexOf('request.text()'))
    expect(src).toContain('smsComposerAnswer(')
    expect(src).not.toMatch(/previewSend\(|insert\(|appendAudit\(/)
  })
})
