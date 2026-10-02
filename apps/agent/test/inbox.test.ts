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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { htmlToText, readMailSignals } from '@agency/core'
import { handleInboundEmail, looksLikeOptOut, schema, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
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

  /**
   * An HTML-only reply whose HTML is NOT the root of the message. mailparser
   * converts a root `text/html` to text itself and keeps its lines; for an
   * HTML part inside a multipart — Outlook's multipart/related (the HTML
   * beside its signature image), or a multipart/alternative with no plain
   * part — it leaves `text` empty, and the fallback used to flatten the HTML
   * to ONE line. `Stop<blockquote>On Mon … wrote: …` became `Stop On Mon …
   * wrote: …`, which is not a line that IS an opt-out: the contact was
   * paused and never suppressed. It now goes through the converter the
   * Resend path uses (`htmlToText` in packages/core), which keeps the lines.
   */
  describe('an HTML-only reply below the root', () => {
    const STOP_HTML =
      '<div dir="ltr">Stop</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
      'On Mon, 28 Sept 2026 at 09:00, Agency &lt;outreach@agency.test&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote">Hi Priya — we looked at rentman.io from the outside.' +
      '<br>Reply stop and we will not write again.</blockquote></div>'

    const shapes: [string, string][] = [
      [
        'multipart/related (Outlook, with its signature image)',
        raw(
          `From: Priya <priya@rentman.io>
Subject: RE: A gap
In-Reply-To: <sent-1@agency.test>
MIME-Version: 1.0
Content-Type: multipart/related; boundary="R"`,
          [
            '--R', 'Content-Type: text/html; charset=utf-8', '', STOP_HTML,
            '--R', 'Content-Type: image/png', 'Content-ID: <sig@rentman.io>', 'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=',
            '--R--', '',
          ].join('\r\n'),
        ),
      ],
      [
        'multipart/alternative with no plain part',
        raw(
          `From: priya@rentman.io
Subject: Re: A gap
In-Reply-To: <sent-1@agency.test>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="A"`,
          ['--A', 'Content-Type: text/html; charset=utf-8', '', STOP_HTML, '--A--', ''].join('\r\n'),
        ),
      ],
    ]

    it.each(shapes)('keeps a one-word "Stop" on its own line in %s, so it reads as an opt-out', async (_shape, message) => {
      const mail = await parseInbound(message)
      expect(mail!.text?.split('\n')[0]).toBe('Stop')
      expect(looksLikeOptOut(mail!.text)).toBe(true)
      // The quote is still marked as a quote, so its "Reply stop" is never read as theirs.
      expect(mail!.text).toContain('\n> Hi Priya')
    })

    it.each(shapes)('decodes entities once in %s', async (_shape, message) => {
      const mail = await parseInbound(message)
      expect(mail!.text).toContain('Agency <outreach@agency.test> wrote:')
      expect(mail!.text).not.toContain('&lt;')
    })

    /** And the same converter as the Resend path, so "stop" means one thing whichever way it arrived. */
    it.each(shapes)('reads %s exactly as the Resend path reads the same HTML', async (_shape, message) => {
      const mail = await parseInbound(message)
      expect(mail!.text).toBe(htmlToText(STOP_HTML))
    })

    it('does not read a quoted "unsubscribe" below an HTML-only answer as the person’s own words', async () => {
      const mail = await parseInbound(
        raw(
          `From: priya@rentman.io
Subject: Re
Content-Type: multipart/alternative; boundary="A"`,
          ['--A', 'Content-Type: text/html', '', '<p>Sounds good, send the details.</p><blockquote><p>unsubscribe</p></blockquote>', '--A--', ''].join('\r\n'),
        ),
      )
      expect(mail!.text?.split('\n')[0]).toBe('Sounds good, send the details.')
      expect(looksLikeOptOut(mail!.text)).toBe(false)
    })

    /** An empty plain part says nothing; the words are in the HTML beside it — the Resend mapping's rule. */
    it('reads the HTML when the plain part is blank', async () => {
      const mail = await parseInbound(
        raw(
          `From: priya@rentman.io
Subject: Re
Content-Type: multipart/alternative; boundary="A"`,
          ['--A', 'Content-Type: text/plain', '', '   ', '--A', 'Content-Type: text/html', '', STOP_HTML, '--A--', ''].join('\r\n'),
        ),
      )
      expect(looksLikeOptOut(mail!.text)).toBe(true)
    })

    /** A root text/html was always converted by mailparser, and still is: nothing changes for it. */
    it('leaves a root text/html to mailparser, which already kept its lines', async () => {
      const mail = await parseInbound(raw(`From: priya@rentman.io\nSubject: Re\nContent-Type: text/html; charset=utf-8`, STOP_HTML))
      expect(mail!.text?.split('\n')[0]).toBe('Stop')
      expect(looksLikeOptOut(mail!.text)).toBe(true)
    })
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

  /**
   * A prospect answers "please unsubscribe me" and forwards, INLINE, the
   * bounce our message caused somewhere else (mutt with `mime_forward=yes`
   * writes a message/rfc822 part with `Content-Disposition: inline`).
   * mailparser walks into an inline message, so the nested delivery status
   * surfaced in `attachments` exactly as a real report's does — and the
   * whole mail, opt-out included, was read as a bounce of our message.
   */
  it('reads no report nested inside an inline-forwarded message', async () => {
    const mail = await parseInbound(INLINE_FORWARD)
    expect(mail!.dsn).toBeNull()
    expect(mail!.originalMessageIds).toEqual([])
    expect(mail!.text?.split(/\r?\n/)[0]).toBe('Please unsubscribe me.')
    expect(mail!.references).toEqual(['<sent-1@agency.test>'])
    expect(readMailSignals(mail!)).toBeNull()
  })

  /** The same report forwarded as an ATTACHMENT was already opaque; it stays so. */
  it('reads no report nested inside a message forwarded as an attachment', async () => {
    const mail = await parseInbound(INLINE_FORWARD.replace('Content-Disposition: inline', 'Content-Disposition: attachment'))
    expect(mail!.dsn).toBeNull()
  })
})

/**
 * The outer message of `INLINE_FORWARD`: a reply to a message this system
 * sent, whose own words are an opt-out, carrying a delivery report as an
 * inline message/rfc822 part.
 */
const NESTED_BOUNCE = [
  'From: Mail Delivery System <MAILER-DAEMON@mx.example.org>',
  'Subject: Undelivered Mail Returned to Sender',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain',
  '',
  'Your message could not be delivered.',
  '--B',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.org',
  '',
  'Final-Recipient: rfc822; priya@rentman.io',
  'Action: failed',
  'Status: 5.1.1',
  '',
  '--B',
  'Content-Type: message/rfc822',
  '',
  'From: outreach@agency.test',
  'To: priya@rentman.io',
  'Message-ID: <sent-1@agency.test>',
  '',
  'Hello.',
  '--B--',
  '',
].join('\r\n')

const INLINE_FORWARD = raw(
  `From: Priya <priya@rentman.io>
To: outreach@agency.test
Subject: Re: A gap on your security page
Message-ID: <their-2@rentman.io>
In-Reply-To: <sent-1@agency.test>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="M"`,
  [
    '--M',
    'Content-Type: text/plain',
    '',
    'Please unsubscribe me.',
    '',
    'And this is what happened when you wrote to my old address:',
    '--M',
    'Content-Type: message/rfc822',
    'Content-Disposition: inline',
    '',
    NESTED_BOUNCE,
    '--M--',
    '',
  ].join('\r\n'),
)

/**
 * The same mail through `handleInboundEmail`, the way the listener hands it
 * over: it must reach `recordInboundReply` as the reply it is, and its
 * opt-out must be recorded — not answered with "no contact was changed".
 */
const NOON = new Date('2026-09-15T12:00:00.000Z')

/** One org, one company, one contact, and the message this system sent them as `<sent-1@agency.test>`. */
async function seedRentman(db: AgencyDb): Promise<{ orgId: string; contactId: string }> {
  const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
  const orgId = org!.id
  const [company] = await db
    .insert(schema.companies)
    .values({ orgId, domain: 'rentman.io', timeZone: 'Europe/London' })
    .returning({ id: schema.companies.id })
  const [contact] = await db
    .insert(schema.contacts)
    .values({ orgId, companyId: company!.id, email: 'priya@rentman.io', timeZone: 'Europe/London' })
    .returning({ id: schema.contacts.id })
  const contactId = contact!.id
  await db.insert(schema.touches).values({
    orgId, contactId, companyId: company!.id, channel: 'email', direction: 'out', status: 'sent',
    recipient: 'priya@rentman.io', sentAt: NOON, providerId: '<sent-1@agency.test>',
    subject: 'A gap on your security page', body: 'Hello.',
  })
  return { orgId, contactId }
}

describe('an inline-forwarded bounce reaching the recorder', () => {
  let test: TestDb
  let db: AgencyDb
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    ;({ contactId } = await seedRentman(db))
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('is recorded as a reply, and its opt-out suppresses the address', async () => {
    const mail = await parseInbound(INLINE_FORWARD)
    const outcome = await handleInboundEmail(db, { ...mail!, now: NOON })
    expect(outcome.matched).toBe('message')
    if (outcome.matched === 'none') return
    expect(outcome.suppressed).toBe(true)
    expect(outcome.paused).toBe(true)

    const [reply] = await db.select().from(schema.touches).where(eq(schema.touches.id, outcome.touchId))
    expect(reply!.direction).toBe('in')
    const [person] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
    // A bounce would have marked the address; a reply does not.
    expect(person!.emailBouncedAt).toBeNull()
    expect(person!.pausedAt).not.toBeNull()
    const suppressions = await db.select().from(schema.suppressions)
    expect(suppressions.map((r) => r.value)).toContain('priya@rentman.io')
  })
})

/**
 * The HTML-only "Stop" through `handleInboundEmail`, the way the listener
 * hands it over. Before, the flattened line paused the contact and wrote no
 * suppression row: the person who said stop could be written to again the
 * moment a teammate lifted the pause.
 */
describe('an HTML-only "Stop" below the root, reaching the recorder', () => {
  let test: TestDb
  let db: AgencyDb
  let contactId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    ;({ contactId } = await seedRentman(db))
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('suppresses the address, not merely pauses the contact', async () => {
    const mail = await parseInbound(
      raw(
        `From: Priya <priya@rentman.io>
To: outreach@agency.test
Subject: RE: A gap on your security page
Message-ID: <their-3@rentman.io>
In-Reply-To: <sent-1@agency.test>
MIME-Version: 1.0
Content-Type: multipart/related; boundary="R"`,
        [
          '--R', 'Content-Type: text/html; charset=utf-8', '',
          '<div>Stop</div><blockquote>On Mon, 14 Sept 2026, Agency wrote:<br>Hi Priya — we looked at rentman.io from the outside.</blockquote>',
          '--R', 'Content-Type: image/png', 'Content-ID: <sig@rentman.io>', 'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=',
          '--R--', '',
        ].join('\r\n'),
      ),
    )
    const outcome = await handleInboundEmail(db, { ...mail!, now: NOON })
    expect(outcome.matched).toBe('message')
    if (outcome.matched === 'none') return
    expect(outcome.replyKind).toBe('opted_out')
    expect(outcome.suppressed).toBe(true)
    expect(outcome.paused).toBe(true)
    const [person] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))
    expect(person!.pausedAt).not.toBeNull()
    const suppressions = await db.select().from(schema.suppressions)
    expect(suppressions.map((r) => r.value)).toEqual(['priya@rentman.io'])
  })
})
