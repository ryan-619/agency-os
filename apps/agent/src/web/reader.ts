/**
 * The open web, read from the worker (2026-10-13) — what `read_page`,
 * `find_contact_details` and `check_contacts` reach the internet through.
 *
 * Every read goes through the scanner's own machinery (`readPublicPage`,
 * `mailHostsOf`, `domainResolves`): public pages only, a public address at
 * every connection, no probe of a path a page reader must never be pointed
 * at. This module adds nothing to what may be read; it only remembers what
 * was, so a page asked for twice in one conversation — `find_contact_details`
 * after `read_page` on the same site, or a helper repeating the main thread —
 * is one request to the business, not two.
 *
 * Remembered per worker process, never written anywhere:
 *
 *  - a page for ten minutes, at most 200 of them, oldest dropped first. A
 *    page that timed out, could not be reached, or answered a server error or
 *    a 429 is remembered for one minute only: those say how the site was a
 *    moment ago, not what it is;
 *  - whether a domain receives mail, and whether it resolves, for thirty
 *    minutes — a DNS lookup that could not be answered for one minute;
 *  - and while a page or a domain is being read, a second caller waits for
 *    the same answer rather than starting another request.
 *
 * A caller's `AbortSignal` ends ITS wait and nobody else's: another tool may
 * be waiting on the same page. The request itself is stopped only when every
 * caller waiting on it has given up, and an answer nobody waited for is not
 * remembered.
 */
import {
  domainResolves, mailHostsOf, readPublicPage,
  type DomainAnswer, type MailHosts, type PageRead,
} from '@agency/scanner'
import type { WebReader } from '@agency/tools'

/** `ToolContext.web`'s shape (packages/tools spec.ts), which this module builds. */
export type { WebReader }

export const PAGE_CACHE_MS = 10 * 60_000
/** A page that timed out, could not be reached, or answered 5xx or 429: a moment's answer. */
export const PAGE_BRIEF_CACHE_MS = 60_000
export const PAGE_CACHE_MAX = 200
export const DOMAIN_CACHE_MS = 30 * 60_000
/** A DNS question nobody could answer (a timeout, SERVFAIL): a moment's answer. */
export const DOMAIN_BRIEF_CACHE_MS = 60_000
export const DOMAIN_CACHE_MAX = 500

export interface WebReaderOptions {
  /** The page reader; `readPublicPage` by default. Tests hand in their own. */
  readonly read?: (url: string, opts: { readonly signal: AbortSignal }) => Promise<PageRead>
  /** `mailHostsOf` by default. */
  readonly mailHosts?: (domain: string) => Promise<MailHosts>
  /** `domainResolves` by default. */
  readonly resolves?: (domain: string) => Promise<DomainAnswer>
  readonly now?: () => Date
}

/** Remembered answers, each until its own moment; the oldest dropped first past `max`. */
class Remembered<T> {
  private readonly entries = new Map<string, { readonly value: T; readonly until: number }>()

  constructor(
    private readonly max: number,
    private readonly keepFor: (value: T) => number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.until <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    const ms = this.keepFor(value)
    if (!(ms > 0)) return
    this.entries.delete(key)
    this.entries.set(key, { value, until: this.now() + ms })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

/** How long a page's answer says something true about the page. */
function pageKeepFor(page: PageRead): number {
  if (page.ok) return PAGE_CACHE_MS
  if (page.why === 'timeout' || page.why === 'unreachable') return PAGE_BRIEF_CACHE_MS
  if (page.why === 'status' && page.status !== undefined && (page.status >= 500 || page.status === 429)) {
    return PAGE_BRIEF_CACHE_MS
  }
  return PAGE_CACHE_MS
}

/** The address with any username or password taken out, as `readPublicPage` reports it. */
function withoutCredentials(url: string): string {
  try {
    const u = new URL(url)
    if (!u.username && !u.password) return url
    u.username = ''
    u.password = ''
    return u.href
  } catch {
    return url
  }
}

/** One key per page: the parsed address when it parses, so `HTTPS://Acme.in` and `https://acme.in/` are one. */
function pageKey(url: string): string {
  const trimmed = url.trim()
  try {
    return new URL(trimmed).href
  } catch {
    return trimmed
  }
}

/** One key per domain: as DNS is asked, lower-cased with no trailing dot. */
function domainKey(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '')
}

/** The answer a caller gets when it stopped waiting. A sentence with nothing of the page in it. */
function stopped(url: string): PageRead {
  return {
    ok: false,
    url: withoutCredentials(url.trim()),
    why: 'timeout',
    detail: 'The read was stopped before the page answered.',
  }
}

/** What a reader that threw answers instead — never the error's own words. */
function unreadable(url: string): PageRead {
  return {
    ok: false,
    url: withoutCredentials(url.trim()),
    why: 'unreachable',
    detail: 'The page could not be read.',
  }
}

interface InFlight {
  readonly promise: Promise<PageRead>
  readonly controller: AbortController
  /** Callers still waiting; one with no signal never gives up, so is never taken off. */
  waiters: number
  settled: boolean
}

export function webReader(opts: WebReaderOptions = {}): WebReader {
  const clock = opts.now ?? (() => new Date())
  const now = (): number => clock().getTime()
  const readPage = opts.read ?? ((url, { signal }) => readPublicPage(url, { signal }))
  const askMail = opts.mailHosts ?? ((domain) => mailHostsOf(domain))
  const askResolves = opts.resolves ?? ((domain) => domainResolves(domain))

  const pages = new Remembered<PageRead>(PAGE_CACHE_MAX, pageKeepFor, now)
  const reading = new Map<string, InFlight>()

  const mail = new Remembered<MailHosts>(
    DOMAIN_CACHE_MAX,
    (m) => (!m.ok && m.why === 'unreachable' ? DOMAIN_BRIEF_CACHE_MS : DOMAIN_CACHE_MS),
    now,
  )
  const askingMail = new Map<string, Promise<MailHosts>>()
  const resolved = new Remembered<DomainAnswer>(
    DOMAIN_CACHE_MAX,
    (a) => (a === 'unreachable' ? DOMAIN_BRIEF_CACHE_MS : DOMAIN_CACHE_MS),
    now,
  )
  const askingResolves = new Map<string, Promise<DomainAnswer>>()

  /** One question asked once at a time, its answer remembered; a throw answers `fallback`, unremembered. */
  function once<T>(
    key: string,
    cache: Remembered<T>,
    inFlight: Map<string, Promise<T>>,
    ask: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const known = cache.get(key)
    if (known !== undefined) return Promise.resolve(known)
    const asking = inFlight.get(key)
    if (asking) return asking
    const promise = (async (): Promise<T> => {
      try {
        const answer = await ask()
        cache.set(key, answer)
        return answer
      } catch {
        return fallback
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }

  function start(key: string, url: string): InFlight {
    const controller = new AbortController()
    const state = { waiters: 0, settled: false }
    const run = async (): Promise<PageRead> => {
      let page: PageRead
      try {
        page = await readPage(url, { signal: controller.signal })
      } catch {
        page = unreadable(url)
      }
      flight.settled = true
      // Remembered only when somebody was still waiting for it: a read
      // stopped because everyone gave up answers `timeout`, which says
      // nothing about the page.
      if (reading.get(key) === flight) {
        reading.delete(key)
        if (!controller.signal.aborted) pages.set(key, page)
      }
      return page
    }
    // The read starts a microtask later, once `flight` exists for it to settle.
    const flight: InFlight = Object.assign(state, { controller, promise: Promise.resolve().then(run) })
    reading.set(key, flight)
    return flight
  }

  return {
    read(url: string, signal?: AbortSignal): Promise<PageRead> {
      const key = pageKey(url)
      const known = pages.get(key)
      if (known) return Promise.resolve(known)
      if (signal?.aborted) return Promise.resolve(stopped(url))
      const flight = reading.get(key) ?? start(key, url)
      // Counted whether or not it can give up: a caller with no signal keeps
      // the request alive for good, because it never stops waiting.
      flight.waiters++
      if (!signal) return flight.promise

      return new Promise<PageRead>((resolve) => {
        let done = false
        const finish = (page: PageRead): void => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          resolve(page)
        }
        const onAbort = (): void => {
          if (done) return
          flight.waiters--
          // Nobody is waiting for this page any more: stop the request, and
          // let the next caller start afresh rather than wait on a dying read.
          if (flight.waiters <= 0 && !flight.settled) {
            if (reading.get(key) === flight) reading.delete(key)
            flight.controller.abort()
          }
          finish(stopped(url))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        void flight.promise.then(finish)
      })
    },

    mailHosts(domain: string): Promise<MailHosts> {
      const key = domainKey(domain)
      return once(key, mail, askingMail, () => askMail(key), { ok: false, why: 'unreachable' })
    },

    resolves(domain: string): Promise<DomainAnswer> {
      const key = domainKey(domain)
      return once(key, resolved, askingResolves, () => askResolves(key), 'unreachable')
    },
  }
}
