'use client'

import { useState } from 'react'
import { toast } from '../toast/toast'
import type { BrowserPreset, CatalogGroup } from './connector-presets'

/**
 * Settings → Connectors → Add from the catalog (§6).
 *
 * One click where one click is honest, and a sentence where it is not. A
 * preset is the same row the manual form would write — Install posts its
 * `{ name, kind, config, credential, credentialLabel }` to the existing
 * `POST /api/connectors` — so it inherits every rule that route enforces and
 * adds none of its own: created disabled, credential through `putSecret`,
 * enabled only after Test connection has answered.
 *
 * What this component knows about a preset is what the page let cross
 * (`connector-presets.ts`): no `auth` object, no verification source, never a
 * URL with a query string, and a decision already made about whether there is
 * an Install button at all. It imports only the TYPE from that module; a
 * value import would pull `@agency/db` into the browser bundle.
 */

const HEADING: Readonly<Record<CatalogGroup, { readonly title: string; readonly body: string }>> = {
  'works-today': {
    title: 'Works today — a Bearer token, or nothing',
    body: 'The worker sends the key as Authorization: Bearer, which is what these servers read. Some answer without one.',
  },
  'named-header': {
    title: 'A named header',
    body: 'These read the key from a header of their own. The preset names the header — a name, never the value.',
  },
  'worker-host': {
    title: 'Runs on the worker host',
    body:
      'Each runs a package on the agent worker, so adding one is installing software there. The worker ' +
      'removes its own API key from the process’s environment before it starts, but the process runs as ' +
      'the worker user and can read what that user can.',
  },
  'connect-flow': {
    title: 'Needs a connect flow — not built',
    body: 'These accept OAuth only, and this product has no connect flow. Listed so the answer is here; there is nothing to install.',
  },
}

const CLASS_LABEL: Readonly<Record<BrowserPreset['class'], string>> = {
  bearer: 'Bearer token — works today',
  none: 'No credential — works today',
  'named-header': 'Named header',
  'stdio-env': 'Runs on the worker host',
  'oauth-only': 'Needs a connect flow — not built',
}

/** What "Fill in the form" hands the manual form for a stdio preset that is not one click. */
export interface FormPrefill {
  readonly from: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly secretEnv: string
  readonly credentialLabel: string | null
}

type Probe = { readonly tools: readonly { name: string; description: string }[]; readonly message: string; readonly ok: boolean }

/** `.row-card input` does not reach inside a `.catalog-card`, so the field says it once here. */
const FIELD = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '6px 8px',
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontSize: 13,
} as const

export function ConnectorCatalog({
  presets,
  existingNames,
  agentAvailable,
  secretsConfigured,
  onUseForm,
}: {
  presets: readonly BrowserPreset[]
  existingNames: readonly string[]
  agentAvailable: boolean
  secretsConfigured: boolean
  onUseForm: (prefill: FormPrefill) => void
}) {
  // The page sends them grouped and in heading order; this keeps that order.
  const groups = [...new Set(presets.map((p) => p.group))]
  const taken = new Set(existingNames)

  return (
    <section style={{ marginTop: 20 }}>
      <h2>Add from the catalog</h2>
      <p className="muted" style={{ fontSize: 13.5 }}>
        Servers whose endpoints and credential handling were checked by hand. Each is added disabled;
        Test connection shows the tools it offers, and only then can it be enabled. None of its tools is
        pre-approved — every call asks a person.
      </p>
      <div className="note">
        <strong>Where a credential goes.</strong> It is encrypted before it is stored and decrypted by the
        worker at the start of each message, then handed to the claude process over its control channel —
        never on a command line, where anyone who can list processes on the worker host could read it. A
        server that runs on the worker host receives it in an environment variable, which that host shows to
        its own user and to root.
      </div>
      {!secretsConfigured ? (
        <div className="note warn">
          <strong>SECRETS_KEY is not set on this deployment.</strong> A preset that needs a key cannot be
          added: a credential is stored encrypted or not at all. Presets that work without one still can.
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group}>
          <div className="catalog-class">{HEADING[group].title}</div>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 4px' }}>{HEADING[group].body}</p>
          <div className="catalog">
            {presets
              .filter((p) => p.group === group)
              .map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  taken={taken}
                  agentAvailable={agentAvailable}
                  secretsConfigured={secretsConfigured}
                  onUseForm={onUseForm}
                />
              ))}
          </div>
        </div>
      ))}
    </section>
  )
}

/**
 * The server name to propose. Three pairs of presets share one (the two
 * Linears, the two Intercoms, the two Sentries), so the second of a pair
 * proposes its id rather than walking into the duplicate-name 409.
 */
function proposedName(p: BrowserPreset, taken: ReadonlySet<string>): string {
  if (!taken.has(p.name)) return p.name
  if (!taken.has(p.id)) return p.id
  return p.name
}

function PresetCard({
  preset: p,
  taken,
  agentAvailable,
  secretsConfigured,
  onUseForm,
}: {
  preset: BrowserPreset
  taken: ReadonlySet<string>
  agentAvailable: boolean
  secretsConfigured: boolean
  onUseForm: (prefill: FormPrefill) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(() => proposedName(p, taken))
  const [credential, setCredential] = useState('')
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [busy, setBusy] = useState<'install' | 'test' | 'enable' | null>(null)
  const [error, setError] = useState('')

  const blockedOnKey = p.needsCredential && !secretsConfigured

  const call = async (
    step: 'install' | 'test' | 'enable',
    run: () => Promise<Response>,
  ): Promise<Record<string, unknown> | null> => {
    setBusy(step)
    setError('')
    try {
      const res = await run()
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setError(String(body['error'] ?? 'That did not work.'))
        return null
      }
      return body
    } catch {
      setError('The request did not complete. Try again.')
      return null
    } finally {
      setBusy(null)
    }
  }

  const install = async (): Promise<void> => {
    const body = await call('install', () =>
      fetch('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          kind: p.kind,
          config: p.config,
          ...(credential && p.credentialLabel
            ? { credential, credentialLabel: `${name}: ${p.credentialLabel}` }
            : {}),
        }),
      }),
    )
    // Cleared either way: the key is in the request to the server and in this
    // component for no longer than that.
    setCredential('')
    if (body && typeof body['id'] === 'string') {
      setAdded({ id: body['id'], name: String(body['name'] ?? name) })
      setOpen(false)
      toast.success(`Added ${String(body['name'] ?? name)}, disabled.`)
    }
  }

  const test = async (id: string): Promise<void> => {
    const body = await call('test', () => fetch(`/api/connectors/${id}/probe`, { method: 'POST' }))
    if (!body) return
    setProbe({
      ok: body['ok'] === true,
      tools: (body['tools'] as Probe['tools'] | undefined) ?? [],
      message: String(body['message'] ?? ''),
    })
  }

  const enable = async (id: string): Promise<void> => {
    const body = await call('enable', () =>
      fetch(`/api/connectors/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    )
    // The list above is from page load; the reload is what puts the new row
    // in it, enabled. The tool list has been seen by now.
    if (body) window.location.reload()
  }

  return (
    <div className="catalog-card">
      <h3>{p.title}</h3>
      <div style={{ margin: '0 0 6px' }}>
        <span className="pill">{CLASS_LABEL[p.class]}</span>
        <span className="tag">{p.category}</span>
      </div>
      <ul className="muted" style={{ fontSize: 12.5, margin: '6px 0', paddingLeft: 16 }}>
        {p.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      {p.keyless ? (
        <span className="hint">
          <strong>Test connection cannot prove this key.</strong> The server answers before it checks one,
          so a green test says the endpoint is up; only a tool call says the key works.
        </span>
      ) : null}
      {p.sendTools.length > 0 ? (
        <span className="hint">
          {p.sendTools.includes('*') ? (
            'Every tool on this server sends or acts on another service. '
          ) : (
            <>
              Can send or act on another service:{' '}
              {p.sendTools.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ', ' : ''}
                  <code>{t}</code>
                </span>
              ))}
              .{' '}
            </>
          )}
          These ask a person every time, like every connector tool.
        </span>
      ) : null}
      {p.docsUrl ? (
        <span className="hint">
          <a href={p.docsUrl} target="_blank" rel="noreferrer noopener">
            Documentation
          </a>
        </span>
      ) : null}

      {!p.installable ? (
        <>
          <span className="hint">{p.notInstallable}</span>
          {p.group === 'worker-host' && p.config ? (
            <div className="row-actions" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => onUseForm(prefillFrom(p, proposedName(p, taken)))}>
                Fill in the form
              </button>
            </div>
          ) : null}
        </>
      ) : added ? (
        <>
          <div className="ok-line">Added, disabled. Test it, then enable it.</div>
          {!agentAvailable ? (
            <span className="hint">
              Test connection needs the agent worker, which this deployment cannot reach. It stays disabled
              until a test passes.
            </span>
          ) : null}
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="button" disabled={busy !== null || !agentAvailable} onClick={() => void test(added.id)}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            {probe?.ok ? (
              <button type="button" disabled={busy !== null} onClick={() => void enable(added.id)}>
                {busy === 'enable' ? 'Enabling…' : 'Enable'}
              </button>
            ) : null}
          </div>
          {probe ? (
            <div className={probe.ok ? 'probe ok' : 'probe'}>
              <div>{probe.message}</div>
              {probe.tools.length > 0 ? (
                <ul className="tools">
                  {probe.tools.map((t) => (
                    <li key={t.name}>
                      <code>{t.name}</code>
                      {t.description ? <span> — {t.description}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {probe.ok && p.keyless ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  This server answers without checking the key, so this does not prove it works.
                </div>
              ) : null}
              {probe.ok ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  Each of these asks a person for approval every time the agent calls it.
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : open ? (
        <div style={{ marginTop: 8 }}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" style={FIELD} />
            {taken.has(name) ? (
              <span className="hint">A connector called {name} already exists. Choose another name.</span>
            ) : (
              <span className="hint">
                Its tools will be called <code>mcp__{name || 'name'}__…</code>
              </span>
            )}
          </label>
          {p.credentialLabel ? (
            <label style={{ marginTop: 8 }}>
              {p.credentialLabel} {p.needsCredential ? null : <span className="muted">(optional)</span>}
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                autoComplete="new-password"
                disabled={!secretsConfigured}
                style={FIELD}
              />
              <span className="hint">
                {secretsConfigured
                  ? 'Encrypted before it is stored. Never written to the connector row, a log, or the agent’s context.'
                  : 'SECRETS_KEY is not set, so a key cannot be stored — it will not be stored any other way.'}
              </span>
            </label>
          ) : null}
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              disabled={busy !== null || !name || taken.has(name) || (p.needsCredential && !credential)}
              onClick={() => void install()}
            >
              {busy === 'install' ? 'Adding…' : 'Add, disabled'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {blockedOnKey ? (
            <span className="hint">Needs SECRETS_KEY on this deployment: its key is stored encrypted or not at all.</span>
          ) : null}
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="button" disabled={blockedOnKey} onClick={() => setOpen(true)}>
              Install
            </button>
          </div>
        </>
      )}
      {error ? <div className="err-line">{error}</div> : null}
    </div>
  )
}

function prefillFrom(p: BrowserPreset, name: string): FormPrefill {
  const config = (p.config ?? {}) as { command?: unknown; args?: unknown; secretEnv?: unknown }
  return {
    from: p.title,
    name,
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === 'string') : [],
    secretEnv: typeof config.secretEnv === 'string' ? config.secretEnv : '',
    credentialLabel: p.credentialLabel,
  }
}
