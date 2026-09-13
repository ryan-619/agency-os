'use client'

import { useState } from 'react'

/**
 * Settings → Connectors (PROMPT.md §6).
 *
 * "This screen is what 'add more tools later' actually means." So the flow it
 * enforces is add → test → enable, in that order, and the middle step is not
 * decorative: the tool list it returns is the only moment anyone sees what
 * they are about to let the agent reach. A server offering `delete_everything`
 * should be visible at the point of the decision, not discovered afterwards.
 *
 * The client half is deliberately thin — forms, fetches, and what to show
 * while a probe runs. Every rule lives in the routes, which is also where the
 * authorisation is: `can()` hides the controls below, and `assertCan()`
 * refuses the request, because hiding a button is not access control.
 */

export interface ConnectorView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
  readonly hasCredential: boolean
  readonly lastOkAt: string | null
  readonly lastError: string | null
  /** What the config says, with nothing that could hold a credential. */
  readonly summary: string
}

type Probe = { tools: readonly { name: string; description: string }[]; message: string; ok: boolean }

export function ConnectorsPanel({
  connectors,
  canWrite,
  agentAvailable,
  secretsConfigured,
}: {
  connectors: readonly ConnectorView[]
  canWrite: boolean
  agentAvailable: boolean
  secretsConfigured: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  /**
   * Connectors that answered during THIS visit.
   *
   * The server decides whether Enable is allowed (it refuses with a 409 until
   * `last_ok_at` is set), and the row's `lastOkAt` prop is from page load. So
   * a successful probe has to be remembered here, or the button it just
   * unlocked stays greyed out until a reload — and the reload is exactly what
   * must not happen, because it discards the tool list.
   */
  const [justPassed, setJustPassed] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)

  const act = async (id: string, run: () => Promise<Response>): Promise<void> => {
    setBusy(id)
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await run()
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setErrors((e) => ({ ...e, [id]: String(body['error'] ?? 'That did not work.') }))
        return
      }
      if ('tools' in body) {
        const ok = body['ok'] === true
        setProbes((p) => ({
          ...p,
          [id]: {
            ok,
            tools: (body['tools'] as Probe['tools']) ?? [],
            message: String(body['message'] ?? ''),
          },
        }))
        // Deliberately NO reload on success. The tool list is the reason this
        // button exists — it is the one moment anyone sees what they are about
        // to let the agent reach — and a reload would replace it with a
        // timestamp. The row's own state is updated in place instead.
        if (ok) setJustPassed((s) => new Set(s).add(id))
        return
      }
      window.location.reload()
    } catch {
      setErrors((e) => ({ ...e, [id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {!agentAvailable ? (
        <div className="note">
          <strong>The agent worker is not reachable.</strong> Connectors can still be added and
          edited, but Test connection needs the worker — it is what starts the session that asks a
          server what tools it has.
        </div>
      ) : null}

      <div className="rows">
        {connectors.length === 0 ? (
          <p className="muted" style={{ fontSize: 13.5 }}>
            No connectors yet. An MCP server added here gives the agent new tools in the very next
            chat message, with no restart.
          </p>
        ) : null}

        {connectors.map((c) => {
          const probe = probes[c.id]
          const error = errors[c.id]
          const tested = c.lastOkAt !== null || justPassed.has(c.id)
          return (
            <div key={c.id} className="row-card">
              <div className="row-head">
                <div>
                  <strong>{c.name}</strong>
                  <span className="tag">{c.kind}</span>
                  {c.enabled ? (
                    <span className="tag on">enabled</span>
                  ) : (
                    <span className="tag">disabled</span>
                  )}
                  {c.hasCredential ? <span className="tag">has credential</span> : null}
                </div>
                {canWrite ? (
                  <div className="row-actions">
                    <button
                      type="button"
                      disabled={busy === c.id || !agentAvailable}
                      onClick={() =>
                        void act(c.id, () => fetch(`/api/connectors/${c.id}/probe`, { method: 'POST' }))
                      }
                    >
                      {busy === c.id ? 'Testing…' : 'Test connection'}
                    </button>
                    <button
                      type="button"
                      // Disabling is never blocked. It is what a person
                      // reaches for when a connector is misbehaving, and a
                      // stop button with preconditions is not a stop button.
                      disabled={busy === c.id || (!c.enabled && !tested)}
                      title={
                        !c.enabled && !tested
                          ? 'Test the connection first — it has not answered yet.'
                          : undefined
                      }
                      onClick={() =>
                        void act(c.id, () =>
                          fetch(`/api/connectors/${c.id}`, {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ enabled: !c.enabled }),
                          }),
                        )
                      }
                    >
                      {c.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busy === c.id}
                      onClick={() => {
                        // A connector the agent is using disappears from the
                        // next turn. Worth one question.
                        if (!window.confirm(`Remove "${c.name}"? The agent loses its tools.`)) return
                        void act(c.id, () => fetch(`/api/connectors/${c.id}`, { method: 'DELETE' }))
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="muted" style={{ fontSize: 12.5 }}>{c.summary}</div>

              {c.lastOkAt ? (
                <div className="ok-line">Last answered {new Date(c.lastOkAt).toLocaleString()}</div>
              ) : justPassed.has(c.id) ? (
                <div className="ok-line">Answered just now.</div>
              ) : (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Never tested. It cannot be enabled until it answers once.
                </div>
              )}
              {c.lastError ? <div className="err-line">{c.lastError}</div> : null}
              {error ? <div className="err-line">{error}</div> : null}

              {probe ? (
                <div className={probe.ok ? 'probe ok' : 'probe'}>
                  <div>{probe.message}</div>
                  {probe.tools.length > 0 ? (
                    <>
                      {/*
                        The list §6 asks for, and the reason it matters: every
                        one of these needs a human on every call, so this is
                        what an owner is agreeing to.
                      */}
                      <ul className="tools">
                        {probe.tools.map((t) => (
                          <li key={t.name}>
                            <code>{t.name}</code>
                            {t.description ? <span> — {t.description}</span> : null}
                          </li>
                        ))}
                      </ul>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Each of these asks a person for approval every time the agent calls it.
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {canWrite ? (
        adding ? (
          <AddConnector secretsConfigured={secretsConfigured} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
            Add a connector
          </button>
        )
      ) : (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>
          Only an owner can add or change a connector.
        </p>
      )}
    </>
  )
}

function AddConnector({
  secretsConfigured,
  onCancel,
}: {
  secretsConfigured: boolean
  onCancel: () => void
}) {
  const [kind, setKind] = useState<'http' | 'sse' | 'stdio'>('http')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const config =
        kind === 'stdio'
          ? { command, args: args.split(/\s+/).filter(Boolean), env: {} }
          : { url, headers: {} }
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          kind,
          config,
          ...(credential ? { credential, credentialLabel: `${name} credential` } : {}),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(body.error ?? 'That did not work.')
        return
      }
      // The credential is in the response to nothing and in this component for
      // as long as the page lives. Cleared rather than left in a form field
      // somebody walks away from.
      setCredential('')
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 10px' }}>Add a connector</h3>

      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="apollo"
          autoComplete="off"
        />
        <span className="hint">
          Lower-case letters, digits and hyphens. It becomes part of every tool name:{' '}
          <code>mcp__{name || 'name'}__…</code>
        </span>
      </label>

      <label>
        Transport
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio (runs a command on the worker)</option>
        </select>
      </label>

      {kind === 'stdio' ? (
        <>
          <div className="note warn">
            <strong>A stdio connector runs a command on the agent worker.</strong> Adding one is
            installing software on that host, not configuring an integration. It inherits none of
            the worker&apos;s environment — no database URL, no API keys — but it runs as the worker
            user.
          </div>
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" autoComplete="off" />
          </label>
          <label>
            Arguments
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y some-mcp-server"
              autoComplete="off"
            />
            <span className="hint">Separated by spaces. Do not put a credential here — use the field below.</span>
          </label>
        </>
      ) : (
        <label>
          URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/v1"
            autoComplete="off"
          />
          <span className="hint">
            Must be reachable from the worker and outside its own network. Do not put a token in the
            query string — use the field below.
          </span>
        </label>
      )}

      <label>
        Credential <span className="muted">(optional)</span>
        <input
          type="password"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          autoComplete="new-password"
          disabled={!secretsConfigured}
        />
        <span className="hint">
          {secretsConfigured
            ? kind === 'stdio'
              ? 'Encrypted before it is stored, and passed to the command as MCP_SECRET. It is never written to the connector row, a log, or the agent’s context.'
              : 'Encrypted before it is stored, and sent as an Authorization: Bearer header. It is never written to the connector row, a log, or the agent’s context.'
            : 'SECRETS_KEY is not set on this deployment, so a credential cannot be stored encrypted — and it will not be stored any other way.'}
        </span>
      </label>

      {error ? <div className="err-line">{error}</div> : null}

      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || !name} onClick={() => void submit()}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        It is added disabled. Test the connection, look at the tools it offers, then enable it.
      </div>
    </div>
  )
}
