/**
 * A page reader and a conversation ledger for the true-data tests
 * (2026-10-13): answers from a table, recorded, never the internet.
 */
import { htmlToText } from '@agency/core'
import type { DomainAnswer, MailHosts, PageRead } from '@agency/scanner'
import type { ConversationLedger, SeenOrigin, WebReader } from '../src/index.js'

/** A page that loaded, its words read as the scanner's reader reads them. */
export function htmlPage(url: string, html: string, finalUrl = url): PageRead {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null
  return { ok: true, url, finalUrl, status: 200, title, text: htmlToText(html), html, truncated: false }
}

const notFound = (url: string): PageRead => ({ ok: false, url, why: 'status', status: 404, detail: 'The site answered 404.' })

/**
 * A page reader that answers from a table and records every address it was
 * asked for. A page the table lacks is a 404; `slow` never answers, so only
 * the tool's own deadline ends the wait.
 */
export function fakeWeb(
  pages: Record<string, PageRead | 'slow'>,
  dns: { mail?: Record<string, MailHosts>; resolves?: Record<string, DomainAnswer> } = {},
): WebReader & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async read(url, signal) {
      asked.push(url)
      const hit = pages[url]
      if (hit === 'slow') {
        return new Promise<PageRead>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ ok: false, url, why: 'timeout', detail: 'aborted' }), { once: true })
        })
      }
      return hit ?? notFound(url)
    },
    async mailHosts(domain) {
      return dns.mail?.[domain] ?? { ok: true, via: 'mx', hosts: [`mx.${domain}`] }
    },
    async resolves(domain) {
      return dns.resolves?.[domain] ?? 'public'
    },
  }
}

/** What a conversation showed, by whom: the first origin of each kind, as the worker's ledger answers. */
export function fakeLedger(entries: ReadonlyArray<{ readonly text: string; readonly origin: SeenOrigin }>): ConversationLedger {
  return {
    async find(test) {
      const out: SeenOrigin[] = []
      for (const e of entries) {
        if (!test(e.text)) continue
        const same = out.some((o) => o.kind === e.origin.kind && (o.kind === 'person' || (e.origin.kind === 'tool' && o.tool === e.origin.tool)))
        if (!same) out.push(e.origin)
      }
      return out
    },
  }
}

