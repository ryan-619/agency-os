/**
 * The one HTML-to-text converter the inbound paths share (§2.1).
 *
 * What it is FOR is read here with the readers that consume it: `ownWords`
 * and the broad removal reader live in this package, the narrow opt-out
 * reader (`looksLikeOptOut`) in packages/db — tested against this output in
 * apps/agent/test/inbox.test.ts (the IMAP parser) and
 * apps/web/test/resend-inbound.test.ts (the Resend route).
 */
import { describe, expect, it } from 'vitest'
import { HTML_TEXT_MAX_INPUT, decodeHtmlEntities, htmlToText, mentionsRemovalOrDeparture, ownWords } from '../src/index.js'

/** What Gmail sends for a one-word reply above the quoted original. */
const GMAIL_STOP =
  '<div dir="ltr">Stop</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
  'On Mon, 28 Sept 2026 at 09:00, Agency &lt;hello@agency.example&gt; wrote:<br></div>' +
  '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex">Hi Jane — we looked at acme.example from the outside.' +
  '<br>Reply stop and we will not write again.</blockquote></div>'

describe('htmlToText', () => {
  it('keeps the person’s words on their own line, above the quote', () => {
    const text = htmlToText(GMAIL_STOP)
    expect(text.split('\n')[0]).toBe('Stop')
    expect(ownWords(text).trim()).toBe('Stop')
    expect(text).toContain('\n> Hi Jane')
  })

  /** The quote is cut from the own words, so a quoted "unsubscribe" is never theirs. */
  it('opens a blockquote with ">" so the quote is cut from their words', () => {
    const text = htmlToText('<p>Sounds interesting.</p><blockquote><p>To unsubscribe, reply stop.</p></blockquote>')
    expect(ownWords(text).trim()).toBe('Sounds interesting.')
    expect(mentionsRemovalOrDeparture(text)).toBe(false)
  })

  it('ends a line at every block element and at <br>', () => {
    expect(htmlToText('<div>one</div><p>two</p>three<br/>four<li>five</li>')).toBe('one\n\ntwo\nthree\nfour\nfive')
  })

  it('drops script, style, head, title and comments whole, and decodes entities once', () => {
    expect(
      htmlToText(
        '<head><title>stop</title></head><style>p{color:red}</style><script>stop()</script><!-- stop -->' +
          '<p>a &amp;lt; b &#233;&#x2014;&nbsp;c</p>',
      ),
    ).toBe('a &lt; b é— c')
  })

  it('folds runs of spaces, tabs and no-break spaces inside a line', () => {
    expect(htmlToText('<p>a \t  b&#160;&#160;c</p>')).toBe('a b c')
  })

  it('reads at most HTML_TEXT_MAX_INPUT characters of a huge document', () => {
    const text = htmlToText(`<p>${'x'.repeat(HTML_TEXT_MAX_INPUT + 5_000)}</p><p>tail</p>`)
    expect(text).not.toContain('tail')
    expect(text.length).toBeLessThanOrEqual(HTML_TEXT_MAX_INPUT)
  })

  it('has nothing to say about markup with no words', () => {
    expect(htmlToText('<p> </p><br><div></div>')).toBe('')
  })
})

describe('decodeHtmlEntities', () => {
  it('decodes the six named entities and numeric references, case-insensitively', () => {
    expect(decodeHtmlEntities('&AMP; &lt;&gt; &quot;&apos; &#65;&#x42;&#X43;')).toBe(`& <> "' ABC`)
  })

  it('leaves a reference that names no character alone', () => {
    expect(decodeHtmlEntities('&bogus; &#0; &#xD800; &#x110000;')).toBe('&bogus; &#0; &#xD800; &#x110000;')
  })

  it('decodes in one pass', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;')
  })
})
