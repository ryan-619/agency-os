/** A day's visits in order (`lib/visit-route.ts`). */
import { describe, expect, it } from 'vitest'
import { MAPS_WAYPOINTS_MAX, directionsLink, km, visitRoute, type Stop } from '../src/lib/visit-route'

// Four stops along one road in Bengaluru, given out of order.
const A: Stop = { id: 'a', label: 'A', lat: 12.9716, lng: 77.5946 }
const B: Stop = { id: 'b', label: 'B', lat: 12.9716, lng: 77.6046 }
const C: Stop = { id: 'c', label: 'C', lat: 12.9716, lng: 77.6146 }
const D: Stop = { id: 'd', label: 'D', lat: 12.9716, lng: 77.6246 }

describe('visit routes', () => {
  it('measures straight-line kilometres', () => {
    expect(km(A, B)).toBeGreaterThan(1.0)
    expect(km(A, B)).toBeLessThan(1.2)
    expect(km(A, A)).toBe(0)
  })

  it('visits from where you are, nearest next, and never crosses back', () => {
    const r = visitRoute({ lat: 12.9716, lng: 77.6300 }, [B, D, A, C])
    expect(r.order.map((s) => s.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(r.km).toBeCloseTo(km({ lat: 12.9716, lng: 77.63 }, D) + km(D, A), 3)
  })

  it('with no start, begins at an end so the line is walked once', () => {
    const r = visitRoute(null, [C, A, D, B])
    expect(r.order.map((s) => s.id).join('')).toMatch(/^(abcd|dcba)$/)
  })

  it('makes the Google Maps link through the stops in order, and one stop is a search', () => {
    const link = directionsLink(null, [A, B, C])!
    const q = new URL(link).searchParams
    expect(q.get('origin')).toBe('12.971600,77.594600')
    expect(q.get('destination')).toBe('12.971600,77.614600')
    expect(q.get('waypoints')).toBe('12.971600,77.604600')
    expect(directionsLink(null, [A])).toBe('https://www.google.com/maps/search/?api=1&query=12.971600%2C77.594600')
    expect(directionsLink(null, [])).toBeNull()
    const many = Array.from({ length: 15 }, (_, i) => ({ lat: 12.9 + i / 100, lng: 77.6 }))
    expect(new URL(directionsLink(null, many)!).searchParams.get('waypoints')!.split('|')).toHaveLength(MAPS_WAYPOINTS_MAX)
  })
})
