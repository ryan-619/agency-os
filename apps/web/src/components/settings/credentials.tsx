'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { When } from '@/components/when'
import { toast } from '../toast/toast'

/**
 * Settings → Credentials (PROMPT.md §2.3).
 *
 * Two lists. What is STORED — a label, when, under which key, and which
 * connector uses it — with Delete offered only on an orphan. And what each
 * CONNECTOR holds, with Re-enter. Neither list has a value in it, because the
 * page was never given one: the server reduces every row before it crosses,
 * and there is no route that returns a credential to a browser.
 *
 * A typed credential lives in this component's state until the request
 * leaves, and is cleared the moment it does, whether or not it worked — not
 * left in a field somebody walks away from.
 */

export interface CredentialView {
  readonly id: string
  readonly label: string
  readonly createdAt: string
  readonly keyVersion: number
  /** Encrypted under the key version the worker reads with. */
  readonly currentKey: boolean
  readonly usedBy: readonly { readonly connectorId: string; readonly name: string }[]
}

export interface ConnectorCredentialView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
  readonly hasCredential: boolean
  /** The label of what it holds now, when that row is this org's. */
  readonly credentialLabel: string | null
}

export function CredentialsPanel({
  credentials,
  connectors,
  canWrite,
  secretsConfigured,
  agentAvailable,
}: {
  credentials: readonly CredentialView[]
  connectors: readonly ConnectorCredentialView[]
  canWrite: boolean
  secretsConfigured: boolean
  agentAvailable: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)

  const remove = async (c: CredentialView): Promise<void> => {
    if (!window.confirm(`Delete "${c.label}"? It cannot be recovered; a connector that needs it again needs it re-entered.`)) return
    setBusy(c.id)
    setErrors((e) => ({ ...e, [c.id]: '' }))
    try {
      const res = await fetch(`/api/credentials/${c.id}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setErrors((e) => ({ ...e, [c.id]: body.error ?? 'That did not work.' }))
        return
      }
      toast.success('Credential deleted.')
      router.refresh()
    } catch {
      setErrors((e) => ({ ...e, [c.id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  const orphans = credentials.filter((c) => c.usedBy.length === 0).length

  return (
    <>
      {!secretsConfigured ? (
        <div className="note warn">
          <strong>SECRETS_KEY is not set on this deployment.</strong> Nothing can be re-entered, and
          nothing listed here can be read by anything — including the worker. Deleting an orphan still
          works, because it decrypts nothing.
        </div>
      ) : null}

      <h2>Stored</h2>
      {credentials.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5 }}>
          Nothing stored. A credential is added with a connector, or re-entered for one below.
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 12.5 }}>
          {credentials.length} stored
          {orphans > 0 ? `, ${orphans} orphaned` : ''}.
        </p>
      )}
      <div className="rows">
        {credentials.map((c) => {
          const error = errors[c.id]
          const orphan = c.usedBy.length === 0
          return (
            <div key={c.id} className="row-card slim">
              <div className="row-head">
                <div>
                  <strong>{c.label}</strong>
                  <span className="tag">key v{c.keyVersion}</span>
                  {c.currentKey ? null : <span className="tag warn">older key — re-enter it</span>}
                  {orphan ? <span className="tag warn">orphaned</span> : null}
                </div>
                {canWrite && orphan ? (
                  <div className="row-actions">
                    <button type="button" disabled={busy === c.id} onClick={() => void remove(c)}>
                      {busy === c.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Stored <When iso={c.createdAt} mode="date" />
                {' · '}
                {orphan ? (
                  'orphaned — left behind by a removed connector; safe to delete if nothing will reuse it.'
                ) : (
                  <>
                    used by{' '}
                    {c.usedBy.map((u, i) => (
                      <span key={u.connectorId}>
                        {i > 0 ? ', ' : null}
                        <a href="/settings/connectors">{u.name}</a>
                      </span>
                    ))}
                  </>
                )}
              </div>
              {error ? <div className="err-line">{error}</div> : null}
            </div>
          )
        })}
      </div>

      <h2 style={{ marginTop: 28 }}>Connectors</h2>
      {connectors.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5 }}>
          No connectors. Add one on <a href="/settings/connectors">Connectors</a>.
        </p>
      ) : null}
      <div className="rows">
        {connectors.map((k) => (
          <div key={k.id} className="row-card slim">
            <div className="row-head">
              <div>
                <strong>{k.name}</strong>
                <span className="tag">{k.kind}</span>
                {k.enabled ? <span className="tag on">enabled</span> : <span className="tag">disabled</span>}
              </div>
              {canWrite && editing !== k.id ? (
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={!secretsConfigured}
                    title={secretsConfigured ? undefined : 'SECRETS_KEY is not set on this deployment.'}
                    onClick={() => {
                      setDone((d) => ({ ...d, [k.id]: '' }))
                      setEditing(k.id)
                    }}
                  >
                    {k.hasCredential ? 'Re-enter credential' : 'Add a credential'}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {k.hasCredential ? `Holds “${k.credentialLabel ?? 'a credential'}”.` : 'No credential.'}
            </div>
            {done[k.id] ? <div className="ok-line">{done[k.id]}</div> : null}
            {editing === k.id ? (
              <ReEnter
                connector={k}
                agentAvailable={agentAvailable}
                onCancel={() => setEditing(null)}
                onDone={(message) => {
                  setEditing(null)
                  setDone((d) => ({ ...d, [k.id]: message }))
                  // The row's ok-line keeps the whole message: the connector is now disabled, and what to do next.
                  toast.success(`Credential stored for ${k.name}.`)
                  router.refresh()
                }}
              />
            ) : null}
          </div>
        ))}
      </div>

      {canWrite ? null : (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>
          Only an owner can re-enter or delete a credential.
        </p>
      )}
    </>
  )
}

function ReEnter({
  connector,
  agentAvailable,
  onCancel,
  onDone,
}: {
  connector: ConnectorCredentialView
  agentAvailable: boolean
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const [credential, setCredential] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const value = credential
    // Out of the field before the request is even answered.
    setCredential('')
    try {
      const res = await fetch(`/api/connectors/${connector.id}/credential`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: value, ...(label.trim() ? { label: label.trim() } : {}) }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; previousDeleted?: boolean }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return
      }
      const replaced = connector.hasCredential
        ? body.previousDeleted
          ? ' The old one was deleted.'
          : ' The old one is still used by another connector, so it was kept.'
        : ''
      onDone(
        `Stored.${replaced} ${connector.name} is now disabled — ` +
          (agentAvailable
            ? 'test it and enable it again on Connectors.'
            : 'test it and enable it again on Connectors, once the agent worker is reachable; testing needs it.'),
      )
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <label>
        New credential
        <input
          type="password"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          autoComplete="new-password"
        />
        <span className="hint">
          Encrypted before it is stored. It replaces what {connector.name} holds now, and the
          connector is disabled until you test and enable it again.
        </span>
      </label>
      <label>
        Label <span className="muted">(optional)</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`${connector.name} credential`}
          autoComplete="off"
          maxLength={120}
        />
        <span className="hint">What it is, in words — shown on this page and in the audit log. Never the value.</span>
      </label>
      {error ? <div className="err-line">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || credential.trim() === ''} onClick={() => void submit()}>
          {busy ? 'Storing…' : 'Store and disable'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setCredential('')
            onCancel()
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
