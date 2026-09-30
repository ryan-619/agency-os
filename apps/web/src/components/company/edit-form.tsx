'use client'

import { useEffect, useState } from 'react'
import { knownTimeZones } from '@/lib/wall-clock'

/**
 * The edit control for a company's name, country and timezone.
 *
 * It sends only the fields a person actually changed, so two people editing
 * different fields at once do not overwrite each other with what their page
 * loaded. A blank field clears the value.
 *
 * The zone field suggests the runtime's zone list and PRE-FILLS NOTHING: the
 * browser's own zone is where the person typing is, not where the company is,
 * and a zone is declared, never guessed. The server is the authority on
 * whether a zone is known — the list is a convenience, so a valid alias it
 * leaves out (`Japan`) is still accepted.
 */
export function CompanyEditForm({
  companyId,
  name: initialName,
  country: initialCountry,
  timeZone: initialZone,
}: {
  companyId: string
  name: string | null
  country: string | null
  timeZone: string | null
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(initialName ?? '')
  const [country, setCountry] = useState(initialCountry ?? '')
  const [zone, setZone] = useState(initialZone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Browser-only values are set after mount: the zone list differs between
  // Node and the browser, and reading it in the first render is a hydration
  // error (the booking page found that one).
  const [zones, setZones] = useState<string[]>([])
  useEffect(() => {
    if (open && zones.length === 0) setZones(knownTimeZones())
  }, [open, zones.length])

  const save = async (): Promise<void> => {
    const body: Record<string, string | null> = {}
    const put = (key: string, value: string, was: string | null): void => {
      if (value.trim() !== (was ?? '')) body[key] = value.trim() || null
    }
    put('name', name, initialName)
    put('country', country, initialCountry)
    put('timeZone', zone, initialZone)
    if (Object.keys(body).length === 0) {
      setOpen(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="linkish"
        style={{ marginTop: 4, fontSize: 12.5 }}
        onClick={() => setOpen(true)}
      >
        Edit name, country or timezone
      </button>
    )
  }

  return (
    <form
      className="row-card slim"
      style={{ marginTop: 10 }}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="two-up">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="as the company writes it" />
        </label>
        <label>
          Country
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={80} placeholder="e.g. Netherlands" />
        </label>
      </div>
      <label>
        Timezone
        <input
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          list="company-edit-zones"
          maxLength={64}
          placeholder="IANA name, e.g. Europe/Amsterdam"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="company-edit-zones">
          {zones.map((z) => <option key={z} value={z} />)}
        </datalist>
        <span className="hint">
          The zone is what quiet hours are checked against for every contact here who has none of their own. It is
          declared, never guessed from the country.
        </span>
      </label>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy}>Save</button>
        <button
          type="button"
          className="deny"
          disabled={busy}
          onClick={() => {
            setName(initialName ?? '')
            setCountry(initialCountry ?? '')
            setZone(initialZone ?? '')
            setError(null)
            setOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
