'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  COMPANY_DELETE_GOES, COMPANY_DELETE_KEEPS, DELETED_WORDS, companyConfirmMatches, companyConfirmWord, sendDelete,
} from '../../lib/delete-view'
import { toast } from '../toast/toast'

/**
 * "Delete company…" at the foot of a company's page (2026-10-15) — owners
 * only, as the route is. Closed until asked for; open, it says what goes
 * with the company and what keeps one on the record BEFORE the button, and
 * will not send until the domain — a no-website business's name — is typed
 * back, the check the route makes too (`companyConfirmMatches`).
 *
 * A refusal is the writer's sentence, which names the act that does apply:
 * close the deal as lost, erase a person, withdraw a quote. A company that
 * went goes to /companies with a pop-up naming the kind, never the company.
 */
export function DeleteCompany({
  companyId,
  domain,
  name,
}: {
  companyId: string
  domain: string
  name: string | null
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const word = companyConfirmWord({ domain, name })
  const confirmed = companyConfirmMatches(typed, { domain, name })

  if (!open) {
    return (
      <div style={{ marginTop: 28 }}>
        <button
          type="button"
          className="linkish"
          style={{ color: 'var(--warn)' }}
          onClick={() => setOpen(true)}
        >
          <Trash2 aria-hidden="true" style={{ width: 12, height: 12, verticalAlign: '-1px', marginRight: 4 }} />
          Delete company…
        </button>
      </div>
    )
  }

  const run = async (): Promise<void> => {
    if (!confirmed) return
    setBusy(true)
    setError('')
    const r = await sendDelete(`/api/companies/${companyId}`, { body: { confirm: typed.trim() }, kind: 'company' })
    setBusy(false)
    if (!r.ok) {
      setError(r.failure.message)
      return
    }
    toast.afterReload(DELETED_WORDS.company)
    window.location.assign('/companies')
  }

  return (
    <section className="card" style={{ marginTop: 28, borderColor: 'var(--warn)' }} aria-label="Delete this company">
      <h2 style={{ marginTop: 0, color: 'var(--warn)' }}>Delete this company</h2>
      <p style={{ margin: '0 0 6px', fontSize: 13 }}>
        For a company filed by mistake, or one the assistant filed that does not exist. It goes for good, with:
      </p>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
        {COMPANY_DELETE_GOES.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p style={{ margin: '0 0 6px', fontSize: 13 }}>It is kept, and nothing is deleted, when there is:</p>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
        {COMPANY_DELETE_KEEPS.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
        A suppression is never touched, and the audit log keeps the record that it was deleted. The night shift and
        the assistant do not file it again by its domain or its Google listing; a person can add it again on
        /companies.
      </p>
      <label>
        Type <code>{word}</code> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} maxLength={300} />
      </label>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button
          type="button"
          disabled={busy || !confirmed}
          onClick={() => void run()}
          style={{ background: 'var(--panel)', color: 'var(--warn)', border: '1px solid var(--warn)' }}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setError('') }}>
          Cancel
        </button>
      </div>
    </section>
  )
}
