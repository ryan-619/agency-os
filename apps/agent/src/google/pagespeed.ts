/**
 * Google PageSpeed Insights, for `audit_website` (2026-10-08).
 *
 * `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed` with
 * `url`, `strategy` (MOBILE | DESKTOP) and `category` repeated (PERFORMANCE,
 * ACCESSIBILITY, BEST_PRACTICES, SEO), and `key` when there is one — as
 * Google documents it (https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed).
 * Lighthouse loads the page from Google's side, like any visitor; nothing
 * here requests the site.
 *
 * Two kinds of failure, never confused (§2.2). A page Lighthouse could not
 * load — `FAILED_DOCUMENT_REQUEST`, `NO_FCP`, a DNS failure — is a RESULT:
 * `ok: false` with the reason, stored, and no score, so it can never read as
 * a slow site. The SERVICE failing — a quota, a refused key, a timeout, a
 * fault on Google's side — throws, and records nothing.
 *
 * The key rides in the query string, so the request URL is never logged or
 * put in a message; `redirect: 'error'` keeps it from following a redirect.
 */
import type { SiteAuditResult } from '@agency/db'
import type { PageSpeedClient } from '@agency/tools'
import { GoogleApiError, googleStatusWord } from './places.js'

export const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
export const PAGESPEED_TIMEOUT_MS = 110_000

const CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'] as const

function failed(reason: string): SiteAuditResult {
  return {
    ok: false, error: reason, performance: null, accessibility: null, bestPractices: null, seo: null,
    lcpMs: null, cls: null, tbtMs: null, fcpMs: null, fieldCategory: null,
  }
}

/** Lighthouse's own code for a page it could not load, from an error message; a fixed vocabulary. */
export function lighthouseCode(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const m = /Lighthouse returned error: ([A-Z_]{3,60})/.exec(message)
  return m ? m[1]! : null
}

const scoreOf = (category: unknown): number | null => {
  const s = (category as { score?: unknown } | undefined)?.score
  return typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 100) : null
}
const valueOf = (audit: unknown): number | null => {
  const v = (audit as { numericValue?: unknown } | undefined)?.numericValue
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** One answer from PageSpeed, read defensively. */
export function auditFrom(body: unknown): SiteAuditResult {
  const o = (body ?? {}) as { lighthouseResult?: Record<string, unknown>; loadingExperience?: { overall_category?: unknown } }
  const lh = o.lighthouseResult
  if (!lh || typeof lh !== 'object') return failed('PageSpeed answered without a Lighthouse result')
  const runtimeCode = (lh.runtimeError as { code?: unknown } | undefined)?.code
  if (typeof runtimeCode === 'string' && runtimeCode !== 'NO_ERROR' && /^[A-Z_]{3,60}$/.test(runtimeCode)) {
    return failed(`Lighthouse could not load the page (${runtimeCode})`)
  }
  const cats = (lh.categories ?? {}) as Record<string, unknown>
  const audits = (lh.audits ?? {}) as Record<string, unknown>
  const field = o.loadingExperience?.overall_category
  const cls = valueOf(audits['cumulative-layout-shift'])
  return {
    ok: true,
    error: null,
    performance: scoreOf(cats.performance),
    accessibility: scoreOf(cats.accessibility),
    bestPractices: scoreOf(cats['best-practices']),
    seo: scoreOf(cats.seo),
    lcpMs: valueOf(audits['largest-contentful-paint']),
    cls: cls === null ? null : Math.round(cls * 1000) / 1000,
    tbtMs: valueOf(audits['total-blocking-time']),
    fcpMs: valueOf(audits['first-contentful-paint']),
    fieldCategory: field === 'FAST' || field === 'AVERAGE' || field === 'SLOW' ? field : null,
  }
}

export function pageSpeedClient(config: {
  readonly apiKey: string | null
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}): PageSpeedClient {
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? PAGESPEED_TIMEOUT_MS
  const apiKey = config.apiKey
  return {
    async run(args, signal) {
      const q = new URLSearchParams({ url: args.url, strategy: args.strategy === 'desktop' ? 'DESKTOP' : 'MOBILE' })
      for (const c of CATEGORIES) q.append('category', c)
      if (apiKey) q.set('key', apiKey)
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
      let res: Response
      try {
        res = await doFetch(`${PAGESPEED_ENDPOINT}?${q.toString()}`, { redirect: 'error', signal: AbortSignal.any(signals) })
      } catch {
        throw new GoogleApiError('pagespeed', null, 'PageSpeed did not answer in time')
      }
      const body = (await res.json().catch(() => null)) as unknown
      if (res.ok) return auditFrom(body)
      // A page Lighthouse could not load comes back as a 400 naming its code:
      // that is the SITE, and a result.
      const code = lighthouseCode((body as { error?: { message?: unknown } } | null)?.error?.message)
      if (res.status === 400 && code) return failed(`Lighthouse could not load the page (${code})`)
      const word = googleStatusWord(body)
      if (res.status === 429) {
        throw new GoogleApiError(
          'pagespeed',
          429,
          apiKey
            ? 'PageSpeed’s quota for this key is used up for now'
            : 'PageSpeed’s shared quota is used up — a Google API key with the PageSpeed Insights API enabled raises it (./tools/run-worker.sh --google)',
        )
      }
      if (res.status === 403) {
        throw new GoogleApiError('pagespeed', 403, 'PageSpeed refused the key — enable the PageSpeed Insights API on the key’s Google Cloud project')
      }
      throw new GoogleApiError('pagespeed', res.status, `PageSpeed answered ${res.status}${word ? ` ${word}` : ''}`)
    },
  }
}
