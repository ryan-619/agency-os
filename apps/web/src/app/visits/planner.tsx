'use client'

import { useMemo, useState } from 'react'
import { MAPS_WAYPOINTS_MAX, directionsLink, km, visitRoute, type Point, type Stop } from '@/lib/visit-route'

export interface VisitView extends Stop {
  readonly taskId: string
  readonly title: string
  readonly address: string | null
  readonly phone: string | null
  readonly domain: string
  readonly due: string | null
}

/**
 * Today's visits, in order (2026-10-08). Where you are comes from your phone
 * only when you ask, and stays in this page: it is never sent anywhere but
 * into the Google Maps link you open.
 */
export function VisitsPlanner({ visits }: { readonly visits: readonly VisitView[] }) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(visits.map((v) => v.taskId)))
  const [start, setStart] = useState<Point | null>(null)
  const [where, setWhere] = useState('')
  const stops = visits.filter((v) => chosen.has(v.taskId))
  const route = useMemo(() => visitRoute(start, stops), [start, stops])
  const order = route.order as VisitView[]
  const link = directionsLink(start, order)

  const locate = () => {
    if (!navigator.geolocation) {
      setWhere('This browser cannot say where you are.')
      return
    }
    setWhere('Finding where you are…')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setStart({ lat: p.coords.latitude, lng: p.coords.longitude })
        setWhere('Starting from where you are now.')
      },
      () => setWhere('Your location was not shared, so the route starts at the first stop.'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    )
  }

  // A sketch of the route: the stops placed by their coordinates, scaled to fit, joined in order.
  const all: Point[] = [...(start ? [start] : []), ...order]
  const lats = all.map((p) => p.lat)
  const lngs = all.map((p) => p.lng)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const xs = lngs.map((l) => l * Math.cos((midLat * Math.PI) / 180))
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...lats), Math.max(...lats)]
  const span = Math.max(maxX - minX, maxY - minY, 1e-6)
  const at = (p: Point) => ({
    x: 20 + ((p.lng * Math.cos((midLat * Math.PI) / 180) - minX) / span) * 260,
    y: 280 - ((p.lat - minY) / span) * 260,
  })

  return (
    <>
      <div className="row-actions" style={{ justifyContent: 'flex-start', marginBottom: 10 }}>
        <button type="button" onClick={locate}>Start from where I am</button>
        {link ? (
          <a className="button-like primary" href={link} target="_blank" rel="noreferrer noopener">
            Open the route in Google Maps
          </a>
        ) : null}
      </div>
      {where ? <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{where}</p> : null}
      {order.length > MAPS_WAYPOINTS_MAX + 1 ? (
        <p className="note note-warn">Google Maps takes {MAPS_WAYPOINTS_MAX + 1} stops in one link: it covers the first {MAPS_WAYPOINTS_MAX + 1} here. Untick some, or plan the rest as a second route.</p>
      ) : null}
      <div className="visits">
        <ol className="visit-list">
          {order.map((v, i) => {
            const from = i === 0 ? start : order[i - 1]!
            return (
              <li key={v.taskId}>
                <strong>{v.label}</strong>
                {from ? <span className="muted"> · {km(from, v).toFixed(1)} km{i === 0 ? ' from you' : ''}</span> : null}
                <div className="muted" style={{ fontSize: 13 }}>{v.title}</div>
                {v.address ? <div style={{ fontSize: 13 }}>{v.address}</div> : null}
                <div style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                  {v.phone ? <a href={`tel:${v.phone}`}>Call ahead</a> : null}
                  <a href={`/companies/${encodeURIComponent(v.domain)}`}>What they need</a>
                  <a href="/tasks">Mark done on Tasks</a>
                </div>
              </li>
            )
          })}
        </ol>
        {order.length > 1 ? (
          <svg viewBox="0 0 300 300" className="visit-sketch" role="img" aria-label="A sketch of the route">
            <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" points={all.map((p) => { const q = at(p); return `${q.x},${q.y}` }).join(' ')} />
            {start ? <circle cx={at(start).x} cy={at(start).y} r="7" fill="#2563eb" /> : null}
            {order.map((v, i) => {
              const q = at(v)
              return (
                <g key={v.taskId}>
                  <circle cx={q.x} cy={q.y} r="11" fill="#111827" />
                  <text x={q.x} y={q.y + 4} textAnchor="middle" fontSize="11" fill="#fff">{i + 1}</text>
                </g>
              )
            })}
          </svg>
        ) : null}
      </div>
      {order.length > 0 ? <p className="muted" style={{ fontSize: 13 }}>About {route.km.toFixed(1)} km in straight lines; Google Maps drives it.</p> : null}
      <details style={{ marginTop: 12 }}>
        <summary className="muted" style={{ fontSize: 13 }}>Choose the stops ({stops.length} of {visits.length})</summary>
        {visits.map((v) => (
          <label key={v.taskId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={chosen.has(v.taskId)}
              onChange={(e) => {
                const next = new Set(chosen)
                if (e.target.checked) next.add(v.taskId)
                else next.delete(v.taskId)
                setChosen(next)
              }}
            />
            {v.label}{v.due ? <span className="muted"> · due {v.due}</span> : null}
          </label>
        ))}
      </details>
    </>
  )
}
