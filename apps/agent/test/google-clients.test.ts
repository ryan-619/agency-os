/**
 * The Google clients (2026-10-08), against a fetch that records and never
 * reaches Google: the request each sends, how each reads an answer, and that
 * the key appears in no message.
 */
import { describe, expect, it } from 'vitest'
import { GoogleApiError, PLACES_ENDPOINT, PLACES_FIELD_MASK, placeFrom, placesClient } from '../src/google/places.js'
import { PAGESPEED_ENDPOINT, auditFrom, lighthouseCode, pageSpeedClient } from '../src/google/pagespeed.js'

const KEY = 'AIzaSyDUMMY-KEY-0123456789abcdefghijklm'

function recordingFetch(answer: { status: number; body: unknown } | 'throw') {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (answer === 'throw') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { f, calls }
}

describe('Google Maps search', () => {
  const place = {
    id: 'ChIJkumar', displayName: { text: 'Kumar Dental Clinic' }, formattedAddress: '12 CMH Road, Bengaluru',
    internationalPhoneNumber: '+91 80 4123 4567', rating: 4.6, userRatingCount: 12, businessStatus: 'OPERATIONAL',
    primaryType: 'dentist', googleMapsUri: 'https://maps.google.com/?cid=1',
    location: { latitude: 12.9784, longitude: 77.6408 },
  }

  it('sends the documented request: key and field mask in headers, never following a redirect', async () => {
    const { f, calls } = recordingFetch({ status: 200, body: { places: [place], nextPageToken: 'NEXT' } })
    const client = placesClient({ apiKey: KEY, dailyLimit: 30, fetch: f })
    const r = await client.search({ query: 'dentists in Indiranagar', regionCode: 'IN' })
    expect(calls[0]!.url).toBe(PLACES_ENDPOINT)
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(calls[0]!.init.headers).toMatchObject({ 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': PLACES_FIELD_MASK })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ textQuery: 'dentists in Indiranagar', pageSize: 20, languageCode: 'en', regionCode: 'IN' })
    expect(r).toEqual({
      places: [{
        placeId: 'ChIJkumar', name: 'Kumar Dental Clinic', address: '12 CMH Road, Bengaluru', phone: '+91 80 4123 4567',
        website: null, rating: 4.6, reviews: 12, category: 'dentist', mapsUrl: 'https://maps.google.com/?cid=1', status: 'operational',
        location: { lat: 12.9784, lng: 77.6408 },
      }],
      nextPageToken: 'NEXT',
    })
  })

  it('drops a place with no id or name, and an impossible rating', () => {
    expect(placeFrom({ displayName: { text: 'No id' } })).toBeNull()
    expect(placeFrom({ id: 'x' })).toBeNull()
    expect(placeFrom({ ...place, rating: 9 })?.rating).toBeNull()
  })

  it('reads where a place is (0023) only as a pair on earth, and asks for it in the mask', () => {
    expect(PLACES_FIELD_MASK.split(',')).toContain('places.location')
    expect(placeFrom({ ...place, location: { latitude: 0, longitude: 0 } })?.location).toEqual({ lat: 0, lng: 0 })
    expect(placeFrom({ ...place, location: undefined })?.location).toBeNull()
    expect(placeFrom({ ...place, location: { latitude: 12.9 } })?.location).toBeNull()
    expect(placeFrom({ ...place, location: { latitude: 91, longitude: 77 } })?.location).toBeNull()
    expect(placeFrom({ ...place, location: { latitude: '12.9', longitude: '77.6' } })?.location).toBeNull()
  })

  it('says Google’s status word and what to do — never the key or what Google said', async () => {
    const { f } = recordingFetch({
      status: 403,
      body: { error: { status: 'PERMISSION_DENIED', message: `Places API (New) has not been used … key ${KEY}` } },
    })
    const err = await placesClient({ apiKey: KEY, dailyLimit: 30, fetch: f }).search({ query: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as Error).message).toMatch(/403 PERMISSION_DENIED: the key may not use the Places API \(New\)/)
    expect((err as Error).message).not.toContain(KEY)
    expect((err as Error).message).not.toContain('has not been used')
  })

  it('reports a network failure as not answering', async () => {
    const { f } = recordingFetch('throw')
    await expect(placesClient({ apiKey: KEY, dailyLimit: 30, fetch: f }).search({ query: 'x' })).rejects.toThrow('Google Maps did not answer in time')
  })
})

describe('PageSpeed', () => {
  const lighthouse = {
    lighthouseResult: {
      categories: { performance: { score: 0.31 }, accessibility: { score: 0.95 }, 'best-practices': { score: 0.78 }, seo: { score: 0.72 } },
      audits: {
        'largest-contentful-paint': { numericValue: 6123.4 }, 'cumulative-layout-shift': { numericValue: 0.1234 },
        'total-blocking-time': { numericValue: 840 }, 'first-contentful-paint': { numericValue: 2950 },
      },
    },
    loadingExperience: { overall_category: 'SLOW' },
  }

  it('asks for every category, as a phone, with the key in the query — and reads the scores', async () => {
    const { f, calls } = recordingFetch({ status: 200, body: lighthouse })
    const r = await pageSpeedClient({ apiKey: KEY, fetch: f }).run({ url: 'https://kumardental.in/', strategy: 'mobile' })
    const url = new URL(calls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe(PAGESPEED_ENDPOINT)
    expect(url.searchParams.get('strategy')).toBe('MOBILE')
    expect(url.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'])
    expect(url.searchParams.get('key')).toBe(KEY)
    expect(calls[0]!.init.redirect).toBe('error')
    expect(r).toEqual({
      ok: true, error: null, performance: 31, accessibility: 95, bestPractices: 78, seo: 72,
      lcpMs: 6123.4, cls: 0.123, tbtMs: 840, fcpMs: 2950, fieldCategory: 'SLOW',
    })
  })

  it('runs keyless, sending no key at all', async () => {
    const { f, calls } = recordingFetch({ status: 200, body: lighthouse })
    await pageSpeedClient({ apiKey: null, fetch: f }).run({ url: 'https://kumardental.in/', strategy: 'desktop' })
    expect(new URL(calls[0]!.url).searchParams.has('key')).toBe(false)
    expect(new URL(calls[0]!.url).searchParams.get('strategy')).toBe('DESKTOP')
  })

  it('reads a page Lighthouse could not load as a failed RESULT with no score — not a slow site', async () => {
    const { f } = recordingFetch({
      status: 400,
      body: { error: { status: 'INVALID_ARGUMENT', message: 'Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable …' } },
    })
    const r = await pageSpeedClient({ apiKey: KEY, fetch: f }).run({ url: 'https://down.example/', strategy: 'mobile' })
    expect(r).toMatchObject({ ok: false, error: 'Lighthouse could not load the page (FAILED_DOCUMENT_REQUEST)', performance: null })
    expect(auditFrom({ lighthouseResult: { runtimeError: { code: 'NO_FCP' } } })).toMatchObject({ ok: false, error: expect.stringMatching(/NO_FCP/) })
    expect(lighthouseCode('no code here')).toBeNull()
  })

  it('throws when the SERVICE fails — quota, a refused key — never with the key in the message', async () => {
    const quota = recordingFetch({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } })
    const e1 = await pageSpeedClient({ apiKey: null, fetch: quota.f }).run({ url: 'https://x.in/', strategy: 'mobile' }).catch((e: unknown) => e)
    expect((e1 as Error).message).toMatch(/shared quota is used up/)
    const refused = recordingFetch({ status: 403, body: { error: { status: 'PERMISSION_DENIED', message: KEY } } })
    const e2 = await pageSpeedClient({ apiKey: KEY, fetch: refused.f }).run({ url: 'https://x.in/', strategy: 'mobile' }).catch((e: unknown) => e)
    expect((e2 as Error).message).toMatch(/enable the PageSpeed Insights API/)
    expect((e2 as Error).message).not.toContain(KEY)
  })
})
