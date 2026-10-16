'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { DELETED_WORDS, sendDelete, type DeleteFailure, type DeleteKind } from '../../lib/delete-view'
import { toast } from '../toast/toast'

/**
 * One record's Delete (2026-10-15): a confirm that says what goes, the
 * route's DELETE, and — on a refusal — the writer's sentence under the
 * button, naming the act that does apply. Nothing is sent until the confirm
 * is answered yes.
 *
 * After a delete the page reloads with a pop-up naming the kind of record
 * (never the record: `DELETED_WORDS`), or goes to `then` when the page it
 * sits on is the record's own and no longer exists. `onDeleted` instead
 * lets a list drop the row itself, as the research card does.
 */
export function DeleteButton({
  url,
  kind,
  confirm,
  label = 'Delete',
  then,
  onDeleted,
  onRefused,
  className = 'linkish',
  title,
}: {
  url: string
  kind: DeleteKind
  /** The sentence the confirm shows. */
  confirm: string
  label?: string
  /** Where to go once it is gone; the page reloads when absent. */
  then?: string
  /** Drop the row in place; no reload. */
  onDeleted?: () => void
  /** A refusal, for a parent that says it somewhere else (the ledger points an owner at Erase). */
  onRefused?: (failure: DeleteFailure) => void
  className?: string
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    if (!window.confirm(confirm)) return
    setBusy(true)
    setError('')
    const r = await sendDelete(url, { kind })
    setBusy(false)
    if (!r.ok) {
      if (onRefused) onRefused(r.failure)
      else setError(r.failure.message)
      return
    }
    if (onDeleted) {
      toast.success(DELETED_WORDS[kind])
      onDeleted()
      return
    }
    toast.afterReload(DELETED_WORDS[kind])
    if (then) window.location.assign(then)
    else window.location.reload()
  }

  return (
    <>
      <button type="button" className={className} disabled={busy} title={title} onClick={() => void run()}>
        <Trash2 aria-hidden="true" style={{ width: 12, height: 12, verticalAlign: '-1px', marginRight: 4 }} />
        {busy ? 'Deleting…' : label}
      </button>
      {error ? <div className="err-line" role="alert">{error}</div> : null}
    </>
  )
}
