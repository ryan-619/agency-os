'use client'

import { useState } from 'react'
import { toast } from '../../../components/toast/toast'
import { PRICE_UNITS, priceLine } from '@/lib/service-price'

/**
 * The services catalogue, editable in place by an owner (0022). Every change
 * goes to /api/services and the page reloads from what was stored, so what
 * is shown is what the assistant will quote.
 */

export interface NeedView {
  readonly key: string
  readonly label: string
  readonly why: string
}

export interface ServiceView {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly needs: readonly string[]
  readonly priceFrom: number | null
  readonly priceTo: number | null
  readonly currency: string
  readonly priceUnit: string
  readonly active: boolean
}

const UNITS = PRICE_UNITS

type Draft = {
  name: string
  description: string
  needs: string[]
  priceFrom: string
  priceTo: string
  currency: string
  priceUnit: string
}

const EMPTY: Draft = { name: '', description: '', needs: [], priceFrom: '', priceTo: '', currency: 'INR', priceUnit: 'one_off' }

function draftOf(s: ServiceView): Draft {
  return {
    name: s.name,
    description: s.description ?? '',
    needs: [...s.needs],
    priceFrom: s.priceFrom === null ? '' : String(s.priceFrom),
    priceTo: s.priceTo === null ? '' : String(s.priceTo),
    currency: s.currency,
    priceUnit: s.priceUnit,
  }
}

function bodyOf(d: Draft): Record<string, unknown> {
  const money = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[, ]/g, '')))
  return {
    name: d.name,
    description: d.description.trim() || null,
    needs: d.needs,
    priceFrom: money(d.priceFrom),
    priceTo: money(d.priceTo),
    currency: d.currency.trim().toUpperCase() || 'INR',
    priceUnit: d.priceUnit,
  }
}


function ServiceForm({
  draft, setDraft, needs, onSave, onCancel, busy, saveLabel,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  needs: readonly NeedView[]
  onSave: () => void
  onCancel?: () => void
  busy: boolean
  saveLabel: string
}) {
  const toggle = (key: string) =>
    setDraft({ ...draft, needs: draft.needs.includes(key) ? draft.needs.filter((k) => k !== key) : [...draft.needs, key] })
  return (
    <div className="row-card" style={{ display: 'grid', gap: 8 }}>
      <label>
        Name
        <input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. New website" />
      </label>
      <label>
        What it is <span className="muted">(optional)</span>
        <textarea
          rows={2}
          maxLength={1000}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="A fast, mobile-ready site on their own domain, with WhatsApp and map buttons."
        />
      </label>
      <div className="two-up">
        <label>
          Price from <span className="muted">(whole units)</span>
          <input inputMode="numeric" value={draft.priceFrom} onChange={(e) => setDraft({ ...draft, priceFrom: e.target.value })} placeholder="15000" />
        </label>
        <label>
          Price to <span className="muted">(optional)</span>
          <input inputMode="numeric" value={draft.priceTo} onChange={(e) => setDraft({ ...draft, priceTo: e.target.value })} placeholder="40000" />
        </label>
        <label>
          Currency
          <input value={draft.currency} maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Charged
          <select value={draft.priceUnit} onChange={(e) => setDraft({ ...draft, priceUnit: e.target.value })}>
            {UNITS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12.5, marginBottom: 4 }}>Needs it answers — the company page and the assistant match these</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 12px' }}>
          {needs.map((n) => (
            <label key={n.key} title={n.why} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
              <input type="checkbox" checked={draft.needs.includes(n.key)} onChange={() => toggle(n.key)} style={{ width: 'auto' }} />
              {n.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row-actions">
        <button type="button" disabled={busy || draft.name.trim() === ''} onClick={onSave}>{saveLabel}</button>
        {onCancel ? (
          <button type="button" className="linkish" disabled={busy} onClick={onCancel}>Cancel</button>
        ) : null}
      </div>
    </div>
  )
}

export function ServicesPanel({
  services, needs, canWrite,
}: {
  services: readonly ServiceView[]
  needs: readonly NeedView[]
  canWrite: boolean
}) {
  const [adding, setAdding] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<Record<string, Draft | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = (key: string) => needs.find((n) => n.key === key)?.label ?? key

  const send = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (res.ok) {
        toast.afterReload(method === 'DELETE' ? 'Service removed.' : method === 'POST' ? 'Added to the catalogue.' : 'Service saved.')
        window.location.reload()
        return true
      }
      const answer = (await res.json().catch(() => ({}))) as { error?: string }
      setError(answer.error ?? 'That did not save.')
      return false
    } catch {
      setError('The request did not complete. Nothing changed; try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error ? <div className="err-line" style={{ marginBottom: 10 }}>{error}</div> : null}

      {services.length === 0 ? (
        <div className="note" style={{ marginBottom: 12 }}>
          No services yet. Until there are, the assistant suggests a starting set — labelled as suggestions, with no
          prices.{' '}
          {canWrite ? (
            <button type="button" className="linkish" disabled={busy} onClick={() => void send('/api/services/suggested', 'POST')}>
              Add the suggested services
            </button>
          ) : null}{' '}
          {canWrite ? 'to edit them here.' : ''}
        </div>
      ) : null}

      <div className="rows">
        {services.map((s) => {
          const draft = editing[s.id]
          if (draft) {
            return (
              <ServiceForm
                key={s.id}
                draft={draft}
                setDraft={(d) => setEditing((e) => ({ ...e, [s.id]: d }))}
                needs={needs}
                busy={busy}
                saveLabel="Save"
                onSave={() => void send(`/api/services/${s.id}`, 'PATCH', bodyOf(draft))}
                onCancel={() => setEditing((e) => ({ ...e, [s.id]: undefined }))}
              />
            )
          }
          return (
            <div key={s.id} className="row-card slim" style={{ opacity: s.active ? 1 : 0.6 }}>
              <div className="row-head">
                <strong>{s.name}</strong>
                <span className="pill">{priceLine(s)}</span>
                {!s.active ? <span className="tag">switched off</span> : null}
              </div>
              {s.description ? <p className="muted" style={{ margin: '4px 0' }}>{s.description}</p> : null}
              <p className="hint" style={{ margin: '4px 0' }}>
                {s.needs.length ? `Answers: ${s.needs.map(label).join(', ')}` : 'Answers no observed need — offered by hand.'}
              </p>
              {canWrite ? (
                <div className="row-actions">
                  <button type="button" className="linkish" disabled={busy} onClick={() => setEditing((e) => ({ ...e, [s.id]: draftOf(s) }))}>
                    Edit
                  </button>
                  <button type="button" className="linkish" disabled={busy} onClick={() => void send(`/api/services/${s.id}`, 'PATCH', { active: !s.active })}>
                    {s.active ? 'Switch off' : 'Switch on'}
                  </button>
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove "${s.name}" from the catalogue?`)) void send(`/api/services/${s.id}`, 'DELETE')
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {canWrite ? (
        <>
          <h2 style={{ marginTop: 20 }}>Add a service</h2>
          <ServiceForm
            draft={adding}
            setDraft={setAdding}
            needs={needs}
            busy={busy}
            saveLabel="Add service"
            onSave={() => void send('/api/services', 'POST', bodyOf(adding))}
          />
        </>
      ) : (
        <p className="hint">Only an owner can change the catalogue.</p>
      )}
    </>
  )
}
