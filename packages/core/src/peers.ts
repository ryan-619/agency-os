/**
 * A business beside its nearest competitors (2026-10-08): the comparison on
 * its personal audit page — "you are #4 of 5 similar businesses near you by
 * Google rating, and 3 of the 4 others have a website of their own".
 *
 * Pure, and held to §2.2 like everything quoted outside the building: every
 * cell is a fact somebody recorded and dated — a Google listing read within
 * `LISTING_STALE_DAYS`, a scan or audit inside its deadline — or it says
 * "not checked". An unknown is never a "no", for the business or for a
 * competitor. Competitors are not named: they are other businesses, the
 * page goes to one of their rivals, and "a dentist 1.2 km away" makes the
 * point without making it about anyone.
 */
import { LISTING_STALE_DAYS } from './opportunity.js'

export interface PeerFacts {
  readonly id: string
  readonly category: string | null
  readonly city: string | null
  readonly lat: number | null
  readonly lng: number | null
  /** When the listing facts below were read; null when there is no listing. */
  readonly listingCheckedAt: Date | null
  readonly rating: number | null
  readonly reviews: number | null
  /** Its own website (`classifyWebsite` = 'own'); null when not known. */
  readonly ownWebsite: boolean | null
  /** From its latest scan inside its deadline; null when not checked. */
  readonly mobileFriendly: boolean | null
  readonly whatsapp: boolean | null
  readonly onlineBooking: boolean | null
  /** PageSpeed's mobile performance score from an audit inside its deadline; null when not measured. */
  readonly speedScore: number | null
}

/** The great-circle distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const located = (p: PeerFacts): p is PeerFacts & { lat: number; lng: number } =>
  p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng)

const currentListing = (p: PeerFacts, now: Date): boolean =>
  p.listingCheckedAt !== null && now.getTime() - p.listingCheckedAt.getTime() <= LISTING_STALE_DAYS * 86_400_000

export interface Peer {
  readonly facts: PeerFacts
  /** Null when either side has no coordinates — then it shares the city. */
  readonly km: number | null
}

/**
 * The nearest businesses of the same listing category: by distance when both
 * sides have coordinates (within `maxKm`), else sharing the city. Only a
 * current listing counts — a rating read last year is not a comparison.
 */
export function nearestPeers(
  subject: PeerFacts,
  candidates: readonly PeerFacts[],
  now: Date,
  opts: { readonly limit?: number; readonly maxKm?: number } = {},
): Peer[] {
  const limit = opts.limit ?? 4
  const maxKm = opts.maxKm ?? 8
  if (!subject.category) return []
  const city = subject.city?.trim().toLowerCase() || null
  const out: Peer[] = []
  for (const c of candidates) {
    if (c.id === subject.id || c.category !== subject.category || !currentListing(c, now)) continue
    if (located(subject) && located(c)) {
      const km = distanceKm(subject, c)
      if (km <= maxKm) out.push({ facts: c, km })
    } else if (city !== null && c.city?.trim().toLowerCase() === city) {
      out.push({ facts: c, km: null })
    }
  }
  out.sort((a, b) => (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY) || a.facts.id.localeCompare(b.facts.id))
  return out.slice(0, limit)
}

/**
 * Where the subject stands by Google rating among itself and its peers: the
 * place (1 is best) and how many were compared, or null when the subject has
 * no current rating. Reviews break a tie — 4.6 from 300 people outranks 4.6
 * from 3.
 */
export function ratingPlace(subject: PeerFacts, peers: readonly Peer[], now: Date): { place: number; of: number } | null {
  if (subject.rating === null || !currentListing(subject, now)) return null
  const rated = [subject, ...peers.map((p) => p.facts)].filter((p) => p.rating !== null)
  const better = rated.filter(
    (p) => p.id !== subject.id && (p.rating! > subject.rating! || (p.rating === subject.rating && (p.reviews ?? 0) > (subject.reviews ?? 0))),
  )
  return { place: better.length + 1, of: rated.length }
}

export interface ComparisonRow {
  readonly label: string
  readonly subject: string
  readonly peers: readonly string[]
}

const yesNo = (v: boolean | null): string => (v === null ? 'not checked' : v ? 'yes' : 'no')

/** One row per fact compared; every cell a recorded fact or "not checked". */
export function comparisonRows(subject: PeerFacts, peers: readonly Peer[], now: Date): ComparisonRow[] {
  const rating = (p: PeerFacts): string =>
    p.rating === null || !currentListing(p, now)
      ? 'not checked'
      : `★${p.rating.toFixed(1)}${p.reviews !== null ? ` (${p.reviews.toLocaleString('en-IN')} reviews)` : ''}`
  const speed = (p: PeerFacts): string => (p.speedScore === null ? 'not checked' : `${p.speedScore}/100`)
  const rows: { label: string; get: (p: PeerFacts) => string }[] = [
    { label: 'Google rating', get: rating },
    { label: 'Website of its own', get: (p) => yesNo(p.ownWebsite) },
    { label: 'Works well on a phone', get: (p) => yesNo(p.mobileFriendly) },
    { label: 'WhatsApp button', get: (p) => yesNo(p.whatsapp) },
    { label: 'Online booking or ordering', get: (p) => yesNo(p.onlineBooking) },
    { label: 'Page speed on a phone (Google)', get: speed },
  ]
  return rows.map((r) => ({ label: r.label, subject: r.get(subject), peers: peers.map((p) => r.get(p.facts)) }))
}

/** "a dentist 1.2 km away", or "a dentist in Pune" — never a name. */
export function peerLabel(peer: Peer, category: string, index: number): string {
  const what = category.replace(/_/g, ' ')
  const letter = String.fromCharCode(65 + index)
  if (peer.km !== null) return `${what} ${letter} · ${peer.km < 1 ? `${Math.round(peer.km * 1000)} m` : `${peer.km.toFixed(1)} km`} away`
  return `${what} ${letter}${peer.facts.city ? ` · ${peer.facts.city}` : ''}`
}

/**
 * The headline: the subject's place by rating, and how many of the others
 * have what the subject lacks — only facts that are known on both sides.
 * Null when there is nothing true and useful to say. "Similar businesses",
 * never the category with an s on it: Google's types make "pharmacys" and
 * "veterinary cares" of that, and the reader knows what their business is.
 */
export function comparisonHeadline(subject: PeerFacts, peers: readonly Peer[], now: Date): string | null {
  if (peers.length === 0) return null
  const parts: string[] = []
  const place = ratingPlace(subject, peers, now)
  if (place && place.of > 1) parts.push(`You are #${place.place} of ${place.of} similar businesses near you by Google rating`)
  if (subject.ownWebsite === false) {
    const known = peers.filter((p) => p.facts.ownWebsite !== null)
    const with_ = known.filter((p) => p.facts.ownWebsite === true).length
    if (known.length > 0 && with_ > 0) parts.push(`${with_} of the ${known.length} others have a website of their own`)
  }
  if (subject.whatsapp === false) {
    const known = peers.filter((p) => p.facts.whatsapp !== null)
    const with_ = known.filter((p) => p.facts.whatsapp === true).length
    if (known.length > 0 && with_ > 0) parts.push(`${with_} of ${known.length} let customers WhatsApp them from their site`)
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : null
}
