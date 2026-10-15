/**
 * Two questions the assistant asks of DNS before it stores something
 * (2026-10-13): does this domain receive mail at all, and does a website
 * name resolve to the public internet?
 *
 * The first is why `akash@farmley.com` matters: an address composed from a
 * name and a domain pattern went to a mailbox that may not exist, and a
 * domain that receives no mail makes any address at it a guess that cannot
 * arrive. The second is why `myrahspa-mumbai.co` matters: a website domain
 * nobody had shown the assistant, filed for a business whose listing named
 * none. Neither answer proves an address or a site belongs to anybody — it
 * only rules out the ones that cannot.
 *
 * The rule is `apps/web/src/lib/mail-dns.ts`'s: only an AUTHORITATIVE
 * absence — NXDOMAIN (`ENOTFOUND`) or NODATA (`ENODATA`) — is an answer of
 * "no". A timeout, SERVFAIL, a refusal or a malformed reply is
 * `unreachable`: a resolver that could not answer has said nothing about the
 * domain, and reading it as "no mail" would refuse a real address.
 *
 * Every name is checked by `isScannableHost` before it is asked about, so a
 * reserved, private or numeric name is answered without a query. The
 * resolver is injectable for tests; it supplies ANSWERS only and cannot
 * weaken that check or the address judgement (`isPublicAddress`).
 */
import { Resolver } from 'node:dns/promises'
import { domainToASCII } from 'node:url'
import { isPublicAddress } from './address.js'
import { isScannableHost } from './extract.js'

/** Each try of each query; two tries. A DNS answer is quick or it is not coming. */
export const DNS_TIMEOUT_MS = 4_000
const DNS_TRIES = 2

export interface MxAnswer {
  readonly exchange: string
  readonly priority: number
}

/** What `mailHostsOf` and `domainResolves` ask. `node:dns/promises`' `Resolver` is one. */
export interface DnsResolverLike {
  resolveMx(name: string): Promise<readonly MxAnswer[]>
  resolve4(name: string): Promise<readonly string[]>
  resolve6(name: string): Promise<readonly string[]>
}

export interface DnsAnswerOptions {
  /** Each try of each query. Default `DNS_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** Answers only — for tests. Default: a `node:dns/promises` Resolver on the system's servers. */
  readonly resolver?: DnsResolverLike
}

export type MailHosts =
  | { ok: true; via: 'mx' | 'a'; hosts: string[] }
  | { ok: false; why: 'no_domain' | 'no_mail' | 'unreachable' }

export type DomainAnswer = 'public' | 'private' | 'none' | 'unreachable'

/**
 * The domain a caller named, as DNS is asked about it: lower-cased, the
 * scheme, path, port and any `name@` before it taken off (so an address's
 * domain can be passed whole), the final dot dropped, and an international
 * name in its ASCII form. `www.` is KEPT — `www.acme.in` and `acme.in` are
 * different names here, and each is asked about as written. Null when what
 * is left is not a public name.
 */
function nameOf(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  d = d.split(/[/?#]/)[0] ?? ''
  const at = d.lastIndexOf('@')
  if (at !== -1) d = d.slice(at + 1)
  if (!d.startsWith('[')) d = d.split(':')[0] ?? ''
  if (d.endsWith('.')) d = d.slice(0, -1)
  const ascii = d === '' ? '' : domainToASCII(d)
  return ascii !== '' && isScannableHost(ascii) ? ascii : null
}

/** The resolver's code, when it looks like one — nothing else an error carries is read. */
function codeOf(err: unknown): string {
  const raw = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null
  return typeof raw === 'string' && /^(?:E[A-Z_]{2,31}|NXDOMAIN)$/.test(raw) ? raw : 'EUNKNOWN'
}

/** NXDOMAIN and NODATA: the two failures that are answers. */
function isAbsence(code: string): boolean {
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN'
}

class DnsDeadline extends Error {
  readonly code = 'ETIMEOUT'
  constructor() {
    super('the DNS answer did not come in time')
    this.name = 'DnsDeadline'
  }
}

/** The resolver to ask, and what to do once asked: cancel the default one's queries still in flight. */
function resolverFor(opts: DnsAnswerOptions): { ask: DnsResolverLike; done: () => void; budgetMs: number } {
  const timeoutMs = opts.timeoutMs ?? DNS_TIMEOUT_MS
  // A try per server per query can each take the timeout; the whole question
  // — MX and the fallback after it — gets this long, and a little room.
  const budgetMs = timeoutMs * DNS_TRIES + Math.min(1_000, timeoutMs)
  if (opts.resolver) return { ask: opts.resolver, done: () => {}, budgetMs }
  const resolver = new Resolver({ timeout: timeoutMs, tries: DNS_TRIES })
  return { ask: resolver, done: () => resolver.cancel(), budgetMs }
}

/** One query, raced against the question's deadline. */
function within<T>(work: Promise<T>, deadline: number): Promise<T> {
  const ms = Math.max(0, deadline - Date.now())
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsDeadline()), ms)
    timer.unref?.()
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

type Addresses = { kind: 'addresses'; list: readonly string[] } | { kind: 'absent' } | { kind: 'failed' }

/** A and AAAA together: every address either names, or whether both said "none" with authority. */
async function addressesOf(ask: DnsResolverLike, name: string, deadline: number): Promise<Addresses> {
  const [v4, v6] = await Promise.allSettled([within(ask.resolve4(name), deadline), within(ask.resolve6(name), deadline)])
  const list: string[] = []
  let absent = 0
  for (const answer of [v4, v6]) {
    if (answer.status === 'fulfilled') {
      if (answer.value.length === 0) absent += 1
      else list.push(...answer.value)
    } else if (isAbsence(codeOf(answer.reason))) absent += 1
  }
  if (list.length > 0) return { kind: 'addresses', list }
  return absent === 2 ? { kind: 'absent' } : { kind: 'failed' }
}

/**
 * Where mail for a domain goes, or why it goes nowhere.
 *
 * - MX records: their hosts, lowest priority first (`via: 'mx'`).
 * - The null MX (`.`, RFC 7505 — Node reads it as an empty exchange) and no
 *   other, an empty answer, or exchanges that are none of them a public name
 *   (`localhost`, the older way of saying the same): `no_mail`. The domain
 *   says it takes none.
 * - NXDOMAIN: `no_domain`. Nothing by that name exists.
 * - NODATA for MX: RFC 5321 §5.1's implicit MX — mail goes to the domain's
 *   own address, so a PUBLIC A or AAAA record is `via: 'a'` with the domain
 *   as its host, and none (or only private ones) is `no_mail`.
 * - Anything else — a timeout, SERVFAIL, a refused query — `unreachable`.
 *
 * A name `isScannableHost` refuses is `no_domain`, asked of nobody. Never throws.
 */
export async function mailHostsOf(domain: string, opts: DnsAnswerOptions = {}): Promise<MailHosts> {
  const name = nameOf(domain)
  if (name === null) return { ok: false, why: 'no_domain' }
  const { ask, done, budgetMs } = resolverFor(opts)
  const deadline = Date.now() + budgetMs
  try {
    let records: readonly MxAnswer[]
    try {
      records = await within(ask.resolveMx(name), deadline)
    } catch (err) {
      const code = codeOf(err)
      if (code === 'ENOTFOUND' || code === 'NXDOMAIN') return { ok: false, why: 'no_domain' }
      if (code !== 'ENODATA') return { ok: false, why: 'unreachable' }
      const fallback = await addressesOf(ask, name, deadline)
      if (fallback.kind === 'failed') return { ok: false, why: 'unreachable' }
      if (fallback.kind === 'absent' || !fallback.list.some((a) => isPublicAddress(a))) {
        return { ok: false, why: 'no_mail' }
      }
      return { ok: true, via: 'a', hosts: [name] }
    }
    const hosts = [...records]
      .map((r) => ({ host: String(r.exchange ?? '').trim().toLowerCase().replace(/\.$/, ''), priority: Number(r.priority) }))
      // The null MX reads as an empty exchange. An exchange that is not a
      // public name — `localhost`, the older way of saying "no mail", or a
      // private name — is not somewhere mail from outside can be delivered.
      .filter((r) => r.host !== '' && isScannableHost(r.host))
      .sort((a, b) => a.priority - b.priority || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
      .map((r) => r.host)
    const unique = [...new Set(hosts)]
    return unique.length === 0 ? { ok: false, why: 'no_mail' } : { ok: true, via: 'mx', hosts: unique }
  } finally {
    done()
  }
}

/**
 * Whether a name resolves, and where to: `public` when it has addresses and
 * every one is public (`isPublicAddress`, the scanner's own judge), `private`
 * when any is not — loopback, a private network, link-local and the rest —
 * `none` when both A and AAAA are authoritatively absent, `unreachable` when
 * DNS could not say. A name `isScannableHost` refuses is `none`, asked of
 * nobody. It asks about the name as written: a site served only at
 * `www.<domain>` is a second question. Never throws.
 */
export async function domainResolves(domain: string, opts: DnsAnswerOptions = {}): Promise<DomainAnswer> {
  const name = nameOf(domain)
  if (name === null) return 'none'
  const { ask, done, budgetMs } = resolverFor(opts)
  try {
    const answer = await addressesOf(ask, name, Date.now() + budgetMs)
    if (answer.kind === 'absent') return 'none'
    if (answer.kind === 'failed') return 'unreachable'
    return answer.list.every((a) => isPublicAddress(a)) ? 'public' : 'private'
  } finally {
    done()
  }
}
