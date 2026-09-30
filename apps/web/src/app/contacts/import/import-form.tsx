'use client'

import { useActionState, useState } from 'react'

/**
 * The import box and its report.
 *
 * A client component for one reason: the report. It names lines and quotes
 * the sentence that refused each one, and those sentences carry the address
 * that was refused — so they come back as the action's return value rather
 * than in a redirect's query string, where they would land in every access
 * log and the browser's history (§2.3).
 */

export type ContactImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'done'
      readonly rows: number
      readonly inserted: number
      readonly alreadyPresent: number
      readonly unknownCompany: readonly string[]
      readonly refused: readonly { readonly line: number; readonly message: string }[]
      readonly phoneDropped: readonly { readonly line: number }[]
    }

/** What Next accepts in one server-action request body by default. */
const MAX_BYTES = 1_000_000
/** A report longer than this is summarised; the counts stay exact. */
const SHOW = 200

export function ContactImportForm({
  action,
  header,
  maxRows,
}: {
  action: (prev: ContactImportState, formData: FormData) => Promise<ContactImportState>
  header: string
  maxRows: number
}) {
  const [state, formAction, pending] = useActionState(action, { kind: 'idle' } as ContactImportState)
  const [tooBig, setTooBig] = useState<string | null>(null)

  return (
    <>
      <form
        action={formAction}
        onSubmit={(e) => {
          // Checked here because the server never sees a body over the limit:
          // the framework refuses it first, with an error that says nothing
          // useful to the person holding the file.
          const data = new FormData(e.currentTarget)
          const file = data.get('file')
          const pasted = String(data.get('csv') ?? '')
          const bytes = file instanceof File && file.size > 0 ? file.size : new Blob([pasted]).size
          if (bytes > MAX_BYTES) {
            e.preventDefault()
            setTooBig(`That is ${(bytes / 1_000_000).toFixed(1)} MB; one import takes up to 1 MB. Split the file and import each part.`)
            return
          }
          setTooBig(null)
        }}
      >
        <label htmlFor="file">A CSV file</label>
        <input id="file" name="file" type="file" accept=".csv,text/csv,text/plain" />
        <label htmlFor="csv" style={{ marginTop: 12 }}>…or paste the rows, header first</label>
        <textarea
          id="csv"
          name="csv"
          rows={10}
          spellCheck={false}
          placeholder={`${header}\nrentman.io,priya@rentman.io,Priya,Sharma,CTO,+44 20 7946 0000,,Europe/London`}
        />
        <p className="hint">
          Up to {maxRows.toLocaleString('en-GB')} rows and 1 MB per import. A file wins over the box when both are given.
        </p>
        <button type="submit" disabled={pending} style={{ width: 'auto', padding: '8px 18px', marginTop: 8 }}>
          {pending ? 'Importing…' : 'Import'}
        </button>
      </form>

      {tooBig ? <p className="err" style={{ marginTop: 12 }}>{tooBig}</p> : null}
      {state.kind === 'error' ? <p className="err" role="alert" style={{ marginTop: 12 }}>{state.message}</p> : null}
      {state.kind === 'done' ? <Report state={state} /> : null}
    </>
  )
}

function Report({ state }: { state: Extract<ContactImportState, { kind: 'done' }> }) {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  return (
    <div className="note" role="status" style={{ marginTop: 18 }}>
      <strong>
        Read {plural(state.rows, 'row', 'rows')}: {plural(state.inserted, 'new contact', 'new contacts')}
        {state.alreadyPresent > 0 ? `, ${state.alreadyPresent} already on file` : ''}.
      </strong>
      <p style={{ margin: '8px 0 0' }}>
        No consent was recorded for anyone, and nothing was sent.
        {state.alreadyPresent > 0 ? ' A person already on file was left exactly as they were.' : ''}
      </p>

      {state.unknownCompany.length > 0 ? (
        <>
          <p style={{ margin: '12px 0 4px' }}>
            <strong>{plural(state.unknownCompany.length, 'domain matches', 'domains match')} no company here</strong>, so
            nobody at {state.unknownCompany.length === 1 ? 'it' : 'them'} was imported.{' '}
            <a href="/companies/import">Import the companies</a>, then import this file again — everyone already
            imported is reported as present, not added twice.
          </p>
          <ul>
            {state.unknownCompany.slice(0, SHOW).map((d) => <li key={d}><code>{d}</code></li>)}
          </ul>
          {state.unknownCompany.length > SHOW ? <p className="muted">…and {state.unknownCompany.length - SHOW} more.</p> : null}
        </>
      ) : null}

      {state.phoneDropped.length > 0 ? (
        <p style={{ margin: '12px 0 4px' }}>
          <strong>{plural(state.phoneDropped.length, 'phone number was', 'phone numbers were')} left out</strong> — on{' '}
          {state.phoneDropped.length === 1 ? 'line' : 'lines'}{' '}
          {state.phoneDropped.slice(0, SHOW).map((p) => p.line).join(', ')}
          {state.phoneDropped.length > SHOW ? ` and ${state.phoneDropped.length - SHOW} more` : ''}. A number needs a{' '}
          <code>+</code> and its country code, or no opt-out could ever be matched to it. The rest of each row was
          imported unless it is refused below.
        </p>
      ) : null}

      {state.refused.length > 0 ? (
        <>
          <p style={{ margin: '12px 0 4px' }}>
            <strong>{plural(state.refused.length, 'row was', 'rows were')} refused:</strong>
          </p>
          <ul>
            {state.refused.slice(0, SHOW).map((r) => (
              <li key={r.line}>
                Line {r.line}: {r.message}
              </li>
            ))}
          </ul>
          {state.refused.length > SHOW ? <p className="muted">…and {state.refused.length - SHOW} more.</p> : null}
        </>
      ) : null}
    </div>
  )
}
