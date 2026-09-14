/**
 * Parsing an inbound email (PROMPT.md §8.4).
 *
 * The IMAP session itself cannot be tested without a mailbox, so the session
 * is thin and the parsing is where the tests are. An email is a hostile
 * input: the interesting cases are a From with a display name, a References
 * header folded across lines, a reply that is only HTML, and a client that
 * sets In-Reply-To but not References — each of which decides whether a reply
 * is matched to the message it answers or dropped.
 */
import { describe, it, expect } from 'vitest'
import { parseInbound } from '../src/outreach/inbox.js'

const raw = (headers: string, body: string): string =>
  `${headers.trim()}\r\n\r\n${body}`

describe('parseInbound', () => {
  it('reads the address out of a From with a display name', async () => {
    const mail = await parseInbound(
      raw(
        `From: "Priya Sharma" <Priya@Rentman.IO>
To: outreach@agency.test
Subject: Re: your note
Message-ID: <reply-1@rentman.io>`,
        'Interested — Thursday?',
      ),
    )
    expect(mail).not.toBeNull()
    expect(mail!.from).toBe('Priya@Rentman.IO')
    expect(mail!.subject).toBe('Re: your note')
    expect(mail!.text?.trim()).toBe('Interested — Thursday?')
    expect(mail!.messageId).toBe('<reply-1@rentman.io>')
  })

  /**
   * The match that makes a reply unambiguous: In-Reply-To names the exact
   * message this system sent, by the Message-ID the provider assigned. It
   * goes FIRST in the list, because it is the direct parent.
   */
  it('collects In-Reply-To first, then References, without duplicates', async () => {
    const mail = await parseInbound(
      raw(
        `From: priya@rentman.io
Subject: Re: your note
In-Reply-To: <sent-2@agency.test>
References: <sent-1@agency.test>
 <sent-2@agency.test>`,
        'yes',
      ),
    )
    expect(mail!.references).toEqual(['<sent-2@agency.test>', '<sent-1@agency.test>'])
  })

  it('copes with a client that sets only In-Reply-To', async () => {
    const mail = await parseInbound(
      raw(`From: priya@rentman.io\nSubject: Re\nIn-Reply-To: <sent-9@agency.test>`, 'ok'),
    )
    expect(mail!.references).toEqual(['<sent-9@agency.test>'])
  })

  it('has no references for a message that is not a reply', async () => {
    const mail = await parseInbound(raw(`From: priya@rentman.io\nSubject: Hello`, 'cold inbound'))
    expect(mail!.references).toEqual([])
  })

  /**
   * A reply that is only HTML must still be readable — the opt-out check
   * reads the text, and "please <b>unsubscribe</b> me" is an opt-out.
   */
  it('falls back to stripped HTML when there is no text part', async () => {
    const mail = await parseInbound(
      raw(
        `From: priya@rentman.io
Subject: Re
Content-Type: text/html; charset=utf-8`,
        '<html><body><p>Please <b>unsubscribe</b> me.</p></body></html>',
      ),
    )
    expect(mail!.text).toBe('Please unsubscribe me.')
  })

  it('returns null rather than throwing for a message with no sender', async () => {
    const mail = await parseInbound(raw(`Subject: no from`, 'body'))
    expect(mail).toBeNull()
  })

  it('reads a multipart message’s text part', async () => {
    const mail = await parseInbound(
      raw(
        `From: priya@rentman.io
Subject: Re
Content-Type: multipart/alternative; boundary="b1"`,
        [
          '--b1',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'plain answer',
          '--b1',
          'Content-Type: text/html; charset=utf-8',
          '',
          '<p>html answer</p>',
          '--b1--',
          '',
        ].join('\r\n'),
      ),
    )
    expect(mail!.text?.trim()).toBe('plain answer')
  })
})
