/**
 * A day's visits in a sensible order (2026-10-08): from where you start, the
 * nearest stop next — then improved by reversing any stretch that makes the
 * route shorter (2-opt) — and the Google Maps link that drives it.
 *
 * Pure, and client-safe (no `server-only`, no `@/` import): the visits page
 * computes it in the browser, from the stops the page loaded and, when you
 * allow it, where your phone says you are. Distances are straight lines,
 * which is why the order is a suggestion and the driving is Google's.
 */
export interface Stop {
  readonly id: string
  readonly label: string
  readonly lat: number
  readonly lng: number
}

export interface Point {
  readonly lat: number
  readonly lng: number
}

/** Great-circle distance, km. */
export function km(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const length = (start: Point | null, order: readonly Stop[]): number => {
  let total = 0
  let at: Point | null = start
  for (const s of order) {
    if (at) total += km(at, s)
    at = s
  }
  return total
}

/** The stops in visiting order, and the straight-line kilometres it covers (from `start` when given). */
export function visitRoute(start: Point | null, stops: readonly Stop[]): { readonly order: Stop[]; readonly km: number } {
  if (stops.length <= 1) return { order: [...stops], km: length(start, stops) }
  // Nearest neighbour, from the start, or from the stop that begins the shortest such route.
  const tryFrom = (first: Stop | null): Stop[] => {
    const left = stops.filter((s) => s !== first)
    const out: Stop[] = first ? [first] : []
    let at: Point = first ?? start!
    while (left.length > 0) {
      let best = 0
      for (let i = 1; i < left.length; i++) if (km(at, left[i]!) < km(at, left[best]!)) best = i
      at = left[best]!
      out.push(left.splice(best, 1)[0]!)
    }
    return out
  }
  let order = start
    ? tryFrom(null)
    : stops.map((s) => tryFrom(s)).reduce((a, b) => (length(null, b) < length(null, a) ? b : a))
  // 2-opt: reverse a stretch whenever that shortens the route, until nothing does.
  let improved = true
  for (let rounds = 0; improved && rounds < 50; rounds++) {
    improved = false
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const next = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)]
        if (length(start, next) + 1e-9 < length(start, order)) {
          order = next
          improved = true
        }
      }
    }
  }
  return { order, km: length(start, order) }
}

/** Google Maps directions through the stops in order — at most 9 waypoints, which the link carries. */
export const MAPS_WAYPOINTS_MAX = 9

export function directionsLink(start: Point | null, order: readonly Point[]): string | null {
  if (order.length === 0) return null
  const p = (x: Point) => `${x.lat.toFixed(6)},${x.lng.toFixed(6)}`
  const origin = start ?? order[0]!
  const rest = start ? order : order.slice(1)
  if (rest.length === 0) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p(origin))}`
  const destination = rest[rest.length - 1]!
  const waypoints = rest.slice(0, -1).slice(0, MAPS_WAYPOINTS_MAX)
  const q = new URLSearchParams({ api: '1', origin: p(origin), destination: p(destination), travelmode: 'driving' })
  if (waypoints.length > 0) q.set('waypoints', waypoints.map(p).join('|'))
  return `https://www.google.com/maps/dir/?${q.toString()}`
}
