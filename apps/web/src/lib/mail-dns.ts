/**
 * The agency's OWN sending domain, as DNS describes it: SPF, DMARC and DKIM
 * for the domain in `MAIL_FROM` (/settings/mail).
 *
 * Not a prospect's domain, and never a domain a request names. The only name
 * resolved is built from `MAIL_FROM`, which is configuration; the one piece
 * of user input is a DKIM selector, which must be a single DNS label
 * (`isDkimSelector`) before it is put in front of `._domainkey.`. Lookups are
 * TXT only.
 *
 * §2.2 applies to our own records exactly as it applies to a prospect's
 * headers. A lookup that FAILED — SERVFAIL, a timeout, a refused query — is
 * not an observation, so it is "could not be checked" and never "missing".
 * Only an authoritative "no such record" (NODATA, NXDOMAIN) is missing. And
 * DKIM selectors cannot be enumerated from DNS, so "missing" there means "not
 * at the selectors tried", and the sentence says which ones.
 *
 * Pure: no `server-only`, no `@/` import, and no DNS either — the resolver is
 * an argument, so the route passes `node:dns` and a test passes a fake. Every
 * rule about what an answer MEANS lives here and is tested; the route is the
 * lookup and nothing else.
 */

/** Tried when no selector is named: the providers this product is deployed with, and the common defaults. */
export const DKIM_DEFAULT_SELECTORS: readonly string[] = ['resend', 'google', 'default', 'selector1', 'selector2']

/** One DNS label: letters, digits and inner hyphens, 1–63 characters. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

/**
 * Is this a DKIM selector we are willing to resolve? A single DNS label and
 * nothing else — no dots, so `?dkim=` cannot walk the name somewhere other
 * than `<selector>._domainkey.<our domain>`.
 */
export function isDkimSelector(s: string): boolean {
  return DNS_LABEL.test(s)
}

/** Names that never have public DNS worth asking about (RFC 2606, 6761, 6762; `.internal`). */
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|test|example|invalid|lan|home\.arpa)$/i

export type MailFromDomain =
  | { readonly domain: string }
  | { readonly domain: null; readonly reason: 'no_address' | 'local' }

/**
 * The domain of the address in `MAIL_FROM` — `Agency OS <hello@agency.com>`
 * or a bare `hello@agency.com`. Null, with the reason, when there is no
 * address or it is a development one (the default is `@localhost`).
 */
export function mailFromDomain(mailFrom: string): MailFromDomain {
  const angle = /<([^<>]*)>\s*$/.exec(mailFrom)
  const address = (angle ? angle[1]! : mailFrom).trim()
  const at = address.lastIndexOf('@')
  if (at < 1) return { domain: null, reason: 'no_address' }
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) {
    // One label (`localhost`) is a development address; anything else that
    // is not a DNS name is not an address we can check.
    return labels.length === 1 && DNS_LABEL.test(domain)
      ? { domain: null, reason: 'local' }
      : { domain: null, reason: 'no_address' }
  }
  // An all-numeric last label is an IP literal, not a domain.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return { domain: null, reason: 'no_address' }
  if (LOCAL_SUFFIX.test(domain)) return { domain: null, reason: 'local' }
  return { domain }
}

// ---------------------------------------------------------------------------
// One lookup's answer
// ---------------------------------------------------------------------------

/**
 * TXT records as a resolver returns them: each record is a list of chunks of
 * at most 255 bytes, which RFC 7208 §3.3 says are joined with NOTHING between
 * them — a long SPF record split mid-mechanism is one record.
 */
export type TxtRecords = readonly (readonly string[])[]

export type TxtAnswer =
  /** The records, each already joined from its chunks. */
  | { readonly kind: 'records'; readonly records: readonly string[] }
  /** An authoritative "no such record": NODATA or NXDOMAIN. An observation. */
  | { readonly kind: 'absent' }
  /** The lookup failed. NOT an observation; `code` is the resolver's error name. */
  | { readonly kind: 'unchecked'; readonly code: string }

/** The two codes that are answers. Everything else a resolver can say is a failure to answer. */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENODATA', 'ENOTFOUND'])

export function txtAnswerFromRecords(records: TxtRecords): TxtAnswer {
  if (records.length === 0) return { kind: 'absent' }
  return { kind: 'records', records: records.map((chunks) => chunks.join('')) }
}

/**
 * What a resolver's error means. Only NODATA and NXDOMAIN are "absent";
 * SERVFAIL, a timeout, a refusal, a malformed reply or an error with no code
 * at all are "could not be checked". The code is reported only when it looks
 * like a resolver's (`ESERVFAIL`), so nothing else an error carries reaches
 * the page.
 */
export function txtAnswerFromError(err: unknown): TxtAnswer {
  const raw = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null
  const code = typeof raw === 'string' && /^E[A-Z_]{2,31}$/.test(raw) ? raw : 'EUNKNOWN'
  return ABSENT_CODES.has(code) ? { kind: 'absent' } : { kind: 'unchecked', code }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type SpfAll = '-all' | '~all' | '?all' | '+all'

export interface SpfParse {
  /** Every record that declares itself SPF (`v=spf1`). More than one is a permanent error. */
  readonly records: readonly string[]
  /** The `all` mechanism of the first record, or null when it has none. */
  readonly all: SpfAll | null
  /** A `redirect=` target, when the policy lives in another domain's record. */
  readonly redirect: string | null
}

const SPF_VERSION = /^v=spf1(\s|$)/i

/** The SPF records among a name's TXT records, and the first one's `all`. */
export function parseSpf(txt: readonly string[]): SpfParse {
  const records = txt.map((t) => t.trim()).filter((t) => SPF_VERSION.test(t))
  const first = records[0]
  if (first === undefined) return { records, all: null, redirect: null }
  const terms = first.split(/\s+/).slice(1)
  let all: SpfAll | null = null
  let redirect: string | null = null
  for (const term of terms) {
    const t = term.toLowerCase()
    const m = /^([-~?+]?)all$/.exec(t)
    if (m) {
      all = `${m[1] || '+'}all` as SpfAll
      continue
    }
    if (t.startsWith('redirect=')) redirect = term.slice('redirect='.length)
  }
  return { records, all, redirect }
}

export type DmarcPolicy = 'none' | 'quarantine' | 'reject'

export interface DmarcParse {
  /** Every record whose first tag is `v=DMARC1`. More than one and receivers apply none (RFC 7489 §6.6.3). */
  readonly records: readonly string[]
  /** The first record's `p=`, or null when it is absent or not one of the three. */
  readonly policy: DmarcPolicy | null
  /** `pct=`, 100 when absent. */
  readonly pct: number
  /** Whether aggregate reports are asked for (`rua=`). */
  readonly reports: boolean
}

/** A record's tags, `;`-separated, whitespace around names and `=` ignored, names lower-cased. */
function tags(record: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of record.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    if (name && !out.has(name)) out.set(name, part.slice(eq + 1).trim())
  }
  return out
}

function isDmarcRecord(record: string): boolean {
  const first = record.split(';')[0] ?? ''
  const eq = first.indexOf('=')
  return eq > 0 && first.slice(0, eq).trim().toLowerCase() === 'v' && first.slice(eq + 1).trim().toUpperCase() === 'DMARC1'
}

/** The DMARC records among `_dmarc.<domain>`'s TXT records, and the first one's policy. */
export function parseDmarc(txt: readonly string[]): DmarcParse {
  const records = txt.map((t) => t.trim()).filter(isDmarcRecord)
  const first = records[0]
  if (first === undefined) return { records, policy: null, pct: 100, reports: false }
  const t = tags(first)
  const p = t.get('p')?.toLowerCase()
  const policy = p === 'none' || p === 'quarantine' || p === 'reject' ? p : null
  const pctRaw = t.get('pct')
  const pct = pctRaw !== undefined && /^\d{1,3}$/.test(pctRaw) ? Math.min(100, Number(pctRaw)) : 100
  return { records, policy, pct, reports: Boolean(t.get('rua')) }
}

export type DkimKeyState = 'found' | 'rsa1024' | 'short' | 'revoked' | 'none'

/**
 * One selector's TXT records, read as a DKIM key record. `found` is a
 * published key of 2048 bits or more (or not RSA); `rsa1024` an RSA key of at
 * least 1024 bits and under 2048 — RFC 8301's minimum, and what Resend and
 * Google Workspace publish by default; `short` an RSA key under 1024 bits,
 * whose signatures RFC 8301 tells receivers to ignore; `revoked` a record
 * with an empty `p=` (RFC 6376 §3.6.1's way of withdrawing a key); `none` is
 * TXT at that name that is not a key record at all.
 */
export function parseDkim(txt: readonly string[]): DkimKeyState {
  const rank: Record<DkimKeyState, number> = { none: 0, revoked: 1, short: 2, rsa1024: 3, found: 4 }
  let state: DkimKeyState = 'none'
  const keep = (next: DkimKeyState) => {
    if (rank[next] > rank[state]) state = next
  }
  for (const record of txt) {
    const t = tags(record)
    if (!t.has('p')) continue
    const key = (t.get('p') ?? '').replace(/\s+/g, '')
    if (key === '') {
      keep('revoked')
      continue
    }
    const k = (t.get('k') ?? 'rsa').toLowerCase()
    if (k !== 'rsa') {
      keep('found')
      continue
    }
    // The key is base64 DER (SubjectPublicKeyInfo), whose size follows the
    // modulus: 162 bytes for 1024 bits, 294 for 2048. The byte count alone
    // says which side of each line a key falls — measured from what is
    // published, not guessed.
    const bytes = Math.floor((key.length * 3) / 4) - (key.endsWith('==') ? 2 : key.endsWith('=') ? 1 : 0)
    keep(bytes < 150 ? 'short' : bytes < 280 ? 'rsa1024' : 'found')
  }
  return state
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export type MailDnsVerdict = 'pass' | 'weak' | 'missing' | 'unchecked'

/** How each verdict is written on the page. "Could not be checked" is not a softer "missing". */
export const MAIL_DNS_VERDICT_WORDS: Readonly<Record<MailDnsVerdict, string>> = {
  pass: 'pass',
  weak: 'weak',
  missing: 'missing',
  unchecked: 'could not be checked',
}

export interface MailDnsRecordAssessment {
  readonly verdict: MailDnsVerdict
  /** The record the verdict is about, as published — or null when there is none to show. */
  readonly record: string | null
  /** One sentence: why this verdict. */
  readonly detail: string
}

export interface DkimSelectorResult {
  readonly selector: string
  /** `absent` and `unchecked` are the lookup's; the rest are `parseDkim`'s reading of what came back. */
  readonly state: DkimKeyState | 'absent' | 'unchecked'
  /** The resolver's error name, when the lookup failed. */
  readonly code?: string
}

export interface MailDnsAssessment {
  readonly spf: MailDnsRecordAssessment
  readonly dmarc: MailDnsRecordAssessment
  readonly dkim: MailDnsRecordAssessment & { readonly selectors: readonly DkimSelectorResult[] }
}

function unchecked(what: string, code: string): MailDnsRecordAssessment {
  return {
    verdict: 'unchecked',
    record: null,
    detail: `The ${what} lookup failed (${code}), so nothing was observed either way. Try again; if it persists, check the domain's nameservers.`,
  }
}

function assessSpf(answer: TxtAnswer): MailDnsRecordAssessment {
  if (answer.kind === 'unchecked') return unchecked('SPF', answer.code)
  const spf = parseSpf(answer.kind === 'records' ? answer.records : [])
  const record = spf.records[0] ?? null
  if (record === null) {
    return { verdict: 'missing', record: null, detail: 'No v=spf1 record is published, so receivers cannot tell which servers may send as this domain.' }
  }
  if (spf.records.length > 1) {
    return { verdict: 'weak', record, detail: `${spf.records.length} SPF records are published. RFC 7208 makes that a permanent error: receivers treat the domain as having no valid SPF.` }
  }
  if (spf.all === '-all') {
    return { verdict: 'pass', record, detail: 'Published, ending -all: mail from any server not listed fails SPF.' }
  }
  if (spf.all === '~all') {
    return { verdict: 'pass', record, detail: 'Published, ending ~all: mail from any server not listed soft-fails, and DMARC decides what happens to it.' }
  }
  if (spf.all === '+all') {
    return { verdict: 'weak', record, detail: 'Published, ending +all — which authorises every server on the internet to send as this domain.' }
  }
  if (spf.all === '?all') {
    return { verdict: 'weak', record, detail: 'Published, ending ?all (neutral): it says nothing about servers not listed.' }
  }
  if (spf.redirect !== null) {
    return { verdict: 'unchecked', record, detail: `Published, delegating its policy with redirect=${spf.redirect}. This page does not follow the redirect, so the policy that applies was not observed.` }
  }
  return { verdict: 'weak', record, detail: 'Published with no all mechanism, so mail from servers not listed is neutral rather than failing.' }
}

function assessDmarc(answer: TxtAnswer): MailDnsRecordAssessment {
  if (answer.kind === 'unchecked') return unchecked('DMARC', answer.code)
  const dmarc = parseDmarc(answer.kind === 'records' ? answer.records : [])
  const record = dmarc.records[0] ?? null
  if (record === null) {
    return { verdict: 'missing', record: null, detail: 'No v=DMARC1 record at _dmarc, so receivers apply no policy to mail that fails SPF and DKIM.' }
  }
  if (dmarc.records.length > 1) {
    return { verdict: 'weak', record, detail: `${dmarc.records.length} DMARC records are published. RFC 7489 says receivers then apply none of them.` }
  }
  if (dmarc.policy === null) {
    return { verdict: 'weak', record, detail: 'Published without a valid p= (none, quarantine or reject), so receivers ignore it.' }
  }
  if (dmarc.policy === 'none') {
    return { verdict: 'weak', record, detail: `p=none: monitoring only${dmarc.reports ? ', with reports' : ', and no rua= to send reports to'}. Mail that fails is still delivered.` }
  }
  if (dmarc.pct < 100) {
    return { verdict: 'weak', record, detail: `p=${dmarc.policy}, but pct=${dmarc.pct}: the policy applies to ${dmarc.pct}% of failing mail.` }
  }
  return { verdict: 'pass', record, detail: `p=${dmarc.policy}: mail that fails SPF and DKIM alignment is ${dmarc.policy === 'reject' ? 'refused' : 'sent to spam'}.` }
}

function assessDkim(results: readonly { readonly selector: string; readonly answer: TxtAnswer }[]): MailDnsAssessment['dkim'] {
  const selectors: DkimSelectorResult[] = results.map(({ selector, answer }) =>
    answer.kind === 'unchecked'
      ? { selector, state: 'unchecked', code: answer.code }
      : answer.kind === 'absent'
        ? { selector, state: 'absent' }
        : { selector, state: parseDkim(answer.records) },
  )
  const named = (s: DkimKeyState | 'absent' | 'unchecked') =>
    selectors.filter((r) => r.state === s).map((r) => r.selector)
  const tried = selectors.map((r) => r.selector).join(', ')

  const found = named('found')
  if (found.length > 0) {
    return { verdict: 'pass', record: null, selectors, detail: `A published key at ${found.join(', ')}.` }
  }
  const rsa1024 = named('rsa1024')
  if (rsa1024.length > 0) {
    return {
      verdict: 'pass',
      record: null,
      selectors,
      detail: `A published 1024-bit RSA key at ${rsa1024.join(', ')}. That meets RFC 8301's minimum and is what several providers publish by default; 2048 bits is the recommendation.`,
    }
  }
  const short = named('short')
  if (short.length > 0) {
    return {
      verdict: 'weak',
      record: null,
      selectors,
      detail: `The key at ${short.join(', ')} is RSA shorter than 1024 bits, and RFC 8301 tells receivers to ignore signatures made with it.`,
    }
  }
  const failed = named('unchecked')
  if (failed.length > 0) {
    // A selector we could not read may be the one with the key, so "missing"
    // would be a claim about a lookup that never answered.
    const answered = selectors.filter((r) => r.state !== 'unchecked').map((r) => r.selector)
    const codes = selectors.filter((r) => r.state === 'unchecked').map((r) => `${r.selector}: ${r.code ?? 'EUNKNOWN'}`)
    return {
      verdict: 'unchecked',
      record: null,
      selectors,
      detail:
        answered.length === 0
          ? `The DKIM lookup failed at every selector tried (${codes.join(', ')}), so nothing was observed either way.`
          : `The lookup failed at ${failed.join(', ')} (${codes.join(', ')}) and found no key at ${answered.join(', ')} — so whether a key is published is not known.`,
    }
  }
  const revoked = named('revoked')
  return {
    verdict: 'missing',
    record: null,
    selectors,
    detail:
      `No key at the selectors tried (${tried})${revoked.length > 0 ? `; ${revoked.join(', ')} publishes a revoked key` : ''}. ` +
      'Selectors cannot be listed from DNS, so a key at another selector is not ruled out — name it to check it.',
  }
}

/** The three answers, as verdicts with a sentence each. */
export function assessMailDns(input: {
  readonly spf: TxtAnswer
  readonly dmarc: TxtAnswer
  readonly dkim: readonly { readonly selector: string; readonly answer: TxtAnswer }[]
}): MailDnsAssessment {
  return { spf: assessSpf(input.spf), dmarc: assessDmarc(input.dmarc), dkim: assessDkim(input.dkim) }
}

// ---------------------------------------------------------------------------
// The lookup, with the resolver injected
// ---------------------------------------------------------------------------

/** `node:dns/promises`'s `resolveTxt`, or a test's fake. */
export type ResolveTxt = (name: string) => Promise<string[][]>

async function txt(resolve: ResolveTxt, name: string): Promise<TxtAnswer> {
  try {
    return txtAnswerFromRecords(await resolve(name))
  } catch (err) {
    return txtAnswerFromError(err)
  }
}

export interface MailDnsReport extends MailDnsAssessment {
  readonly domain: string
}

/**
 * Every lookup for one domain, in parallel, each failing on its own: one
 * SERVFAIL makes THAT record "could not be checked" and leaves the others'
 * answers standing. Throws only for a selector that is not a DNS label, which
 * the route has already refused — a second check at the point the name is
 * built, because this is the function that builds it.
 */
export async function lookupMailDns(
  domain: string,
  selectors: readonly string[],
  resolve: ResolveTxt,
): Promise<MailDnsReport> {
  for (const s of selectors) {
    if (!isDkimSelector(s)) throw new Error('A DKIM selector must be a single DNS label.')
  }
  const [spf, dmarc, ...dkim] = await Promise.all([
    txt(resolve, domain),
    txt(resolve, `_dmarc.${domain}`),
    ...selectors.map((s) => txt(resolve, `${s.toLowerCase()}._domainkey.${domain}`)),
  ])
  return {
    domain,
    ...assessMailDns({
      spf: spf!,
      dmarc: dmarc!,
      dkim: selectors.map((s, i) => ({ selector: s.toLowerCase(), answer: dkim[i]! })),
    }),
  }
}
