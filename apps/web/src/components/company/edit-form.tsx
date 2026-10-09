'use client'

import { useEffect, useState } from 'react'
import { knownTimeZones } from '@/lib/wall-clock'
import { toast } from '../toast/toast'

/** core's `COMPANY_STAGES`, restated client-side; `company-edit-form.test.ts` holds the two equal. */
export const STAGE_OPTIONS = [
  'pre-seed', 'seed', 'series-a', 'series-b', 'series-c-plus', 'bootstrapped', 'bootstrapped-profitable', 'public',
  'acquired',
] as const

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
  industry: initialIndustry = null,
  city: initialCity = null,
  stage: initialStage = null,
  headcount: initialHeadcount = null,
  headcountSource: initialSource = null,
  description: initialDescription = null,
}: {
  companyId: string
  name: string | null
  country: string | null
  timeZone: string | null
  industry?: string | null
  city?: string | null
  stage?: string | null
  headcount?: number | null
  headcountSource?: string | null
  description?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(initialName ?? '')
  const [country, setCountry] = useState(initialCountry ?? '')
  const [zone, setZone] = useState(initialZone ?? '')
  const [industry, setIndustry] = useState(initialIndustry ?? '')
  const [city, setCity] = useState(initialCity ?? '')
  const [stage, setStage] = useState(initialStage ?? '')
  const [headcount, setHeadcount] = useState(initialHeadcount === null ? '' : String(initialHeadcount))
  const [source, setSource] = useState(initialSource ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
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
    const body: Record<string, string | number | null> = {}
    const put = (key: string, value: string, was: string | null): void => {
      if (value.trim() !== (was ?? '')) body[key] = value.trim() || null
    }
    put('name', name, initialName)
    put('country', country, initialCountry)
    put('timeZone', zone, initialZone)
    put('industry', industry, initialIndustry)
    put('city', city, initialCity)
    put('stage', stage, initialStage)
    put('headcountSource', source, initialSource)
    put('description', description, initialDescription)
    const count = headcount.trim()
    if (count !== (initialHeadcount === null ? '' : String(initialHeadcount))) {
      if (count === '') body['headcount'] = null
      else if (/^\d{1,8}$/.test(count) && Number(count) >= 1) body['headcount'] = Number(count)
      else {
        setError('The headcount is a whole number of people, such as 120.')
        return
      }
    }
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
      toast.success('Saved.')
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
        Edit the company’s details
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
      <div className="two-up">
        <label>
          Industry
          <input value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={80} placeholder="e.g. fintech — payments" />
        </label>
        <label>
          City
          <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} placeholder="e.g. Bengaluru" />
        </label>
      </div>
      <div className="two-up">
        <label>
          Headcount
          <input value={headcount} onChange={(e) => setHeadcount(e.target.value)} inputMode="numeric" maxLength={8} placeholder="about how many people" />
        </label>
        <label>
          Stage
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">not recorded</option>
            {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label>
        Where the headcount came from
        <input value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} placeholder="a URL — its LinkedIn page, a directory — or a short note" />
        <span className="hint">
          A headcount is research, not a scan observation, so it is kept with its source. Over the active profile’s
          maximum, it disqualifies the company at its next scan.
        </span>
      </label>
      <label>
        What it does
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} rows={2} placeholder="one or two sentences: what it sells, and to whom" />
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
            setIndustry(initialIndustry ?? '')
            setCity(initialCity ?? '')
            setStage(initialStage ?? '')
            setHeadcount(initialHeadcount === null ? '' : String(initialHeadcount))
            setSource(initialSource ?? '')
            setDescription(initialDescription ?? '')
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
