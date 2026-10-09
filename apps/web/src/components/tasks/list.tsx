'use client'

import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import { EmptyState } from '../empty-state'
import { When } from '@/components/when'
import { toast } from '../toast/toast'
import { ToastOn } from '../toast/toast-on'

/**
 * Tasks as a person works them: tick one off, hand it to somebody, move its
 * date. Used by /tasks and by the tasks card on a company page.
 *
 * Nothing here sends anything. A task is a reminder to a person; the
 * templates create reminders and nothing else, and their buttons say so.
 *
 * Due dates are DAYS to the person choosing them, and instants to the
 * database. A day picked here becomes the end of that day in the browser's
 * own zone — "due on the 20th" is overdue once the 20th is over where the
 * person who set it lives, not at midnight UTC. The picker is never
 * pre-filled from the stored instant: which local day an instant falls on
 * differs between the server's render and the browser's, and that is a
 * hydration error (see <When>).
 */

export interface TaskItem {
  readonly id: string
  readonly title: string
  readonly detail: string | null
  readonly kind: string
  readonly companyDomain: string | null
  readonly companyName: string | null
  readonly assigneeUserId: string | null
  readonly assigneeLabel: string | null
  readonly dueAt: string | null
  readonly doneAt: string | null
  /** Decided on the server, from the same rule `tasksCounts` uses. */
  readonly overdue: boolean
  /** What came of a done call or visit (0027); absent on every other task. */
  readonly outcome?: string | null
}

/** The outcomes a call or a visit can end with (0027), as /tasks offers them — held equal to the database's by a test. */
export const OUTCOME_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'reached', label: 'Reached them' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'busy', label: 'Busy — try later' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'call_back', label: 'Call back on a day…' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'asked_to_stop', label: 'Asked not to be called' },
]
const OUTCOME_WORDS: Readonly<Record<string, string>> = Object.fromEntries(OUTCOME_OPTIONS.map((o) => [o.value, o.label.replace(/…$/, '')]))

export interface TeamMember {
  readonly id: string
  readonly label: string
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  kickoff: 'kickoff',
  renewal: 'renewal',
  linkedin_send: 'LinkedIn step',
  // 0022: a person's acts — a call from their own phone, a visit on foot.
  call: 'call',
  visit: 'visit',
}

/** The end of a picked day, in the browser's zone, as an instant. */
function endOfLocalDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const at = new Date(`${day}T23:59:00`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * What a toast says once a task change has landed. Never the assignee's
 * label: a teammate with no name on record is labelled by their address.
 */
function taskChangeWords(body: Record<string, unknown>): string {
  switch (body.action) {
    case 'done':
      return 'Task done.'
    case 'reopen':
      return 'Task reopened.'
    case 'due':
      return body.dueAt ? 'Due date set.' : 'Due date cleared.'
    case 'assign':
      return body.assigneeUserId ? 'Task assigned.' : 'Task unassigned.'
    case 'outcome':
      return body.outcome === 'asked_to_stop'
        ? 'Done — the number is on the suppression list.'
        : body.outcome === 'call_back'
          ? 'Done — the next call is a task on that day.'
          : 'Done.'
    default:
      return 'Saved.'
  }
}

async function send(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<{ ok: true; out: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: typeof out.error === 'string' ? out.error : 'That did not work.' }
    return { ok: true, out }
  } catch {
    return { ok: false, error: 'The request did not complete. Try again.' }
  }
}

export function TaskList({
  tasks,
  team,
  canWrite,
  showCompany = true,
  empty = 'Nothing here.',
}: {
  tasks: readonly TaskItem[]
  team: readonly TeamMember[]
  canWrite: boolean
  showCompany?: boolean
  empty?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingDue, setEditingDue] = useState<string | null>(null)

  const patch = async (id: string, body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await send(`/api/tasks/${id}`, 'PATCH', body)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    toast.success(taskChangeWords(body))
    window.location.reload()
  }

  if (tasks.length === 0) return <EmptyState icon={ListChecks} title={empty.replace(/\.$/, '')} compact />

  return (
    <div>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      {tasks.map((t) => {
        const done = t.doneAt !== null
        const step = t.kind === 'linkedin_send'
        const known = t.assigneeUserId === null || team.some((m) => m.id === t.assigneeUserId)
        return (
          <div key={t.id} className="task-row">
            <div style={{ flex: '0 0 auto', minWidth: 62 }}>
              {canWrite && !step ? (
                done ? (
                  <button type="button" className="linkish" disabled={busy} onClick={() => void patch(t.id, { action: 'reopen' })}>
                    Reopen
                  </button>
                ) : t.kind === 'call' || t.kind === 'visit' ? (
                  <select
                    aria-label="Done — what happened?"
                    disabled={busy}
                    value=""
                    style={{ fontSize: 12, padding: '3px 6px' }}
                    onChange={(e) => {
                      const outcome = e.target.value
                      if (!outcome) return
                      if (outcome === 'call_back') {
                        const day = window.prompt('Call back on which day? (YYYY-MM-DD)')
                        if (!day) return
                        void patch(t.id, { action: 'outcome', outcome, callBackOn: day.trim() })
                        return
                      }
                      if (outcome === 'asked_to_stop' && !window.confirm('They asked not to be called: the number goes on the suppression list first. Continue?')) return
                      void patch(t.id, { action: 'outcome', outcome })
                    }}
                  >
                    <option value="">Done — what happened?</option>
                    {OUTCOME_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    style={{ padding: '3px 9px', fontSize: 12 }}
                    onClick={() => void patch(t.id, { action: 'done' })}
                  >
                    Done
                  </button>
                )
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>{done ? 'done' : 'open'}</span>
              )}
            </div>

            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <span className={done ? 'task-done' : undefined}>{t.title}</span>
              {KIND_LABEL[t.kind] ? <span className="tag">{KIND_LABEL[t.kind]}</span> : null}
              {t.outcome ? <span className="tag">{OUTCOME_WORDS[t.outcome] ?? t.outcome}</span> : null}
              {showCompany && t.companyDomain ? (
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                  <a href={`/companies/${encodeURIComponent(t.companyDomain)}`}>{t.companyName ?? t.companyDomain}</a>
                </span>
              ) : null}
              {t.detail ? <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{t.detail}</div> : null}
            </div>

            <div style={{ flex: '0 0 auto', fontSize: 12.5, textAlign: 'right' }}>
              {t.dueAt ? (
                <span className={t.overdue ? 'task-overdue' : 'muted'}>
                  {t.overdue ? 'overdue · ' : 'due '}
                  <When iso={t.dueAt} mode="date" />
                </span>
              ) : (
                <span className="muted">no due date</span>
              )}
              {canWrite && !done ? (
                editingDue === t.id ? (
                  <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8, alignItems: 'center' }}>
                    <input
                      type="date"
                      aria-label="Due on"
                      style={{ fontSize: 12, padding: '2px 4px' }}
                      onChange={(e) => {
                        const at = endOfLocalDay(e.target.value)
                        if (at) void patch(t.id, { action: 'due', dueAt: at })
                      }}
                    />
                    {t.dueAt ? (
                      <button type="button" className="linkish" disabled={busy} onClick={() => void patch(t.id, { action: 'due', dueAt: null })}>
                        clear
                      </button>
                    ) : null}
                    <button type="button" className="linkish" onClick={() => setEditingDue(null)}>cancel</button>
                  </span>
                ) : (
                  <button type="button" className="linkish" style={{ marginLeft: 8 }} onClick={() => setEditingDue(t.id)}>
                    change
                  </button>
                )
              ) : null}
            </div>

            <div style={{ flex: '0 0 150px', fontSize: 12.5 }}>
              {canWrite ? (
                <select
                  aria-label="Assigned to"
                  value={t.assigneeUserId ?? ''}
                  disabled={busy}
                  style={{ width: '100%', fontSize: 12.5 }}
                  onChange={(e) => void patch(t.id, { action: 'assign', assigneeUserId: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {!known ? <option value={t.assigneeUserId ?? ''}>{t.assigneeLabel ?? 'a former teammate'}</option> : null}
                  {team.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              ) : (
                <span className="muted">{t.assigneeLabel ?? 'unassigned'}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** A plain to-do, optionally on a company. The only kind a person types. */
export function NewTaskForm({
  team,
  currentUserId,
  companyId,
}: {
  team: readonly TeamMember[]
  currentUserId: string
  companyId?: string
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [assignee, setAssignee] = useState(team.some((m) => m.id === currentUserId) ? currentUserId : '')
  const [day, setDay] = useState('')
  const [kind, setKind] = useState<'todo' | 'call' | 'visit'>('todo')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" onClick={() => setOpen(true)}>New task</button>
      </div>
    )
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setError('A task needs a title.')
      return
    }
    const dueAt = day ? endOfLocalDay(day) : null
    if (day && !dueAt) {
      setError('That date could not be read.')
      return
    }
    setBusy(true)
    setError(null)
    const r = await send('/api/tasks', 'POST', {
      title: title.trim(),
      detail: detail.trim() || null,
      companyId: companyId ?? null,
      assigneeUserId: assignee || null,
      dueAt,
      kind,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    toast.success('Task added.')
    window.location.reload()
  }

  return (
    <form className="row-card slim" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void submit() }}>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <label>
        Task
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Call Ana back about the questionnaire" required />
      </label>
      <label>
        Detail (optional)
        <textarea value={detail} rows={2} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <div className="two-up">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as 'todo' | 'call' | 'visit')}>
            <option value="todo">To-do</option>
            {companyId ? <option value="call">Call — from your own phone</option> : null}
            {companyId ? <option value="visit">Visit — in person</option> : null}
          </select>
          {kind === 'call' ? (
            <span className="hint">The system places no call. Check the number is not on the DND registry before calling.</span>
          ) : null}
        </label>
        <label>
          Assigned to
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label>
          Due on (optional)
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <span className="hint">Overdue once that day is over, in your timezone.</span>
        </label>
      </div>
      <p className="hint">Nothing is sent. A task is a reminder to a person.</p>
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy}>Add task</button>
        <button type="button" className="deny" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}

export interface TemplateState {
  /** Why the button cannot be pressed, or null when it can. */
  readonly blockedBecause: string | null
}

/**
 * The two template buttons. Each creates reminders for the person who
 * pressed it and nothing else — no stage change creates them, and nothing
 * is sent.
 */
export function TemplateButtons({
  companyId,
  dealId,
  kickoff,
  renewal,
}: {
  companyId: string
  dealId: string | null
  kickoff: TemplateState
  renewal: TemplateState
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const apply = async (template: 'kickoff' | 'renewal'): Promise<void> => {
    setBusy(true)
    setError(null)
    setDone(null)
    const r = await send('/api/tasks/templates', 'POST', { template, companyId, dealId })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setDone(typeof r.out.note === 'string' ? r.out.note : 'Created. Nothing was sent.')
    setTimeout(() => window.location.reload(), 600)
  }

  const rows: readonly [('kickoff' | 'renewal'), string, string, TemplateState][] = [
    ['kickoff', 'Kickoff', 'Kickoff — creates the five tasks the engagement starts with. Nothing is sent.', kickoff],
    ['renewal', 'Renewal', 'Renewal — creates the retest at six weeks and the re-engagement at eleven months. Nothing is sent.', renewal],
  ]

  return (
    <div style={{ marginTop: 14 }}>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
      <ToastOn message={done} />
      {rows.map(([template, label, copy, state]) => (
        <div key={template} className="row-actions" style={{ marginTop: 8, alignItems: 'center' }}>
          <button
            type="button"
            disabled={busy || state.blockedBecause !== null}
            title={state.blockedBecause ?? undefined}
            onClick={() => void apply(template)}
          >
            {label}
          </button>
          <span className="hint" style={{ marginTop: 0 }}>
            {copy}
            {state.blockedBecause ? <> <strong>{state.blockedBecause}</strong></> : null}
          </span>
        </div>
      ))}
    </div>
  )
}
