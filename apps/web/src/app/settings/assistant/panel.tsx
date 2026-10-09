'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { When } from '@/components/when'
import { knownTimeZones } from '@/lib/wall-clock'
import { ToastOn } from '../../../components/toast/toast-on'
import { BRIEF_LIMITS, BRIEF_STEPS, PLAYBOOK_ABOUT, PLAYBOOK_COST_NOTE, PLAYBOOK_OUTLINE, type Line } from './words'

/**
 * Settings → Assistant's two forms (0020): the playbook, and the morning
 * brief with its "Run it now".
 *
 * Every rule is the server's — `savePlaybook`, `saveBrief` and `requestBrief`
 * refuse with a sentence, and this renders the sentence. A member sees the
 * same page with every control read-only.
 */

export interface AssistantPanelProps {
  readonly canWrite: boolean
  readonly playbook: string
  readonly playbookMax: number
  readonly playbookSavedBy: string | null
  readonly playbookSavedAt: string | null
  readonly brief: {
    readonly enabled: boolean
    readonly at: string
    readonly timeZone: string
    readonly runsAs: string | null
  }
  readonly status: Line
  readonly worker: Line
  readonly latest: {
    readonly href: string | null
    readonly date: string | null
    readonly startedAt: string
    readonly owner: string | null
  } | null
}

const noteClass = (tone: Line['tone']): string => (tone === 'warn' ? 'note note-warn' : 'note')

/** Characters as Postgres and `savePlaybook` count them: code points, so an emoji is one. */
const chars = (s: string): number => [...s.replace(/\r\n?/g, '\n').trim()].length

export function AssistantPanel(props: AssistantPanelProps) {
  return (
    <>
      <PlaybookForm {...props} />
      <BriefForm {...props} />
    </>
  )
}

function PlaybookForm({ canWrite, playbook, playbookMax, playbookSavedBy, playbookSavedAt }: AssistantPanelProps) {
  const router = useRouter()
  const [text, setText] = useState(playbook)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const count = chars(text)
  const over = count > playbookMax
  const changed = text !== playbook

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setDone('')
    try {
      const res = await fetch('/api/settings/assistant/playbook', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playbook: text }),
      })
      const b = (await res.json().catch(() => ({}))) as { error?: string; chars?: number }
      if (!res.ok) {
        setError(b.error ?? 'That did not work.')
        return
      }
      setDone(
        b.chars === 0
          ? 'Saved. The playbook is empty, so the AI is told nothing about the agency from the next message on.'
          : 'Saved. The AI reads it from the next message on — in chat, in each helper and in the brief.',
      )
      router.refresh()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Playbook</h2>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 760 }}>{PLAYBOOK_ABOUT}</p>
      <div className="row-card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={!canWrite}
          rows={18}
          spellCheck
          aria-label="Playbook"
          placeholder={canWrite ? 'Nothing yet. Write what the agency sells, for whom, at what price, and how it writes.' : 'Nothing yet.'}
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5 }}
        />
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          <span style={over ? { color: 'var(--danger, #b42318)', fontWeight: 600 } : undefined}>
            {count.toLocaleString('en')} of {playbookMax.toLocaleString('en')} characters
          </span>
          {' · '}
          {PLAYBOOK_COST_NOTE}
          {playbookSavedAt ? (
            <>
              {' · '}Last saved{playbookSavedBy ? ` by ${playbookSavedBy}` : ''} <When iso={playbookSavedAt} />
            </>
          ) : null}
        </div>
        {canWrite ? (
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busy || over || !changed} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save playbook'}
            </button>
            {text.trim() === '' ? (
              <button type="button" className="linkish" onClick={() => setText(PLAYBOOK_OUTLINE)}>
                Start from an outline
              </button>
            ) : null}
            {changed && !busy ? (
              <button type="button" className="linkish" onClick={() => { setText(playbook); setError(''); setDone('') }}>
                Undo changes
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>Only an owner can change the playbook.</p>
        )}
        {error ? <div className="err-line">{error}</div> : null}
        <ToastOn message={done} />
      </div>
    </>
  )
}

function BriefForm({ canWrite, brief, status, worker, latest }: AssistantPanelProps) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(brief.enabled)
  const [at, setAt] = useState(brief.at)
  const [zone, setZone] = useState(brief.timeZone)
  // Browser-only, so set in an effect: Node and Chrome name some zones
  // differently, and a list in the first render is a hydration error.
  const [zones, setZones] = useState<string[]>([brief.timeZone])
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    const all = knownTimeZones()
    setZones(all.includes(brief.timeZone) ? all : [brief.timeZone, ...all])
  }, [brief.timeZone])

  const changed = enabled !== brief.enabled || at !== brief.at || zone !== brief.timeZone

  const call = async (kind: 'save' | 'run'): Promise<void> => {
    setBusy(kind)
    setError('')
    setDone('')
    try {
      const res =
        kind === 'save'
          ? await fetch('/api/settings/assistant/brief', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled, at, timeZone: zone }),
            })
          : await fetch('/api/settings/assistant/brief/run', { method: 'POST' })
      const b = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(b.error ?? 'That did not work.')
        return
      }
      setDone(
        kind === 'run'
          ? 'Asked. The worker starts it at its next look, within a minute, and it lands in the chat threads of the person it runs as. It takes a minute or two to write.'
          : enabled
            ? 'Saved. It runs every day at that time, as you.'
            : 'Saved. The morning brief is off.',
      )
      router.refresh()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2>Morning brief</h2>
      <div className={noteClass(status.tone)} style={{ marginBottom: 8 }}>
        <strong>{status.text}</strong>
      </div>
      <div className={noteClass(worker.tone)} style={{ marginBottom: 12 }}>{worker.text}</div>

      <p className="muted" style={{ fontSize: 13.5, maxWidth: 760, marginBottom: 6 }}>
        Once a day, the AI goes through the agency&apos;s records on its own and leaves a short brief in a chat thread:
      </p>
      <ol style={{ fontSize: 13.5, maxWidth: 760, marginTop: 0 }}>
        {BRIEF_STEPS.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 760 }}>{BRIEF_LIMITS}</p>

      <div className="row-card">
        <div className="two-up">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canWrite}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Write a brief every day
          </label>
          <span />
        </div>
        <div className="two-up">
          <label>
            At
            <input type="time" value={at} disabled={!canWrite} onChange={(e) => setAt(e.target.value)} required />
            <span className="hint">On a 24-hour clock. A worker asleep at this time writes it when it wakes, later that day.</span>
          </label>
          <label>
            Time zone
            <select value={zone} disabled={!canWrite} onChange={(e) => setZone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <span className="hint">The agency&apos;s own clock, not the worker&apos;s: the day turns over at midnight here.</span>
          </label>
        </div>
        {canWrite ? (
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busy !== null || !changed} onClick={() => void call('save')}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            {brief.enabled ? (
              <button
                type="button"
                disabled={busy !== null || changed}
                onClick={() => void call('run')}
                title={changed ? 'Save your changes first.' : 'Start a brief now, whatever the time. It counts as today’s.'}
              >
                {busy === 'run' ? 'Asking…' : 'Run it now'}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>Only an owner can change the morning brief or run it.</p>
        )}
        {error ? <div className="err-line">{error}</div> : null}
        <ToastOn message={done} />
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          Switched on, it runs as whoever saved it, in a thread of theirs titled “Morning brief · date”. It costs one chat
          turn a day, within the worker&apos;s per-turn budget. Run it now counts as that day&apos;s brief.
        </p>
      </div>

      {latest ? (
        <p style={{ fontSize: 13.5 }}>
          Newest brief{latest.date ? ` (for ${latest.date})` : ''}, started <When iso={latest.startedAt} />:{' '}
          {latest.href ? (
            <a href={latest.href}>open it in chat</a>
          ) : (
            <span className="muted">in {latest.owner ?? 'a teammate'}&apos;s chat threads, which only they can open.</span>
          )}
        </p>
      ) : null}
    </>
  )
}
