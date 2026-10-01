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

/**
 * Review round 3 (finding 7): every regex pass was quadratic when its closing
 * marker never came. `<[^>]*>` over 200,000 `<` with no `>` retried from
 * every one of them — 50 s of one thread, from one email any stranger could
 * send, on the worker's only event loop or in the Resend webhook. Each pass
 * is now a forward scan that stops at the first missing marker.
 */
describe('htmlToText on hostile input', () => {
  const units: [string, string][] = [
    ['"<" with no ">"', '<'],
    ['an unclosed comment', '<!--'],
    ['an unclosed <title', '<title'],
    ['<script> with no </script>', '<script>'],
    ['<head> with no </head>', '<head x>'],
    ['an unclosed <p', '<p'],
    ['an unclosed </div', '</div'],
    ['an unclosed <blockquote', '<blockquote'],
    ['<br and a space', '<br '],
    ['a closing </script with no ">"', '</script '],
  ]

  it.each(units)('reads a megabyte of %s in well under a second', (_label, unit) => {
    const html = 'Stop\n' + unit.repeat(Math.ceil(1_000_000 / unit.length))
    const started = performance.now()
    const text = htmlToText(html)
    expect(performance.now() - started).toBeLessThan(250)
    expect(text.split('\n')[0]).toBe('Stop')
  })

  /** Still linear when the one closing marker comes at the very end. */
  it('reads a megabyte of openers closed once at the end in well under a second', () => {
    for (const [unit, close] of [['<script', '></script>'], ['<p', '>'], ['<', '>'], ['<!--', '-->']] as const) {
      const html = unit.repeat(Math.ceil((HTML_TEXT_MAX_INPUT - 20) / unit.length)) + close
      const started = performance.now()
      htmlToText(html)
      expect(performance.now() - started, unit).toBeLessThan(250)
    }
  })
})

/**
 * The scans replace the regex passes one for one, so they must answer what
 * the regexes answered — not "something similar". The previous
 * implementation is kept here verbatim as the reference, and both read the
 * same seeded tag soup: short enough for the reference to finish, and built
 * from the fragments each pass looks for, opened and left unclosed in every
 * order.
 */
describe('htmlToText answers what the regex passes answered', () => {
  /** The implementation before finding 7, verbatim — quadratic, and the reference. */
  function regexReference(html: string): string {
    const flat = html
      .slice(0, HTML_TEXT_MAX_INPUT)
      .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<blockquote\b[^>]*>/gi, '\n> ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
    return decodeHtmlEntities(flat)
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  const FRAGMENTS = [
    '<', '>', '<<', '>>', '<!--', '-->', '<!-->', '--', '<script>', '<script type="x">', '</script>', '</script >',
    '</SCRIPT>', '<scripts>', '<style>', '</style>', '<STYLE media=x>', '<head>', '<header>', '</head>', '</header>',
    '<title>', '</title>', '<TITLE>', '</Title  >', '<p>', '</p>', '<P class=a>', '<param>', '<p-x>', '<pre>', '<div',
    '</div>', '<li>', '<h1>', '</h6>', '<h7>', '<hr/>', '<br>', '<br/>', '<br />', '<BR  >', '<br class=x>', '<br/ >',
    '<blockquote>', '<blockquote class="q">', '</blockquote>', '<blockquotes>', '<a href="/x">', '</a>', '<b>',
    '<img src=x>', ' ', '  ', '\t', '\n', '\r\n', ' ', '&amp;', '&lt;', '&#233;', '&nbsp;', '&bogus;',
    'Stop', 'stop', 'unsubscribe me', 'On Mon, Agency wrote:', 'x', '"', "'", '=', '/',
  ]

  /** Mulberry32: a seeded PRNG, so a failure names an input that can be replayed. */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('on every existing example', () => {
    for (const html of [
      GMAIL_STOP,
      '<p>Sounds interesting.</p><blockquote><p>To unsubscribe, reply stop.</p></blockquote>',
      '<div>one</div><p>two</p>three<br/>four<li>five</li>',
      '<head><title>stop</title></head><style>p{color:red}</style><script>stop()</script><!-- stop -->' +
        '<p>a &amp;lt; b &#233;&#x2014;&nbsp;c</p>',
      '<p>a \t  b&#160;&#160;c</p>',
      `<p>${'x'.repeat(HTML_TEXT_MAX_INPUT + 5_000)}</p><p>tail</p>`,
      '<p> </p><br><div></div>',
    ]) {
      expect(htmlToText(html)).toBe(regexReference(html))
    }
  })

  it('on 4,000 pieces of seeded tag soup', () => {
    const next = rng(20261001)
    for (let n = 0; n < 4_000; n++) {
      const parts: string[] = []
      const length = 1 + Math.floor(next() * 24)
      for (let k = 0; k < length; k++) parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!)
      const html = parts.join('')
      expect(htmlToText(html), JSON.stringify(html)).toBe(regexReference(html))
    }
  })

  /** A small alphabet, so openers, closers and their halves meet each other far more often. */
  it('on 4,000 pieces of dense soup made of markers and their halves', () => {
    const dense = ['<', '>', '<!--', '-->', '-', '!', '<script>', '</script>', '<title', '</title>', '<p', '</p', '<br', '/', ' ', 'x']
    const next = rng(7)
    for (let n = 0; n < 4_000; n++) {
      let html = ''
      const length = 1 + Math.floor(next() * 40)
      for (let k = 0; k < length; k++) html += dense[Math.floor(next() * dense.length)]!
      expect(htmlToText(html), JSON.stringify(html)).toBe(regexReference(html))
    }
  })

  /** The cut comes first, so a scan never reads past it either. */
  it('cuts at HTML_TEXT_MAX_INPUT before any pass, so a closer past the cut closes nothing', () => {
    const html = `<p>kept</p><script>${'x'.repeat(HTML_TEXT_MAX_INPUT)}</script><p>after</p>`
    expect(htmlToText(html)).toBe(regexReference(html))
    expect(htmlToText(html)).not.toContain('after')
  })
})
