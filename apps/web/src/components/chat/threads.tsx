'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { When } from '@/components/when'
import { toast } from '../toast/toast'

/**
 * The thread list beside the chat panel (PROMPT.md §8.1).
 *
 * Start, switch, rename, archive — and none of it needs the worker, because a
 * thread is a row. That matters on a deployment with no worker at all, where
 * the transcript of every earlier conversation is still worth reading and
 * this list is the only way to reach more than the newest one.
 *
 * Rename and Archive are offered on the thread that is open, not on every
 * row: in a column this narrow, a pair of buttons per line would leave no
 * room for the titles they act on.
 */

export interface ThreadView {
  readonly id: string
  readonly title: string | null
  readonly lastActiveAt: string
  /** A turn is in flight — archive is refused until it ends. */
  readonly running: boolean
  /** Summed by the database, as its text. Null when nothing was priced. */
  readonly costUsd: string | null
}

/** The same limit `chatRenameSession` enforces; the input stops at it first. */
const TITLE_MAX = 120

/** The global `button` is full-width for the sign-in form; a link-styled one in a row sizes to its label. */
const LINK = { width: 'auto' } as const

/** What each change confirms once the route has stored it. */
const CHANGED = {
  rename: 'Thread renamed.',
  archive: 'Thread archived: hidden from your list, not deleted.',
  restore: 'Thread put back in your list.',
} as const

export function ChatThreads({
  threads,
  current,
  canUse,
}: {
  threads: readonly ThreadView[]
  current: { readonly id: string; readonly title: string | null; readonly archived: boolean }
  canUse: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'new' | 'rename' | 'archive' | 'restore' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(current.title ?? '')

  const start = async (): Promise<void> => {
    setBusy('new')
    setError(null)
    try {
      const res = await fetch('/api/chat/sessions', { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok || !body.id) {
        setError(body.error === 'forbidden' ? 'Your role cannot start a thread.' : 'Could not start a thread. Try again.')
        return
      }
      toast.success('New thread started.')
      router.push(`/chat/${body.id}`)
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const change = async (
    kind: 'rename' | 'archive' | 'restore',
    patch: { title: string } | { archived: boolean },
  ): Promise<boolean> => {
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(`/api/chat/sessions/${current.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return false
      }
      toast.success(CHANGED[kind])
      router.refresh()
      return true
    } catch {
      setError('The request did not complete. Try again.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const rename = async (): Promise<void> => {
    if (await change('rename', { title: name })) setRenaming(false)
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Your threads</h2>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        Threads are per person; nobody else sees yours.
      </p>

      {canUse ? (
        <button type="button" style={{ marginTop: 0, padding: '6px 10px', fontSize: 13 }} disabled={busy !== null} onClick={() => void start()}>
          {busy === 'new' ? 'Starting…' : 'New thread'}
        </button>
      ) : null}

      {current.archived ? (
        <div className="note warn" style={{ fontSize: 12.5 }}>
          This thread is archived: hidden from your list, not deleted.{' '}
          {canUse ? (
            <button type="button" className="linkish" style={LINK} disabled={busy !== null} onClick={() => void change('restore', { archived: false })}>
              {busy === 'restore' ? 'Restoring…' : 'Put it back in the list'}
            </button>
          ) : null}
        </div>
      ) : null}

      {threads.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Nothing in the list.</p>
      ) : (
        <nav aria-label="Your threads" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 12 }}>
          {threads.map((t) => {
            const on = t.id === current.id
            return (
              <div
                key={t.id}
                style={{
                  borderRadius: 6,
                  padding: '6px 8px',
                  background: on ? 'var(--panel)' : undefined,
                  border: on ? '1px solid var(--line)' : '1px solid transparent',
                }}
              >
                <a
                  href={`/chat/${t.id}`}
                  aria-current={on ? 'page' : undefined}
                  style={{
                    display: 'block', fontSize: 13.5, color: 'var(--ink)', textDecoration: 'none',
                    fontWeight: on ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={t.title ?? undefined}
                >
                  {t.running ? (
                    <span
                      title="The agent is working in this thread"
                      aria-label="running"
                      style={{
                        display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                        background: 'var(--accent)', marginRight: 6, verticalAlign: 'middle',
                      }}
                    />
                  ) : null}
                  {t.title ?? (
                    <span className="muted">
                      Untitled · <When iso={t.lastActiveAt} mode="date" />
                    </span>
                  )}
                </a>
                {/* An untitled thread already shows its date in the title line. */}
                {t.title !== null || t.costUsd !== null ? (
                  <div className="muted" style={{ fontSize: 11.5, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                    {t.title !== null ? <When iso={t.lastActiveAt} mode="date" /> : <span />}
                    {t.costUsd !== null ? <span title="What this thread has cost so far">${dollars(t.costUsd)}</span> : null}
                  </div>
                ) : null}

                {on && canUse && !renaming ? (
                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    <button
                      type="button"
                      className="linkish"
                      style={LINK}
                      disabled={busy !== null}
                      onClick={() => {
                        setName(current.title ?? '')
                        setError(null)
                        setRenaming(true)
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="linkish"
                      style={LINK}
                      disabled={busy !== null || t.running}
                      title={t.running ? 'The agent is working in this thread; archive it once the turn ends.' : 'Hidden from this list, not deleted.'}
                      onClick={() => void change('archive', { archived: true })}
                    >
                      {busy === 'archive' ? 'Archiving…' : 'Archive'}
                    </button>
                  </div>
                ) : null}

                {on && renaming ? (
                  <form
                    style={{ marginTop: 6 }}
                    onSubmit={(e) => {
                      e.preventDefault()
                      void rename()
                    }}
                  >
                    <input
                      aria-label="Thread name"
                      value={name}
                      maxLength={TITLE_MAX}
                      autoFocus
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                      style={{
                        width: '100%', padding: '5px 8px', fontSize: 13, border: '1px solid var(--line)',
                        borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                      <button type="submit" className="linkish" style={LINK} disabled={busy !== null || !name.trim()}>
                        {busy === 'rename' ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="linkish" style={LINK} onClick={() => setRenaming(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            )
          })}
        </nav>
      )}

      {error ? <div className="err-line">{error}</div> : null}
    </div>
  )
}

/** Dollars at the precision worth reading: cents, or four places below a cent. */
function dollars(usd: string): string {
  const n = Number.parseFloat(usd)
  return Number.isFinite(n) ? n.toFixed(n < 0.01 ? 4 : 2) : usd
}
