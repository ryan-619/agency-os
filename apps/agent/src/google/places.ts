/**
 * Google Maps search, for `find_businesses` (2026-10-08).
 *
 * Places API (New) Text Search, as Google documents it
 * (https://developers.google.com/maps/documentation/places/web-service/text-search):
 * `POST https://places.googleapis.com/v1/places:searchText` with the key in
 * `X-Goog-Api-Key`, the fields wanted in `X-Goog-FieldMask`, and
 * `{ textQuery, pageSize, pageToken?, regionCode?, languageCode }` as the
 * body; up to 20 places a page and 60 a search.
 *
 * The field mask decides the price. A phone, a website and a rating put a
 * search in the "Text Search Enterprise" tier — about $35 per 1,000 searches
 * past 1,000 free a month, read from Google's pricing on 2026-10-08 — which is
 * why `PLACES_DAILY_SEARCHES` caps them per org per day.
 *
 * The key lives in this closure and one request header, never in a message,
 * a property or a log; `redirect: 'error'`, because a redirect would carry the
 * header wherever it pointed. An error says Google's status word
 * (`PERMISSION_DENIED`, …) and what to do, never what Google said back.
 * One attempt; a person searches again.
 */
import type { PlaceListing, PlacesClient } from '@agency/tools'

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

export const PLACES_FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.internationalPhoneNumber',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.businessStatus', 'places.primaryType', 'places.googleMapsUri', 'nextPageToken',
].join(',')

export const PLACES_TIMEOUT_MS = 15_000

/** Google's own answer, by status word: what is wrong, and what fixes it. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  PERMISSION_DENIED:
    'the key may not use the Places API (New) — enable it on the key’s Google Cloud project and check the key’s ' +
    'restrictions and billing',
  RESOURCE_EXHAUSTED: 'the Places quota is used up for now',
  INVALID_ARGUMENT: 'Google refused the search as malformed',
  UNAUTHENTICATED: 'the key was not accepted',
}

export class GoogleApiError extends Error {
  constructor(
    readonly service: 'places' | 'pagespeed',
    readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

/** Google's status word from an error body — a fixed vocabulary, never free text. */
export function googleStatusWord(body: unknown): string | null {
  const status = (body as { error?: { status?: unknown } } | null)?.error?.status
  return typeof status === 'string' && /^[A-Z_]{3,40}$/.test(status) ? status : null
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const STATUSES: Readonly<Record<string, PlaceListing['status']>> = {
  OPERATIONAL: 'operational',
  CLOSED_TEMPORARILY: 'closed_temporarily',
  CLOSED_PERMANENTLY: 'closed_permanently',
}

/** One place, read defensively: anything without an id and a name is dropped. */
export function placeFrom(raw: unknown): PlaceListing | null {
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const placeId = str(p.id, 300)
  const name = str((p.displayName as { text?: unknown } | undefined)?.text, 200)
  if (!placeId || !name) return null
  const rating = num(p.rating)
  const reviews = num(p.userRatingCount)
  return {
    placeId,
    name,
    address: str(p.formattedAddress, 300),
    phone: str(p.internationalPhoneNumber, 40) ?? str(p.nationalPhoneNumber, 40),
    website: str(p.websiteUri, 500),
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    reviews: reviews !== null && reviews >= 0 ? Math.round(reviews) : null,
    category: str(p.primaryType, 80),
    mapsUrl: str(p.googleMapsUri, 500),
    status: typeof p.businessStatus === 'string' ? STATUSES[p.businessStatus] ?? null : null,
  }
}

export function placesClient(config: {
  readonly apiKey: string
  readonly dailyLimit: number
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}): PlacesClient {
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? PLACES_TIMEOUT_MS
  const apiKey = config.apiKey
  return {
    dailyLimit: config.dailyLimit,
    async search(args, signal) {
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
      let res: Response
      try {
        res = await doFetch(PLACES_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': PLACES_FIELD_MASK,
          },
          body: JSON.stringify({
            textQuery: args.query,
            pageSize: 20,
            languageCode: 'en',
            ...(args.regionCode ? { regionCode: args.regionCode } : {}),
            ...(args.pageToken ? { pageToken: args.pageToken } : {}),
          }),
          redirect: 'error',
          signal: AbortSignal.any(signals),
        })
      } catch {
        throw new GoogleApiError('places', null, 'Google Maps did not answer in time')
      }
      const body = (await res.json().catch(() => null)) as unknown
      if (!res.ok) {
        const word = googleStatusWord(body)
        throw new GoogleApiError(
          'places',
          res.status,
          `Google Maps answered ${res.status}${word ? ` ${word}` : ''}${word && STATUS_WORDS[word] ? `: ${STATUS_WORDS[word]}` : ''}`,
        )
      }
      const o = (body ?? {}) as { places?: unknown; nextPageToken?: unknown }
      const places = Array.isArray(o.places) ? o.places.map(placeFrom).filter((p): p is PlaceListing => p !== null) : []
      return { places, nextPageToken: str(o.nextPageToken, 1000) }
    },
  }
}
