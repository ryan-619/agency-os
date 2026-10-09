/**
 * A business beside its nearest competitors (`src/peers.ts`): who counts as a
 * peer, where the business stands, and that every cell is a recorded fact or
 * "not checked" — never a "no" for something nobody looked at.
 */
import { describe, expect, it } from 'vitest'
import { comparisonHeadline, comparisonRows, distanceKm, nearestPeers, peerLabel, ratingPlace, type PeerFacts } from '../src/index.js'

const NOW = new Date('2026-10-08T07:00:00Z')
const READ = new Date('2026-10-01T07:00:00Z')

const biz = (id: string, over: Partial<PeerFacts> = {}): PeerFacts => ({
  id, category: 'dentist', city: 'Bengaluru', lat: null, lng: null, listingCheckedAt: READ,
  rating: 4.5, reviews: 50, ownWebsite: true, mobileFriendly: true, whatsapp: true, onlineBooking: true, speedScore: 70,
  ...over,
})

describe('distanceKm', () => {
  it('measures the great circle: Indiranagar to Koramangala is about 4.5 km', () => {
    const d = distanceKm({ lat: 12.9784, lng: 77.6408 }, { lat: 12.9352, lng: 77.6245 })
    expect(d).toBeGreaterThan(4.5)
    expect(d).toBeLessThan(5.3)
  })
})

describe('nearestPeers', () => {
  const subject = biz('me', { lat: 12.9784, lng: 77.6408, rating: 4.1, reviews: 12, ownWebsite: false, whatsapp: false })

  it('takes the same category, nearest first, inside the radius, never the subject itself', () => {
    const near = biz('near', { lat: 12.98, lng: 77.641 })
    const far = biz('far', { lat: 13.2, lng: 77.7 })
    const other = biz('salon', { category: 'hair_salon', lat: 12.979, lng: 77.6409 })
    const mid = biz('mid', { lat: 12.97, lng: 77.64 })
    const peers = nearestPeers(subject, [far, other, mid, near, subject], NOW)
    expect(peers.map((p) => p.facts.id)).toEqual(['near', 'mid'])
    expect(peers[0]!.km).toBeLessThan(0.3)
  })

  it('falls back to the same city when either side has no coordinates', () => {
    const noPlace = biz('me2', { lat: null, lng: null })
    const sameCity = biz('a', { city: ' bengaluru ' })
    const otherCity = biz('b', { city: 'Pune' })
    expect(nearestPeers(noPlace, [sameCity, otherCity], NOW).map((p) => p.facts.id)).toEqual(['a'])
  })

  it('leaves out a listing read too long ago, and compares nothing without a category', () => {
    const stale = biz('stale', { listingCheckedAt: new Date('2026-05-01T00:00:00Z') })
    expect(nearestPeers(biz('me3'), [stale], NOW)).toEqual([])
    expect(nearestPeers(biz('me4', { category: null }), [biz('x')], NOW)).toEqual([])
  })
})

describe('where the business stands', () => {
  const subject = biz('me', { rating: 4.1, reviews: 12, ownWebsite: false, whatsapp: false })
  const peers = nearestPeers(subject, [
    biz('a', { rating: 4.7, reviews: 210 }),
    biz('b', { rating: 4.4, reviews: 90, whatsapp: null }),
    biz('c', { rating: 3.9, reviews: 40, ownWebsite: false, whatsapp: false }),
    biz('d', { rating: 4.1, reviews: 300, ownWebsite: null }),
  ], NOW)

  it('places it by rating, reviews breaking a tie', () => {
    expect(ratingPlace(subject, peers, NOW)).toEqual({ place: 4, of: 5 })
  })

  it('says only what is known on both sides', () => {
    expect(comparisonHeadline(subject, peers, NOW)).toBe(
      'You are #4 of 5 similar businesses near you by Google rating; 2 of the 3 others have a website of their own; 2 of 3 let customers WhatsApp them from their site.',
    )
    expect(comparisonHeadline(subject, [], NOW)).toBeNull()
  })

  it('writes every cell as a fact or "not checked"', () => {
    const rows = comparisonRows(subject, peers, NOW)
    const website = rows.find((r) => r.label === 'Website of its own')!
    expect(website.subject).toBe('no')
    expect(website.peers).toEqual(['yes', 'yes', 'no', 'not checked'])
    expect(rows.find((r) => r.label === 'Google rating')!.subject).toBe('★4.1 (12 reviews)')
    const unread = comparisonRows(biz('u', { rating: 4.9, listingCheckedAt: null, speedScore: null }), [], NOW)
    expect(unread.find((r) => r.label === 'Google rating')!.subject).toBe('not checked')
    expect(unread.find((r) => r.label.startsWith('Page speed'))!.subject).toBe('not checked')
  })

  it('labels a competitor by what and where, never by name', () => {
    expect(peerLabel({ facts: biz('a'), km: 0.42 }, 'dentist', 0)).toBe('dentist A · 420 m away')
    expect(peerLabel({ facts: biz('b'), km: 3.25 }, 'dental_clinic', 1)).toBe('dental clinic B · 3.3 km away')
    expect(peerLabel({ facts: biz('c'), km: null }, 'dentist', 2)).toBe('dentist C · Bengaluru')
  })
})
