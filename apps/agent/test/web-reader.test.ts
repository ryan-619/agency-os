/**
 * The worker's page reader (web/reader.ts, 2026-10-13) — its memory, not its
 * reading: the reading is the scanner's (`readPublicPage`), tested there.
 *
 * What matters here: a page asked for twice is one request; a failure that
 * says how the site was a moment ago is remembered only a moment; two callers
 * asking at once share one request; and a caller who stops waiting stops only
 * itself — the request ends only when nobody is waiting, and then nothing is
 * remembered from it. Every reader below is a fake: no test touches the network.
 */
import { describe, it, expect, vi } from 'vitest'
import type { DomainAnswer, MailHosts, PageRead } from '@agency/scanner'
import {
  DOMAIN_BRIEF_CACHE_MS, DOMAIN_CACHE_MS, PAGE_BRIEF_CACHE_MS, PAGE_CACHE_MAX, PAGE_CACHE_MS, webReader,
} from '../src/web/reader.js'

const page = (url: string, text = 'Acme Dental, Pune'): PageRead => ({
  ok: true, url, finalUrl: url, status: 200, title: 'Acme', text, html: `<p>${text}</p>`, truncated: false,
})

function clock(start = '2026-10-13T06:00:00Z') {
  let at = new Date(start).getTime()
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) }
}

/** A read that answers only when told to, recording the signal it was handed. */
function heldRead() {
  const calls: Array<{ url: string; signal: AbortSignal; answer: (p: PageRead) => void }> = []
  const read = (url: string, { signal }: { signal: AbortSignal }) =>
    new Promise<PageRead>((answer) => calls.push({ url, signal, answer }))
  return { read, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('pages', () => {
  it('reads a page once in ten minutes, and again after', async () => {
    const c = clock()
    const read = vi.fn(async (url: string) => page(url))
    const web = webReader({ read, now: c.now })
    await web.read('https://acme.in/contact')
    await web.read('HTTPS://ACME.in/contact')
    expect(read).toHaveBeenCalledTimes(1)
    c.advance(PAGE_CACHE_MS - 1)
    await web.read('https://acme.in/contact')
    expect(read).toHaveBeenCalledTimes(1)
    c.advance(2)
    await web.read('https://acme.in/contact')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('remembers a timeout, an unreachable site, a 5xx or a 429 for a minute only — and a 404 for ten', async () => {
    const c = clock()
    const answers: Record<string, PageRead> = {
      'https://slow.in/': { ok: false, url: 'https://slow.in/', why: 'timeout', detail: 'x' },
      'https://down.in/': { ok: false, url: 'https://down.in/', why: 'unreachable', detail: 'x' },
      'https://busy.in/': { ok: false, url: 'https://busy.in/', why: 'status', status: 503, detail: 'x' },
      'https://limited.in/': { ok: false, url: 'https://limited.in/', why: 'status', status: 429, detail: 'x' },
      'https://gone.in/': { ok: false, url: 'https://gone.in/', why: 'status', status: 404, detail: 'x' },
    }
    const read = vi.fn(async (url: string) => answers[url]!)
    const web = webReader({ read, now: c.now })
    for (const url of Object.keys(answers)) await web.read(url)
    c.advance(PAGE_BRIEF_CACHE_MS + 1)
    for (const url of Object.keys(answers)) await web.read(url)
    // Every brief one asked again; the 404 still remembered.
    expect(read.mock.calls.map(([u]) => u).filter((u) => u === 'https://gone.in/')).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(9)
  })

  it('shares one request between callers asking at once', async () => {
    const held = heldRead()
    const web = webReader({ read: held.read })
    const a = web.read('https://acme.in/')
    const b = web.read('https://acme.in/', new AbortController().signal)
    await tick()
    expect(held.calls).toHaveLength(1)
    held.calls[0]!.answer(page('https://acme.in/'))
    expect((await a).ok).toBe(true)
    expect(await b).toBe(await a)
  })

  it('ends only the waiting of a caller who gives up, while another still waits', async () => {
    const held = heldRead()
    const web = webReader({ read: held.read })
    const quitter = new AbortController()
    const gaveUp = web.read('https://acme.in/', quitter.signal)
    const stayed = web.read('https://acme.in/', new AbortController().signal)
    await tick()
    quitter.abort()
    expect(await gaveUp).toMatchObject({ ok: false, why: 'timeout' })
    expect(held.calls[0]!.signal.aborted).toBe(false)
    held.calls[0]!.answer(page('https://acme.in/'))
    expect((await stayed).ok).toBe(true)
  })

  it('stops the request once nobody waits, remembers nothing from it, and starts afresh for the next caller', async () => {
    const held = heldRead()
    const web = webReader({ read: held.read })
    const only = new AbortController()
    const gaveUp = web.read('https://acme.in/', only.signal)
    await tick()
    only.abort()
    expect(await gaveUp).toMatchObject({ ok: false, why: 'timeout' })
    expect(held.calls[0]!.signal.aborted).toBe(true)
    held.calls[0]!.answer({ ok: false, url: 'https://acme.in/', why: 'timeout', detail: 'stopped' })
    await tick()
    const next = web.read('https://acme.in/')
    await tick()
    expect(held.calls).toHaveLength(2)
    held.calls[1]!.answer(page('https://acme.in/'))
    expect((await next).ok).toBe(true)
  })

  it('keeps a request alive for a caller with no signal, whatever the others do', async () => {
    const held = heldRead()
    const web = webReader({ read: held.read })
    const patient = web.read('https://acme.in/')
    const quitter = new AbortController()
    void web.read('https://acme.in/', quitter.signal)
    await tick()
    quitter.abort()
    expect(held.calls[0]!.signal.aborted).toBe(false)
    held.calls[0]!.answer(page('https://acme.in/'))
    expect((await patient).ok).toBe(true)
  })

  it('answers a caller already stopped without asking anyone, and never names a password', async () => {
    const read = vi.fn(async (url: string) => page(url))
    const web = webReader({ read })
    const stopped = new AbortController()
    stopped.abort()
    const answer = await web.read('https://user:secret@acme.in/', stopped.signal)
    expect(answer).toMatchObject({ ok: false, why: 'timeout' })
    expect(JSON.stringify(answer)).not.toContain('secret')
    expect(read).not.toHaveBeenCalled()
  })

  it('answers a reader that throws as a page it could not read, in its own words, and asks again soon', async () => {
    const c = clock()
    const read = vi.fn(async (): Promise<PageRead> => {
      throw new Error('ECONNRESET from 10.0.0.5 with token=abc')
    })
    const web = webReader({ read, now: c.now })
    const answer = await web.read('https://acme.in/')
    expect(answer).toEqual({ ok: false, url: 'https://acme.in/', why: 'unreachable', detail: 'The page could not be read.' })
    c.advance(PAGE_BRIEF_CACHE_MS + 1)
    await web.read('https://acme.in/')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('remembers at most 200 pages, dropping the oldest', async () => {
    const read = vi.fn(async (url: string) => page(url))
    const web = webReader({ read })
    for (let i = 0; i <= PAGE_CACHE_MAX; i++) await web.read(`https://acme.in/p${i}`)
    await web.read(`https://acme.in/p${PAGE_CACHE_MAX}`)
    expect(read).toHaveBeenCalledTimes(PAGE_CACHE_MAX + 1)
    await web.read('https://acme.in/p0')
    expect(read).toHaveBeenCalledTimes(PAGE_CACHE_MAX + 2)
  })
})

describe('domains', () => {
  it('asks whether a domain receives mail once in thirty minutes, sharing a question in flight', async () => {
    const c = clock()
    const mailHosts = vi.fn(async (): Promise<MailHosts> => ({ ok: true, via: 'mx', hosts: ['mx.acme.in'] }))
    const web = webReader({ mailHosts, now: c.now })
    await Promise.all([web.mailHosts('acme.in'), web.mailHosts('ACME.in.')])
    await web.mailHosts('acme.in')
    expect(mailHosts).toHaveBeenCalledTimes(1)
    expect(mailHosts).toHaveBeenCalledWith('acme.in')
    c.advance(DOMAIN_CACHE_MS + 1)
    await web.mailHosts('acme.in')
    expect(mailHosts).toHaveBeenCalledTimes(2)
  })

  it('remembers a DNS answer nobody could give for a minute only, and a throw not at all', async () => {
    const c = clock()
    const resolves = vi.fn(async (): Promise<DomainAnswer> => 'unreachable')
    const mailHosts = vi.fn(async (): Promise<MailHosts> => {
      throw new Error('boom')
    })
    const web = webReader({ resolves, mailHosts, now: c.now })
    expect(await web.resolves('acme.in')).toBe('unreachable')
    expect(await web.mailHosts('acme.in')).toEqual({ ok: false, why: 'unreachable' })
    await web.mailHosts('acme.in')
    expect(mailHosts).toHaveBeenCalledTimes(2)
    await web.resolves('acme.in')
    expect(resolves).toHaveBeenCalledTimes(1)
    c.advance(DOMAIN_BRIEF_CACHE_MS + 1)
    await web.resolves('acme.in')
    expect(resolves).toHaveBeenCalledTimes(2)
  })

  it('remembers "no such domain" and "public" the full thirty minutes', async () => {
    const c = clock()
    const resolves = vi.fn(async (d: string): Promise<DomainAnswer> => (d === 'acme.in' ? 'public' : 'none'))
    const web = webReader({ resolves, now: c.now })
    await web.resolves('acme.in')
    await web.resolves('nosuch.in')
    c.advance(DOMAIN_CACHE_MS - 1)
    await web.resolves('acme.in')
    await web.resolves('nosuch.in')
    expect(resolves).toHaveBeenCalledTimes(2)
  })
})
