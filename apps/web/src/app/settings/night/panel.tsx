'use client'

import { useEffect, useState } from 'react'
import { toast } from '../../../components/toast/toast'
import { knownTimeZones } from '@/lib/wall-clock'
import { ToastOn } from '../../../components/toast/toast-on'

export interface NightSearchView {
  readonly id: string
  readonly query: string
  readonly region: string | null
  readonly city: string | null
  readonly active: boolean
  readonly lastRunAt: string | null
}

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (res.ok) return null
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  return data.error ?? 'That did not work. Try again.'
}

/** Settings → Night shift's controls (0025). Only an owner gets them; everyone else reads the page. */
export function NightPanel({
  enabled, runAt, timeZone, searches, suggestions, canWrite,
}: {
  readonly enabled: boolean
  readonly runAt: string
  readonly timeZone: string
  readonly searches: readonly NightSearchView[]
  /** Searches for more businesses like the ones won (`lookalikeSearches`), not yet saved. */
  readonly suggestions: readonly { readonly query: string; readonly city: string; readonly won: number }[]
  readonly canWrite: boolean
}) {
  const [on, setOn] = useState(enabled)
  const [at, setAt] = useState(runAt)
  const [zone, setZone] = useState(timeZone)
  const [zones, setZones] = useState<string[]>([timeZone])
  const [query, setQuery] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('IN')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // The zone list is the browser's own, read after the first render (a server render would differ).
  useEffect(() => setZones(knownTimeZones()), [])

  const act = async (f: () => Promise<string | null>, done: string, reload = true) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const failed = await f()
      if (failed) setError(failed)
      else if (reload) {
        if (done) toast.afterReload(done)
        window.location.reload()
      } else setNote(done)
    } finally {
      setBusy(false)
    }
  }

  if (!canWrite) return <p className="hint">Only an owner can change the night shift.</p>

  return (
    <>
      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>When it runs</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Run the night shift every night
        </label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
          <label>At <input type="time" value={at} onChange={(e) => setAt(e.target.value)} /></label>
          <label>
            in{' '}
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {[...new Set([zone, ...zones])].map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          <button type="button" className="primary" disabled={busy} onClick={() => void act(() => send('/api/settings/night', 'PUT', { enabled: on, runAt: at, timeZone: zone }), 'Night shift saved.')}>
            Save
          </button>
          {enabled ? (
            <button type="button" disabled={busy} onClick={() => void act(() => send('/api/settings/night/run', 'POST'), 'Asked for: the worker runs it at its next look, within a minute or so.', false)}>
              Run it now
            </button>
          ) : null}
        </div>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>What it searches for</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          As you would type it into Google Maps — what and where. Up to five run each night, the one that ran longest ago first.
        </p>
        {searches.length === 0 ? <p className="muted">No searches saved yet.</p> : (
          <table>
            <tbody>
              {searches.map((s) => (
                <tr key={s.id}>
                  <td>{s.query}</td>
                  <td className="muted">{[s.city, s.region].filter(Boolean).join(', ') || '—'}</td>
                  <td className="muted">{s.lastRunAt ? `last ran ${s.lastRunAt.slice(0, 10)}` : 'not run yet'}</td>
                  <td>
                    <button type="button" disabled={busy} onClick={() => void act(() => send(`/api/settings/night/searches/${s.id}`, 'PATCH', { active: !s.active }), s.active ? 'Search switched off.' : 'Search switched on.')}>
                      {s.active ? 'Pause' : 'Resume'}
                    </button>{' '}
                    <button type="button" disabled={busy} onClick={() => void act(() => send(`/api/settings/night/searches/${s.id}`, 'DELETE'), 'Search removed.')}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {suggestions.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <p className="hint" style={{ margin: '0 0 6px' }}>More like the businesses you have won:</p>
            {suggestions.map((s) => (
              <div key={s.query} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 6px', fontSize: 14 }}>
                <span>
                  {s.query} <span className="muted">· {s.won} won</span>
                </span>
                <button type="button" disabled={busy} onClick={() => void act(() => send('/api/settings/night/searches', 'POST', { query: s.query, city: s.city, region: 'IN' }), 'Search saved.')}>
                  Save
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 560 }}>
          <input type="text" placeholder="e.g. dentists in Indiranagar, Bengaluru" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" placeholder="City to file them under (optional)" value={city} maxLength={80} onChange={(e) => setCity(e.target.value)} style={{ flex: 1 }} />
            <input type="text" placeholder="IN" value={region} maxLength={2} onChange={(e) => setRegion(e.target.value.toUpperCase())} style={{ width: 56 }} aria-label="Country (two letters)" />
          </div>
          <div>
            <button type="button" disabled={busy || query.trim().length < 3} onClick={() => void act(() => send('/api/settings/night/searches', 'POST', { query, city, region }), 'Search saved.')}>
              Add search
            </button>
          </div>
        </div>
      </section>
      <ToastOn message={note} />
      {error ? <p className="error" role="alert" style={{ marginTop: 12 }}>{error}</p> : null}
    </>
  )
}
