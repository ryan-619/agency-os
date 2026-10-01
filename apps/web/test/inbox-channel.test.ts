/**
 * /inbox and the reply's channel (0019).
 *
 * An SMS reply is listed with every other, labelled as one; and because an
 * answer on SMS or WhatsApp must be a registered template, the row offers no
 * free-text Answer — `replyQueueDraft` would refuse it `template_required`
 * (packages/db/test/inbox.test.ts) — and points at Draft SMS instead.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  answerElsewhere, answersByTemplate, channelLabel, contactsLinkFor, matchedByWords,
} from '../src/components/inbox/channel'

describe('a reply’s channel, in words', () => {
  it('labels everything but email', () => {
    expect(channelLabel('email')).toBeNull()
    expect(channelLabel('sms')).toBe('SMS')
    expect(channelLabel('whatsapp')).toBe('WhatsApp')
    expect(channelLabel('linkedin')).toBe('LinkedIn')
  })

  it('answers by template on SMS and WhatsApp only', () => {
    expect(answersByTemplate('sms')).toBe(true)
    expect(answersByTemplate('whatsapp')).toBe(true)
    expect(answersByTemplate('email')).toBe(false)
    expect(answersByTemplate('linkedin')).toBe(false)
  })

  it('says a text was matched by number, and an email by address', () => {
    expect(matchedByWords('sms')).toBe('matched by number — not to a message this system sent')
    expect(matchedByWords('email')).toBe('matched by address — not to a message this system sent')
  })

  it('sends an SMS answer to Draft SMS, and says WhatsApp cannot be sent yet', () => {
    expect(answerElsewhere('sms')).toContain('Draft SMS')
    expect(answerElsewhere('whatsapp')).toContain('sending WhatsApp is not available yet')
    expect(contactsLinkFor('Priya Sharma')).toBe('/contacts?q=Priya%20Sharma')
  })
})

describe('the inbox queue', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/inbox/queue.tsx', import.meta.url)), 'utf8')

  it('offers the free-text Answer only where an answer is not a template', () => {
    const at = src.indexOf('answersByTemplate(row.channel) ? (')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('onClick={() => setOpen(row.id)}'))
  })

  it('labels the channel beside the reply’s kind', () => {
    expect(src).toContain('{channelLabel(row.channel) ? <span className="pill">{channelLabel(row.channel)}</span> : null}')
  })
})
