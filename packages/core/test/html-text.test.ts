/**
 * An HTML-only reply as text, with its lines kept.
 *
 * What is pinned here is the OUTPUT, byte for byte, because the opt-out
 * reader downstream reads it by line: the first line above anything quoted.
 * Whether that text then IS an opt-out is `looksLikeOptOut`'s question, in
 * packages/db — and the two paths that hand it this text ask it in
 * apps/agent/test/inbox.test.ts and apps/web/test/resend-inbound.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/index.js'

/** What Gmail sends for a one-word reply above the quoted original. */
const GMAIL_STOP =
  '<div dir="ltr">Stop</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
  'On Mon, 28 Sept 2026 at 09:00, Agency &lt;hello@agency.example&gt; wrote:<br></div>' +
  '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex">Hi Jane — we looked at acme.example from the outside.' +
  '<br>Reply stop and we will not write again.</blockquote></div>'

describe('htmlToText', () => {
  it('keeps a one-word reply on its own line, above the attribution and the quote', () => {
    expect(htmlToText(GMAIL_STOP)).toBe(
      'Stop\n' +
        '\n' +
        'On Mon, 28 Sept 2026 at 09:00, Agency <hello@agency.example> wrote:\n' +
        '\n' +
        '> Hi Jane — we looked at acme.example from the outside.\n' +
        'Reply stop and we will not write again.',
    )
  })

  /**
   * The `>` marks where the quote OPENS, not every line inside it. That is
   * all the reader needs — it takes the person's words as everything above
   * the first line that starts `>` — and it is the behaviour both inbound
   * paths have always had through this function, so it is pinned rather
   * than improved.
   */
  it('opens a blockquote with a `>` line, so a quoted word sits below the marker', () => {
    expect(htmlToText('<p>Sounds interesting, send me the details.</p><blockquote><p>unsubscribe</p></blockquote>'))
      .toBe('Sounds interesting, send me the details.\n\n>\nunsubscribe')
  })

  it('drops script, style and comments whole, and decodes entities once', () => {
    expect(htmlToText('<style>p{color:red}</style><script>stop()</script><!-- stop --><p>a &amp;lt; b &#233;&#x2014;&nbsp;c</p>'))
      .toBe('a &lt; b é— c')
  })

  it('leaves an entity it does not know alone', () => {
    expect(htmlToText('<p>&bogus; &#0; &#xD800;</p>')).toBe('&bogus; &#0; &#xD800;')
  })

  it('collapses runs of blank lines to one, and trims the whole', () => {
    expect(htmlToText('\r\n<p>one</p>\r\n\r\n\r\n\r\n<p>two</p>\r\n')).toBe('one\n\ntwo')
  })

  /** A bound on the work, not on the reply: a real reply's own words are at the top. */
  it('reads no further than the first 200 000 characters of markup', () => {
    const out = htmlToText('x'.repeat(199_990) + '<p>0123456789 stop</p>')
    expect(out.endsWith('\n0123456')).toBe(true)
    expect(out).not.toContain('stop')
  })
})
