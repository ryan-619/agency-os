'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import {
  BULK_MAX, CONFIRM_WORDS, bulkConfirmMatches, bulkKeptGroups, bulkResultsFrom, bulkSummary, companiesBulkWords,
  sendDelete, type BulkRowResult,
} from '../../lib/delete-view'
import { toast } from '../toast/toast'

/**
 * Choose several rows and delete them in one go (2026-10-15): /companies
 * (an owner's, the count typed back) and /contacts (anybody who may change
 * contacts, a confirm). Built to clear what the chat agent filed before
 * 0029 — the "Added by the assistant" filter beside each list finds it.
 *
 * `BulkSelection` wraps a list the server rendered and holds which rows are
 * chosen; each row's `BulkCheck` and the header's `BulkSelectAll` read it
 * through context, so the table itself stays a server render. Nothing is
 * sent until the bar's button is pressed and confirmed. The route runs each
 * row through its own writer in its own transaction, and the answer is
 * shown row by row: how many went, and for the rest the writer's sentence —
 * kept, and why — with their names, until the list is refreshed.
 */

type Kind = 'companies' | 'contacts'

interface Selection {
  readonly selected: ReadonlySet<string>
  readonly ids: readonly string[]
  toggle(id: string, on: boolean): void
  setAll(on: boolean): void
}

const Chosen = createContext<Selection | null>(null)

const NOUN: Readonly<Record<Kind, { one: string; many: string }>> = {
  companies: { one: 'company', many: 'companies' },
  contacts: { one: 'person', many: 'people' },
}

const URL_FOR: Readonly<Record<Kind, string>> = {
  companies: '/api/companies/delete',
  contacts: '/api/contacts/delete',
}

export function BulkSelection({
  kind,
  items,
  enabled,
  children,
}: {
  kind: Kind
  /** Every row on the page, with the words a result names it by. */
  items: readonly { readonly id: string; readonly label: string }[]
  /** False for somebody who may not delete these: no checkboxes, no bar. */
  enabled: boolean
  children: ReactNode
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<readonly BulkRowResult[] | null>(null)
  const ids = useMemo(() => items.map((i) => i.id), [items])
  const labels = useMemo(() => new Map(items.map((i) => [i.id, i.label])), [items])

  const value = useMemo<Selection>(
    () => ({
      selected,
      ids,
      toggle: (id, on) =>
        setSelected((s) => {
          const next = new Set(s)
          if (on) next.add(id)
          else next.delete(id)
          return next
        }),
      setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
    }),
    [selected, ids],
  )

  if (!enabled) return <>{children}</>

  const n = selected.size
  const max = BULK_MAX[kind]
  const typedCount = kind === 'companies'
  const ready = n > 0 && n <= max && (!typedCount || bulkConfirmMatches(typed, n))

  const run = async (): Promise<void> => {
    if (!ready) return
    if (!typedCount && !window.confirm(CONFIRM_WORDS.contacts(n))) return
    setBusy(true)
    setError('')
    const chosen = ids.filter((id) => selected.has(id))
    const r = await sendDelete(URL_FOR[kind], {
      method: 'POST',
      body: typedCount ? { ids: chosen, confirm: typed.trim() } : { ids: chosen },
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.failure.message)
      return
    }
    const rows = bulkResultsFrom(r.body)
    setResults(rows)
    setTyped('')
    // The ones that went are no longer choosable; the kept ones stay chosen
    // only if a person chooses them again.
    setSelected(new Set())
    toast.success(bulkSummary(rows, NOUN[kind]))
  }

  return (
    <Chosen.Provider value={value}>
      {results ? <BulkResults results={results} labelOf={(id) => labels.get(id) ?? id} noun={NOUN[kind]} /> : null}
      {n > 0 ? (
        <div className="note" role="region" aria-label="Delete the chosen rows" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>
              {n} {n === 1 ? NOUN[kind].one : NOUN[kind].many} chosen
            </strong>
            {n > max ? <span className="err-line" style={{ marginTop: 0 }}>At most {max} at a time.</span> : null}
            {typedCount ? (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, margin: 0 }}>
                Type {n} to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  style={{ width: 70 }}
                />
              </label>
            ) : null}
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void run()}
              style={{ width: 'auto', marginTop: 0, background: 'var(--panel)', color: 'var(--warn)', border: '1px solid var(--warn)' }}
            >
              <Trash2 aria-hidden="true" style={{ width: 13, height: 13, verticalAlign: '-2px', marginRight: 6 }} />
              {busy ? 'Deleting…' : 'Delete selected'}
            </button>
            <button type="button" className="linkish" disabled={busy} onClick={() => setSelected(new Set())}>
              Clear the choice
            </button>
          </div>
          {typedCount ? <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{companiesBulkWords(n)}</p> : null}
          {error ? <div className="err-line" role="alert">{error}</div> : null}
        </div>
      ) : null}
      {children}
    </Chosen.Provider>
  )
}

/** The answer, row by row: how many went, and who was kept and why. */
function BulkResults({
  results,
  labelOf,
  noun,
}: {
  results: readonly BulkRowResult[]
  labelOf: (id: string) => string
  noun: { one: string; many: string }
}) {
  const kept = bulkKeptGroups(results, labelOf)
  const gone = results.filter((r) => r.ok).map((r) => labelOf(r.id))
  return (
    <div className="row-card slim" style={{ marginTop: 14, fontSize: 13 }}>
      <div className={kept.length === 0 ? 'ok-line' : undefined} style={{ marginTop: 0, fontWeight: 600 }}>
        {bulkSummary(results, noun)}
      </div>
      {gone.length > 0 ? (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Deleted: {gone.join(', ')}</div>
      ) : null}
      {kept.map((g) => (
        <div key={g.message} style={{ marginTop: 6 }}>
          <div className="err-line" style={{ marginTop: 0 }}>{g.message}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Kept: {g.labels.join(', ')}</div>
        </div>
      ))}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" onClick={() => window.location.reload()}>
          Refresh the list
        </button>
      </div>
    </div>
  )
}

/** A row's checkbox. Nothing at all where nobody may delete. */
export function BulkCheck({ id, label }: { id: string; label: string }) {
  const ctx = useContext(Chosen)
  if (!ctx) return null
  return (
    <input
      type="checkbox"
      aria-label={`Choose ${label}`}
      checked={ctx.selected.has(id)}
      onChange={(e) => ctx.toggle(id, e.target.checked)}
      style={{ width: 'auto', margin: 0 }}
    />
  )
}

/** The header's checkbox: every row on this page, or none. */
export function BulkSelectAll() {
  const ctx = useContext(Chosen)
  if (!ctx || ctx.ids.length === 0) return null
  const all = ctx.ids.every((id) => ctx.selected.has(id))
  return (
    <input
      type="checkbox"
      aria-label={all ? 'Choose none' : 'Choose every row on this page'}
      checked={all}
      onChange={(e) => ctx.setAll(e.target.checked)}
      style={{ width: 'auto', margin: 0 }}
    />
  )
}
