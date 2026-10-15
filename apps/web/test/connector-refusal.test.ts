/**
 * Settings → Connectors says when a server refused a call (0029).
 *
 * Test connection lists a server's tools and calls none, so a keyless
 * Firecrawl or Jina passed it with a green "Last answered" and then refused
 * every search the assistant made ("keyless access is unavailable", 401),
 * and Tavily answered 429 — and the page said nothing. The worker now records
 * when a server refused and our own word for why (`auth` or `quota`), and the
 * page says it beside "Last answered", with where it is fixed.
 *
 * The page and the panel import `@/…`, so they are pinned by reading their
 * source, as this suite pins every module it cannot import.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('a connector’s last refusal', () => {
  const page = src('app/settings/connectors/page.tsx')
  const panel = src('components/settings/connectors.tsx')

  it('crosses to the browser as a time and a kind word, through toView, with nothing else of the row', () => {
    const toView = /function toView\(row: ConnectorRow\): ConnectorView \{[\s\S]*?\n\}/.exec(page)?.[0] ?? ''
    expect(toView).toMatch(
      /lastFailure:\s*row\.lastFailureAt && \(row\.lastFailureKind === 'auth' \|\| row\.lastFailureKind === 'quota'\)\s*\? \{ at: row\.lastFailureAt\.toISOString\(\), kind: row\.lastFailureKind \}\s*: null,/,
    )
    // The boundary holds: neither the config nor the credential's pointer crosses.
    expect(toView).not.toMatch(/\bconfig:|secretRef:/)
  })

  it('says when, what the refusal means and where it is fixed — in our words, never the server’s', () => {
    expect(panel).toContain("auth: 'its key is missing, wrong or not accepted — re-enter it in Settings → Credentials'")
    expect(panel).toContain("quota: 'rate-limited or out of quota — check the plan with the provider'")
    expect(panel).toMatch(
      /Refused a call <When iso=\{c\.lastFailure\.at\} \/>: \{CONNECTOR_REFUSAL_WORDS\[c\.lastFailure\.kind\]\}/,
    )
    // Beside "Last answered": after it, before the probe's own error line.
    const answered = panel.indexOf('Last answered <When iso={c.lastOkAt} />')
    const refused = panel.indexOf('Refused a call <When')
    const probeError = panel.indexOf('{c.lastError ? <div className="err-line">{c.lastError}</div> : null}')
    expect(answered).toBeGreaterThan(-1)
    expect(refused).toBeGreaterThan(answered)
    expect(probeError).toBeGreaterThan(refused)
  })

  it('types the view to the two kinds the database admits', () => {
    expect(panel).toContain("export type ConnectorRefusalKind = 'auth' | 'quota'")
    expect(panel).toMatch(/readonly lastFailure: \{ readonly at: string; readonly kind: ConnectorRefusalKind \} \| null/)
  })
})
