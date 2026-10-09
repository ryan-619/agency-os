'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from '../../../components/toast/toast'
import { ToastOn } from '../../../components/toast/toast-on'
import {
  CATEGORY_HINT, IMPORT_OUTCOME_WORDS, NOT_SENDABLE_NOTE, TEMPLATE_CATEGORY_OPTIONS, TEMPLATE_CHANNEL_LABEL,
  bodySegments, categoryWords, type TemplateChannelName,
} from './words'

/**
 * The registered templates, one form to record one, and the DLT export
 * import (0019).
 *
 * Every rule is the server's: `templatesCreate` and `templatesImportDltCsv`
 * refuse with a sentence, and this renders the sentence. The one thing the
 * panel adds is the body read as text and `{#var#}` slots, highlighted, so a
 * person can see what a message drafted from it will ask them to fill.
 *
 * A template is never edited here — the portal issues a new id when a body
 * changes — so the only control on a row is On / Off.
 */

export interface TemplateRowView {
  readonly id: string
  readonly channel: TemplateChannelName
  readonly externalId: string
  readonly senderId: string
  readonly category: string
  readonly name: string | null
  readonly body: string
  readonly active: boolean
  readonly createdAt: string
  readonly slots: number
}

interface ImportLine {
  readonly line: number
  readonly externalId: string | null
  readonly outcome: string
  readonly why?: string
}

interface ImportReport {
  readonly imported: number
  readonly alreadyPresent: number
  readonly skipped: number
  readonly refused: number
  readonly lines: readonly ImportLine[]
}

/** The client-side twin of the route's 1 MB limit, so a large file is refused with a sentence before it is sent. */
const IMPORT_MAX_BYTES = 1_000_000
/** A report longer than this is summarised; the counts stay exact. */
const SHOW_LINES = 200

export function TemplatesPanel({ templates, canWrite }: { templates: readonly TemplateRowView[]; canWrite: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const toggle = async (t: TemplateRowView): Promise<void> => {
    setBusy(t.id)
    setErrors((e) => ({ ...e, [t.id]: '' }))
    try {
      const res = await fetch(`/api/templates/${t.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: !t.active }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setErrors((e) => ({ ...e, [t.id]: b.error ?? 'That did not work.' }))
        return
      }
      // `changed` is false when the template was already in the state asked for.
      const answer = (await res.json().catch(() => ({}))) as { changed?: boolean }
      toast.success(
        answer.changed === false
          ? `Template ${t.externalId} was already ${t.active ? 'off' : 'on'}.`
          : `Template ${t.externalId} switched ${t.active ? 'off' : 'on'}.`,
      )
      router.refresh()
    } catch {
      setErrors((e) => ({ ...e, [t.id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2>Recorded templates</h2>
      {templates.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          None yet. Until an active SMS template is recorded here, no SMS can be drafted: the send path refuses a
          text that is not a registered template.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Template id</th>
              <th>Header</th>
              <th>Category</th>
              <th>Text</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>{TEMPLATE_CHANNEL_LABEL[t.channel]}</td>
                <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {t.externalId}
                  {t.name ? <div className="muted" style={{ fontFamily: 'inherit' }}>{t.name}</div> : null}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{t.senderId}</td>
                <td style={{ fontSize: 12.5 }} title={CATEGORY_HINT[t.category]}>{categoryWords(t.category)}</td>
                <td style={{ fontSize: 12.5, maxWidth: 420 }}>
                  <TemplateBody body={t.body} />
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                    {t.slots === 0 ? 'No variables.' : `${t.slots} variable${t.slots === 1 ? '' : 's'} to fill.`}
                    {t.channel !== 'sms' ? ` ${NOT_SENDABLE_NOTE[t.channel]}` : ''}
                  </div>
                </td>
                <td>
                  <span className={t.active ? 'tag on' : 'tag'}>{t.active ? 'on' : 'off'}</span>
                  {canWrite ? (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy === t.id}
                        onClick={() => void toggle(t)}
                        title={
                          t.active
                            ? 'Nothing new is drafted from it, and a draft already written from it is refused at sending.'
                            : 'Messages can be drafted from it again.'
                        }
                      >
                        {t.active ? 'Switch off' : 'Switch on'}
                      </button>
                    </div>
                  ) : null}
                  {errors[t.id] ? <div className="err-line">{errors[t.id]}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        A recorded template is never edited: the portal issues a new id when a template&apos;s words change, and a sent
        message names the words it was checked against. Switch the old one off and record the new one.
      </p>

      {canWrite ? (
        <>
          <h2>Import the DLT export</h2>
          <ImportForm onDone={() => router.refresh()} />
          <h2>Record one template</h2>
          <AddForm onDone={() => router.refresh()} />
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>Your role cannot record or switch templates.</p>
      )}
    </>
  )
}

/** The body, with each `{#…#}` slot marked. */
export function TemplateBody({ body }: { body: string }) {
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      {bodySegments(body).map((s, i) =>
        s.slot ? (
          <code key={i} className="tag" style={{ margin: 0 }}>
            {s.text}
          </code>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </span>
  )
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [channel, setChannel] = useState<TemplateChannelName>('sms')
  const [externalId, setExternalId] = useState('')
  const [senderId, setSenderId] = useState('')
  const [category, setCategory] = useState('service_explicit')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)

  const pickChannel = (c: TemplateChannelName) => {
    setChannel(c)
    const options = TEMPLATE_CATEGORY_OPTIONS[c]
    if (!options.includes(category)) setCategory(options[0] ?? '')
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setDone('')
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, externalId, senderId, category, body, name: name.trim() || null }),
      })
      const b = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(b.error ?? 'That did not work.')
        return
      }
      setDone(`Recorded ${externalId.trim()}.`)
      setExternalId('')
      setName('')
      setBody('')
      onDone()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card">
      <div className="two-up">
        <label>
          Channel
          <select value={channel} onChange={(e) => pickChannel(e.target.value as TemplateChannelName)}>
            <option value="sms">SMS (DLT)</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="voice">Voice</option>
          </select>
          {channel !== 'sms' ? <span className="hint">{NOT_SENDABLE_NOTE[channel]}</span> : null}
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {TEMPLATE_CATEGORY_OPTIONS[channel].map((c) => (
              <option key={c} value={c}>
                {categoryWords(c)}
              </option>
            ))}
          </select>
          {CATEGORY_HINT[category] && channel !== 'whatsapp' ? <span className="hint">{CATEGORY_HINT[category]}</span> : null}
        </label>
      </div>
      <div className="two-up">
        <label>
          {channel === 'whatsapp' ? 'Template name' : 'DLT template id'}
          <input value={externalId} onChange={(e) => setExternalId(e.target.value)} maxLength={128} autoComplete="off" spellCheck={false} />
          <span className="hint">Exactly as the portal issued it. A long number copied through a spreadsheet loses digits.</span>
        </label>
        <label>
          {channel === 'sms' ? 'Header (sender id)' : 'Sender'}
          <input value={senderId} onChange={(e) => setSenderId(e.target.value)} maxLength={32} autoComplete="off" spellCheck={false} />
          {channel === 'sms' ? <span className="hint">The six-character header registered with this template, like ACMEIN.</span> : null}
        </label>
      </div>
      <label>
        Name <span className="muted">(optional, for this page)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" />
      </label>
      <label>
        Text, exactly as registered
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} spellCheck={false} />
        <span className="hint">
          Keep every <code>{'{#var#}'}</code> where the portal has it; each is filled per message, up to 30 characters.
          Spacing and punctuation count — the operator compares the message with this text exactly.
        </span>
      </label>
      {body ? (
        <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>
          Reads as: <TemplateBody body={body} />
        </div>
      ) : null}
      {error ? <div className="err-line">{error}</div> : null}
      <ToastOn message={done} />
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || !externalId.trim() || !senderId.trim() || !body.trim()} onClick={() => void submit()}>
          {busy ? 'Recording…' : 'Record template'}
        </button>
      </div>
    </div>
  )
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError('')
    setReport(null)
    // A file wins over the box when both are given, as on the contacts import.
    const payload: Blob = file ?? new Blob([pasted], { type: 'text/csv;charset=utf-8' })
    if (payload.size > IMPORT_MAX_BYTES) {
      setError(`That is ${(payload.size / 1_000_000).toFixed(1)} MB; one import takes up to 1 MB. Split the file and import each part.`)
      return
    }
    setBusy(true)
    try {
      // The bytes as they are: the server decodes them as strict UTF-8 and
      // refuses a file that is not, rather than the browser guessing.
      const res = await fetch('/api/templates/import', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: payload,
      })
      const b = (await res.json().catch(() => ({}))) as Partial<ImportReport> & { error?: string }
      if (!res.ok || !Array.isArray(b.lines)) {
        setError(b.error ?? 'The import did not complete.')
        return
      }
      setReport(b as ImportReport)
      if ((b.imported ?? 0) > 0) onDone()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card">
      <p style={{ margin: '0 0 8px', fontSize: 13 }}>
        Export the approved templates from the DLT portal as CSV. The first line must name the columns — a template
        id, a header, a category and the text; a status column, when there is one, imports only approved templates.
        Each line is imported, recognised as already recorded, skipped or refused with the reason; importing the same
        file again changes nothing.
      </p>
      <label>
        The export (CSV, UTF-8)
        <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label>
        …or paste its rows, header first
        <textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} />
      </label>
      {error ? <div className="err-line">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || (!file && !pasted.trim())} onClick={() => void submit()}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
      {report ? (
        <div className="note" role="status" style={{ marginTop: 12 }}>
          <strong>
            {report.imported} imported · {report.alreadyPresent} already recorded · {report.skipped} skipped ·{' '}
            {report.refused} refused
          </strong>
          {report.lines.length > 0 ? (
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Template id</th>
                  <th>Outcome</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.slice(0, SHOW_LINES).map((l) => (
                  <tr key={l.line}>
                    <td>{l.line}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{l.externalId ?? '—'}</td>
                    <td>
                      <span className={l.outcome === 'imported' ? 'tag on' : l.outcome === 'refused' ? 'tag warn' : 'tag'}>
                        {IMPORT_OUTCOME_WORDS[l.outcome] ?? l.outcome}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{l.why ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {report.lines.length > SHOW_LINES ? (
            <p className="muted" style={{ margin: '6px 0 0' }}>…and {report.lines.length - SHOW_LINES} more lines.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
