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

  /**
   * Review round 4. Every SMS reply pauses the person, and Draft SMS — the
   * sender's own dry run — refuses a paused person; it resumes nobody. The
   * hint sent people to Draft SMS alone, which then said "answer the reply
   * from /inbox", which offers no Answer on SMS: a loop whose only way out,
   * Resume on /contacts, was named last. So a paused person's hint names the
   * resume FIRST — and only a reply's own pause is called theirs to lift.
   */
  it('says to resume a person their text paused before Draft SMS, and never to lift somebody else’s pause', () => {
    const replied = answerElsewhere('sms', { paused: true, pausedReason: 'replied 2026-09-15T12:00:00.000Z' })
    expect(replied).toContain('Resume them on /contacts first (their reply paused them), then Draft SMS')
    expect(replied.indexOf('Resume them')).toBeLessThan(replied.indexOf('then Draft SMS'))

    for (const pausedReason of ['legal hold (by sam@agency.test)', 'unsubscribed 2026-09-15T12:00:00.000Z', 'opt-out not recorded: x', null]) {
      const other = answerElsewhere('sms', { paused: true, pausedReason })
      expect(other, String(pausedReason)).toContain('Draft SMS refuses a paused person')
      expect(other, String(pausedReason)).not.toContain('Resume them')
      expect(other, String(pausedReason)).not.toContain('their reply paused them')
    }

    // Not paused (an auto-reply, or resumed since): Draft SMS is the whole answer.
    expect(answerElsewhere('sms', { paused: false, pausedReason: null })).toBe(answerElsewhere('sms'))
    expect(answerElsewhere('sms')).not.toContain('Resume')
    // WhatsApp cannot be sent at all, paused or not.
    expect(answerElsewhere('whatsapp', { paused: true, pausedReason: 'replied 2026-09-15T12:00:00.000Z' })).toBe(
      answerElsewhere('whatsapp'),
    )
  })
})

describe('the inbox queue', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/inbox/queue.tsx', import.meta.url)), 'utf8')

  it('offers the free-text Answer only where an answer is not a template', () => {
    const at = src.indexOf('answersByTemplate(row.channel) ? (')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('onClick={() => setOpen(row.id)}'))
  })

  it('words the SMS hint by the person’s pause, which is what Draft SMS refuses', () => {
    expect(src).toContain('{answerElsewhere(row.channel, row.contact)}')
  })

  it('labels the channel beside the reply’s kind', () => {
    expect(src).toContain('{channelLabel(row.channel) ? <span className="pill">{channelLabel(row.channel)}</span> : null}')
  })
})
