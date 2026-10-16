/**
 * The two DNS questions (`src/dns-answers.ts`, 2026-10-13): does a domain
 * receive mail, and does a name resolve to the public internet? Every branch
 * against a fake resolver — no query leaves this machine. The rule under
 * test is mail-dns.ts's: only NXDOMAIN and NODATA are answers of "no";
 * anything else is "could not tell".
 */
import { describe, expect, it } from 'vitest'
import { DNS_TIMEOUT_MS, domainResolves, mailHostsOf, type DnsResolverLike, type MxAnswer } from '../src/dns-answers.js'
import * as root from '../src/index.js'

type Answer<T> = T | { readonly code: string } | 'hang'

/** A resolver that answers from a table, and records every name it was asked about. */
function fake(table: {
  mx?: Answer<MxAnswer[]>
  a?: Answer<string[]>
  aaaa?: Answer<string[]>
}): DnsResolverLike & { asked: string[] } {
  const asked: string[] = []
  const answer = <T,>(kind: string, name: string, a: Answer<T> | undefined): Promise<T> => {
    asked.push(`${kind} ${name}`)
    if (a === undefined) return Promise.reject(Object.assign(new Error('queryX ENODATA'), { code: 'ENODATA' }))
    if (a === 'hang') return new Promise<T>(() => {})
    if (typeof a === 'object' && a !== null && 'code' in a) {
      return Promise.reject(Object.assign(new Error(`query ${a.code} ${name}`), { code: a.code }))
    }
    return Promise.resolve(a as T)
  }
  return {
    asked,
    resolveMx: (name) => answer('MX', name, table.mx),
    resolve4: (name) => answer('A', name, table.a),
    resolve6: (name) => answer('AAAA', name, table.aaaa),
  }
}

const NODATA = { code: 'ENODATA' }
const NXDOMAIN = { code: 'ENOTFOUND' }

describe('mailHostsOf', () => {
  it('lists the MX hosts, lowest priority first, each once and without its final dot', async () => {
    const resolver = fake({
      mx: [
        { exchange: 'alt2.ASPMX.l.google.com.', priority: 20 },
        { exchange: 'aspmx.l.google.com', priority: 1 },
        { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
        { exchange: 'aspmx.l.google.com', priority: 1 },
      ],
    })
    expect(await mailHostsOf('Farmley.com', { resolver })).toEqual({
      ok: true, via: 'mx', hosts: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com', 'alt2.aspmx.l.google.com'],
    })
    expect(resolver.asked).toEqual(['MX farmley.com'])
  })

  it('reads the null MX (RFC 7505) as a domain that takes no mail', async () => {
    // Node reads `MX 0 .` as an empty exchange.
    expect(await mailHostsOf('example.com', { resolver: fake({ mx: [{ exchange: '', priority: 0 }] }) }))
      .toEqual({ ok: false, why: 'no_mail' })
    expect(await mailHostsOf('example.com', { resolver: fake({ mx: [{ exchange: '.', priority: 0 }] }) }))
      .toEqual({ ok: false, why: 'no_mail' })
  })

  it('reads an empty answer, or exchanges that are not public names, as no mail', async () => {
    expect(await mailHostsOf('acme.in', { resolver: fake({ mx: [] }) })).toEqual({ ok: false, why: 'no_mail' })
    expect(await mailHostsOf('acme.in', { resolver: fake({ mx: [{ exchange: 'localhost', priority: 0 }] }) }))
      .toEqual({ ok: false, why: 'no_mail' })
    expect(await mailHostsOf('acme.in', { resolver: fake({ mx: [{ exchange: 'mail.acme.local', priority: 10 }] }) }))
      .toEqual({ ok: false, why: 'no_mail' })
  })

  it('keeps the real hosts when a null MX is mixed in', async () => {
    const resolver = fake({ mx: [{ exchange: '', priority: 0 }, { exchange: 'mx.acme.in', priority: 10 }] })
    expect(await mailHostsOf('acme.in', { resolver })).toEqual({ ok: true, via: 'mx', hosts: ['mx.acme.in'] })
  })

  it('says a domain that does not exist is no domain, asking nothing more', async () => {
    const resolver = fake({ mx: NXDOMAIN })
    expect(await mailHostsOf('127atelier-not-real.in', { resolver })).toEqual({ ok: false, why: 'no_domain' })
    expect(resolver.asked).toEqual(['MX 127atelier-not-real.in'])
    expect(await mailHostsOf('x.in', { resolver: fake({ mx: { code: 'NXDOMAIN' } }) })).toEqual({ ok: false, why: 'no_domain' })
  })

  it('falls back to the domain’s own address when it has no MX (RFC 5321 §5.1)', async () => {
    const resolver = fake({ mx: NODATA, a: ['93.184.215.14'], aaaa: NODATA })
    expect(await mailHostsOf('smallshop.in', { resolver })).toEqual({ ok: true, via: 'a', hosts: ['smallshop.in'] })
    expect(resolver.asked).toEqual(['MX smallshop.in', 'A smallshop.in', 'AAAA smallshop.in'])
    expect(await mailHostsOf('v6only.in', { resolver: fake({ mx: NODATA, a: NODATA, aaaa: ['2606:4700::1'] }) }))
      .toEqual({ ok: true, via: 'a', hosts: ['v6only.in'] })
  })

  it('reads no MX and no address — or only private ones — as no mail', async () => {
    expect(await mailHostsOf('parked.in', { resolver: fake({ mx: NODATA, a: NODATA, aaaa: NODATA }) }))
      .toEqual({ ok: false, why: 'no_mail' })
    expect(await mailHostsOf('parked.in', { resolver: fake({ mx: NODATA, a: [], aaaa: NXDOMAIN }) }))
      .toEqual({ ok: false, why: 'no_mail' })
    expect(await mailHostsOf('lan.in', { resolver: fake({ mx: NODATA, a: ['192.168.1.10'], aaaa: NODATA }) }))
      .toEqual({ ok: false, why: 'no_mail' })
  })

  it('never reads a resolver that could not answer as "no mail"', async () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'EBADRESP', 'ECANCELLED']) {
      expect(await mailHostsOf('acme.in', { resolver: fake({ mx: { code } }) }), code).toEqual({ ok: false, why: 'unreachable' })
    }
    // An error with no code, or a code that is not a resolver's.
    expect(await mailHostsOf('acme.in', { resolver: fake({ mx: { code: 'whatever' } }) })).toEqual({ ok: false, why: 'unreachable' })
    // The fallback could not tell either.
    expect(await mailHostsOf('acme.in', { resolver: fake({ mx: NODATA, a: { code: 'ETIMEOUT' }, aaaa: NODATA }) }))
      .toEqual({ ok: false, why: 'unreachable' })
  })

  it('stops waiting when the answer does not come', async () => {
    const started = Date.now()
    const answer = await mailHostsOf('acme.in', { resolver: fake({ mx: 'hang' }), timeoutMs: 20 })
    expect(answer).toEqual({ ok: false, why: 'unreachable' })
    expect(Date.now() - started).toBeLessThan(DNS_TIMEOUT_MS)
  })

  it('takes an address’s domain, an international name and a final dot as the same question', async () => {
    const resolver = fake({ mx: [{ exchange: 'mx.example.net', priority: 1 }] })
    await mailHostsOf('akash@farmley.com', { resolver })
    await mailHostsOf('bücher.de.', { resolver })
    await mailHostsOf('https://www.acme.in/contact', { resolver })
    expect(resolver.asked).toEqual(['MX farmley.com', 'MX xn--bcher-kva.de', 'MX www.acme.in'])
  })

  it('asks nothing about a name that is not public, and calls it no domain', async () => {
    const resolver = fake({ mx: [{ exchange: 'mx.example.net', priority: 1 }] })
    for (const name of ['localhost', 'box.local', 'db.internal', 'acme.invalid', 'x.test', '127.0.0.1', '10.1', '[::1]', '', 'nodot']) {
      expect(await mailHostsOf(name, { resolver }), name).toEqual({ ok: false, why: 'no_domain' })
    }
    expect(resolver.asked).toEqual([])
  })
})

describe('domainResolves', () => {
  it('is public when every address is', async () => {
    expect(await domainResolves('acme.in', { resolver: fake({ a: ['93.184.215.14'], aaaa: ['2606:4700::6810:84e5'] }) })).toBe('public')
    expect(await domainResolves('acme.in', { resolver: fake({ a: ['93.184.215.14'], aaaa: NODATA }) })).toBe('public')
  })

  it('is private when any address is not public — one is the shape a rebinding takes', async () => {
    for (const bad of [['127.0.0.1'], ['10.0.0.5'], ['93.184.215.14', '169.254.169.254'], ['192.168.0.1']]) {
      expect(await domainResolves('rebind.acme.in', { resolver: fake({ a: bad, aaaa: NODATA }) }), bad.join()).toBe('private')
    }
    expect(await domainResolves('acme.in', { resolver: fake({ a: ['93.184.215.14'], aaaa: ['::1'] }) })).toBe('private')
    expect(await domainResolves('acme.in', { resolver: fake({ a: NODATA, aaaa: ['fd00::1'] }) })).toBe('private')
  })

  it('is none only when DNS says so with authority', async () => {
    expect(await domainResolves('myrahspa-mumbai.co', { resolver: fake({ a: NXDOMAIN, aaaa: NXDOMAIN }) })).toBe('none')
    expect(await domainResolves('mailonly.in', { resolver: fake({ a: NODATA, aaaa: NODATA }) })).toBe('none')
    expect(await domainResolves('empty.in', { resolver: fake({ a: [], aaaa: [] }) })).toBe('none')
  })

  it('is unreachable when DNS could not say', async () => {
    expect(await domainResolves('acme.in', { resolver: fake({ a: { code: 'ESERVFAIL' }, aaaa: NODATA }) })).toBe('unreachable')
    expect(await domainResolves('acme.in', { resolver: fake({ a: { code: 'ETIMEOUT' }, aaaa: { code: 'ETIMEOUT' } }) })).toBe('unreachable')
    expect(await domainResolves('acme.in', { resolver: fake({ a: 'hang', aaaa: 'hang' }), timeoutMs: 20 })).toBe('unreachable')
  })

  it('judges the addresses it has when the other family could not be asked', async () => {
    expect(await domainResolves('acme.in', { resolver: fake({ a: ['93.184.215.14'], aaaa: { code: 'ETIMEOUT' } }) })).toBe('public')
  })

  it('asks about the name as written — www. kept — and nothing about a name that is not public', async () => {
    const resolver = fake({ a: ['93.184.215.14'], aaaa: NODATA })
    await domainResolves('www.acme.in', { resolver })
    expect(resolver.asked).toEqual(['A www.acme.in', 'AAAA www.acme.in'])
    resolver.asked.length = 0
    for (const name of ['localhost', 'acme.local', '169.254.169.254', 'shop.nosite.invalid', '0x7f.1']) {
      expect(await domainResolves(name, { resolver }), name).toBe('none')
    }
    expect(resolver.asked).toEqual([])
  })
})

describe('the package root', () => {
  it('exports both questions', () => {
    expect(typeof root.mailHostsOf).toBe('function')
    expect(typeof root.domainResolves).toBe('function')
  })
})
