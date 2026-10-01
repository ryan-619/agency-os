/**
 * An SMS campaign on /campaigns (0019).
 *
 * The rules are the schema's and the database's — `campaignInput` refuses
 * auto-send on SMS with a sentence (packages/db/test/campaigns.test.ts), and
 * `campaigns_no_auto_send_on_voice_or_sms` refuses the row — so what is
 * pinned here is that the form says so before either is asked, and that the
 * card never offers enrolment for a campaign enrolment refuses whole.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHANNEL_HINT, SMS_AUTO_SEND_OFF, SMS_NOT_ENROLLED } from '../src/components/campaigns/sms-words'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const FORM = read('../src/components/outreach/campaigns.tsx')
const PAGE = read('../src/app/campaigns/page.tsx')

describe('what the form says about SMS', () => {
  it('says cold is email and LinkedIn, and SMS is for opted-in people, drafted per person and approved', () => {
    expect(CHANNEL_HINT).toContain('Cold outreach is email and LinkedIn only')
    expect(CHANNEL_HINT).toContain('recorded SMS opt-in')
    expect(CHANNEL_HINT).toContain('Draft SMS on /contacts')
    expect(SMS_AUTO_SEND_OFF).toContain('every SMS is approved by a person')
    expect(SMS_AUTO_SEND_OFF).toContain('recorded SMS opt-in')
  })

  it('says enrolment does not fill an SMS campaign, and where an SMS comes from instead', () => {
    expect(SMS_NOT_ENROLLED).toMatch(/^Enrolment does not fill an SMS campaign\./)
    expect(SMS_NOT_ENROLLED).toContain('Draft SMS')
  })
})

describe('the form and the card', () => {
  it('offers SMS as a channel, and nothing else beyond email and LinkedIn', () => {
    expect(FORM).toContain('<option value="sms">')
    expect(FORM).not.toContain('<option value="voice">')
    expect(FORM).not.toContain('<option value="whatsapp">')
  })

  it('cannot tick auto-send on SMS, and never sends it on', () => {
    expect(FORM).toContain("disabled={channel === 'sms' || (!canAutoSend && !autoSend)}")
    expect(FORM).toContain("checked={autoSend && channel !== 'sms'}")
    expect(FORM).toContain("autoSend: channel === 'sms' ? false : autoSend")
  })

  it('offers no enrol button on an SMS campaign, and says why in its place', () => {
    expect(FORM).toContain("c.channel !== 'sms' && enrolling !== c.id")
    expect(FORM).toContain('{SMS_NOT_ENROLLED}')
  })

  it('the page shows an SMS campaign as SMS, not as email', () => {
    expect(PAGE).toContain("c.channel === 'linkedin' || c.channel === 'sms' ? c.channel : 'email'")
  })
})
