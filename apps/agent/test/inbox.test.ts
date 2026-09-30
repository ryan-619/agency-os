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
import { readMailSignals } from '@agency/core'
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

  /**
   * What the mail says about itself. A reply carries no delivery-status part
   * and says nothing; its headers are still read, because an out-of-office
   * says it is one in `Auto-Submitted`, not in its words.
   */
  it('has no DSN for a plain reply, and passes the signal headers it carries', async () => {
    const mail = await parseInbound(
      raw(
        `From: priya@rentman.io
Subject: Automatic reply: A gap
Auto-Submitted: auto-replied
Precedence: bulk
X-Auto-Response-Suppress: All
DKIM-Signature: v=1; a=rsa-sha256; d=rentman.io
In-Reply-To: <sent-1@agency.test>`,
        'I am away until the 21st.',
      ),
    )
    expect(mail!.dsn).toBeNull()
    expect(mail!.originalMessageIds).toEqual([])
    expect(mail!.headers).toEqual({
      'auto-submitted': 'auto-replied',
      precedence: 'bulk',
      'x-auto-response-suppress': 'All',
    })
    expect(readMailSignals(mail!)).toEqual({ kind: 'auto_reply', header: 'auto-submitted' })
  })

  it('passes no signal headers for a mail that has none', async () => {
    const mail = await parseInbound(raw(`From: priya@rentman.io\nSubject: Re`, 'Thursday works.'))
    expect(mail!.headers).toEqual({})
    expect(readMailSignals(mail!)).toBeNull()
  })

  /**
   * A bounce, the way Postfix writes one: a multipart/report whose second
   * part is the delivery status and whose third is the returned message.
   * mailparser would inline the status into `text` by default; the parser
   * keeps it as the part it is, and reads the returned copy's Message-ID —
   * the only thing that ties the report to a message this system sent.
   */
  const BOUNCE = raw(
    `From: Mail Delivery System <MAILER-DAEMON@mx.rentman.io>
To: outreach@agency.test
Subject: Undelivered Mail Returned to Sender
Auto-Submitted: auto-replied
Message-ID: <dsn-1@mx.rentman.io>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"`,
    [
      '--B',
      'Content-Type: text/plain; charset=us-ascii',
      '',
      'I am sorry to have to inform you that your message could not be delivered.',
      '--B',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.rentman.io',
      '',
      'Final-Recipient: rfc822; priya@rentman.io',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      '',
      '--B',
      'Content-Type: message/rfc822',
      '',
      'From: outreach@agency.test',
      'To: priya@rentman.io',
      'Subject: A gap on your security page',
      'Message-ID: <sent-1@agency.test>',
      'References: <their-1@rentman.io>',
      '',
      'Hello.',
      '--B--',
      '',
    ].join('\r\n'),
  )

  it('keeps a delivery report as its part, and reads the returned copy’s Message-ID first', async () => {
    const mail = await parseInbound(BOUNCE)
    expect(mail!.dsn).toContain('Action: failed')
    expect(mail!.dsn).toContain('Status: 5.1.1')
    // The report is not the body: the status fields are not read as somebody's words.
    expect(mail!.text).not.toContain('Action: failed')
    expect(mail!.originalMessageIds).toEqual(['<sent-1@agency.test>', '<their-1@rentman.io>'])
    expect(mail!.headers['auto-submitted']).toBe('auto-replied')
    expect(mail!.headers['content-type']).toBe('multipart/report')
    expect(readMailSignals(mail!)).toMatchObject({ kind: 'bounce', permanent: true, status: '5.1.1', recipient: 'priya@rentman.io' })
  })

  it('reads the returned copy from a text/rfc822-headers part too', async () => {
    const mail = await parseInbound(BOUNCE.replace('Content-Type: message/rfc822', 'Content-Type: text/rfc822-headers'))
    expect(mail!.originalMessageIds[0]).toBe('<sent-1@agency.test>')
  })

  /** A person forwarding one of our messages as an attachment is not a report about it. */
  it('reads no returned copy from a mail that is not a report', async () => {
    const mail = await parseInbound(
      raw(
        `From: sam@rentman.io
Subject: Fwd: A gap
Content-Type: multipart/mixed; boundary="M"`,
        [
          '--M',
          'Content-Type: text/plain',
          '',
          'See below.',
          '--M',
          'Content-Type: message/rfc822',
          '',
          'From: outreach@agency.test',
          'Message-ID: <sent-1@agency.test>',
          '',
          'Hello.',
          '--M--',
          '',
        ].join('\r\n'),
      ),
    )
    expect(mail!.dsn).toBeNull()
    expect(mail!.originalMessageIds).toEqual([])
  })
})
