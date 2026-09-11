/**
 * The HTML reader, checked against the engine it is a port of.
 *
 * packages/scanner/src/htmlparser.ts reproduces `html.parser.HTMLParser`
 * because the reference engine reads pages with it and PROMPT.md §8.3 says the
 * rules encoded there ARE the product. parity.test.ts proves the two agree on
 * sixteen real pages; real pages are well behaved, and every bug this port was
 * written to fix lives in markup that is not.
 *
 * So this replays a corpus of hostile tag soup — hand-written cases plus two
 * thousand seeded random ones — through the port, and asserts it answers what
 * the reference extractor answered when tools/html-parity-corpus.py ran it.
 * Regenerate with `npm run fixtures:html-parity`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { extractHtmlFacts } from '../src/html.js'

interface Case {
  readonly html: string
  readonly title: string
  readonly scripts: readonly string[]
  readonly has_login: boolean
}

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/html-parity.json', import.meta.url)), 'utf8'),
) as { readonly python: string; readonly cases: readonly Case[] }

/** `sp["title"] = p.title[:160]` — sliced by code point, as Python slices. */
function titleAsRecorded(title: string): string {
  return Array.from(title).slice(0, 160).join('')
}

describe(`the HTML reader against CPython ${corpus.python}'s HTMLParser`, () => {
  it('has a corpus worth running', () => {
    expect(corpus.cases.length).toBeGreaterThan(1500)
    // A corpus where nothing is ever found would pass trivially.
    expect(corpus.cases.filter((c) => c.title).length).toBeGreaterThan(100)
    expect(corpus.cases.filter((c) => c.scripts.length > 0).length).toBeGreaterThan(100)
    expect(corpus.cases.filter((c) => c.has_login).length).toBeGreaterThan(100)
  })

  it('agrees with the reference on every case', () => {
    const disagreements: string[] = []
    for (const c of corpus.cases) {
      const facts = extractHtmlFacts(c.html)
      const ours = {
        title: titleAsRecorded(facts.title),
        scripts: [...facts.scripts],
        has_login: facts.hasLogin,
      }
      const theirs = { title: c.title, scripts: [...c.scripts], has_login: c.has_login }
      if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
        disagreements.push(
          `${JSON.stringify(c.html)}\n  python: ${JSON.stringify(theirs)}\n  port:   ${JSON.stringify(ours)}`,
        )
      }
    }
    expect(disagreements.slice(0, 10).join('\n')).toBe('')
    expect(disagreements).toHaveLength(0)
  })
})

describe('the findings that made the port necessary', () => {
  it('does not read a script out of a commented-out IE fallback', () => {
    const html =
      '<!--[if lt IE 9]><script src="/js/jquery-1.11.0.min.js"></script><![endif]-->' +
      '<script src="/js/app.js"></script>'
    expect(extractHtmlFacts(html).scripts).toEqual(['/js/app.js'])
  })

  it('does not read a login surface out of a comment', () => {
    expect(extractHtmlFacts('<!-- <input type="password"> -->').hasLogin).toBe(false)
    expect(extractHtmlFacts('<!-- <a href="/login">x</a> -->').hasLogin).toBe(false)
  })

  it('does not read markup out of a script body', () => {
    const html = `<script>var s = "<input type='password'>";</script>`
    expect(extractHtmlFacts(html).hasLogin).toBe(false)
  })

  it('keeps an href that follows a > inside a quoted attribute', () => {
    expect(extractHtmlFacts('<a onclick="() => go()" href="/login">in</a>').hasLogin).toBe(true)
  })

  it('keeps a src that follows a > inside a quoted attribute', () => {
    const html = '<script onload="if(a>b){}" src="/js/bootstrap-4.6.0.min.js"></script>'
    expect(extractHtmlFacts(html).scripts).toEqual(['/js/bootstrap-4.6.0.min.js'])
  })

  it('decodes the whole HTML5 entity table, not a handful of names', () => {
    // `&notit;` is the case the standard itself calls out: longest prefix wins
    // and the remainder stays literal.
    expect(extractHtmlFacts('<title>&notit; &Egrave; &amp &#x2014;</title>').title).toBe(
      '¬it; È & —',
    )
  })

  it('reads the rest of the document as the title when </title> never comes', () => {
    // Python leaves the in-title flag set, so everything after it accumulates.
    // Reproduced because the score depends on it, not because it is right.
    expect(extractHtmlFacts('<title>a<p>b</p>c').title).toBe('abc')
  })
})
