'use client'

import { useState } from 'react'

/**
 * Settings → Agents (PROMPT.md §7).
 *
 * A row here becomes a subagent the main agent can delegate to, at the start
 * of the next turn. Four fields reach the SDK — description, prompt, tools,
 * model — and the narrowing is enforced in the worker against a frozen
 * whitelist, because `AgentDefinition` also accepts `permissionMode` and a
 * settings form must never be a route to `bypassPermissions`.
 *
 * The description is the field people get wrong, so the form says what it is
 * for: the MODEL reads it to decide when to delegate. A vague one produces a
 * subagent that is either never used or used for everything.
 */

export interface AgentView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly tools: readonly string[]
  readonly model: string | null
  readonly enabled: boolean
}

const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'] as const

export function AgentsPanel({
  agents,
  availableTools,
  canWrite,
}: {
  agents: readonly AgentView[]
  /** Every tool name the agent could grant — the app's own plus every enabled connector's. */
  readonly availableTools: readonly string[]
  canWrite: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const act = async (id: string, run: () => Promise<Response>): Promise<void> => {
    setBusy(id)
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await run()
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrors((e) => ({ ...e, [id]: body.error ?? 'That did not work.' }))
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
      <div className="rows">
        {agents.length === 0 ? (
          <p className="muted" style={{ fontSize: 13.5 }}>No agents defined.</p>
        ) : null}

        {agents.map((a) =>
          editing === a.id ? (
            <AgentForm
              key={a.id}
              agent={a}
              availableTools={availableTools}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={a.id} className="row-card">
              <div className="row-head">
                <div>
                  <strong>{a.name}</strong>
                  <code className="tag">{a.slug}</code>
                  {a.model ? <span className="tag">{a.model}</span> : null}
                  {a.enabled ? (
                    <span className="tag on">enabled</span>
                  ) : (
                    <span className="tag">disabled</span>
                  )}
                </div>
                {canWrite ? (
                  <div className="row-actions">
                    <button type="button" onClick={() => setEditing(a.id)} disabled={busy === a.id}>
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() =>
                        void act(a.id, () =>
                          fetch(`/api/agents/${a.id}`, {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ enabled: !a.enabled }),
                          }),
                        )
                      }
                    >
                      {a.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => {
                        if (!window.confirm(`Remove the "${a.slug}" agent?`)) return
                        void act(a.id, () => fetch(`/api/agents/${a.id}`, { method: 'DELETE' }))
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="muted" style={{ fontSize: 12.5 }}>{a.description}</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                {a.tools.length > 0 ? (
                  a.tools.map((t) => (
                    <code key={t} className="tag">
                      {t}
                    </code>
                  ))
                ) : (
                  <span className="muted">
                    No tools listed, so it inherits every tool the main agent has.
                  </span>
                )}
              </div>
              {errors[a.id] ? <div className="err-line">{errors[a.id]}</div> : null}
            </div>
          ),
        )}
      </div>

      {canWrite ? (
        adding ? (
          <AgentForm availableTools={availableTools} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
            Add an agent
          </button>
        )
      ) : (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>
          Only an owner can add or change an agent.
        </p>
      )}
    </>
  )
}

function AgentForm({
  agent,
  availableTools,
  onCancel,
}: {
  agent?: AgentView
  availableTools: readonly string[]
  onCancel: () => void
}) {
  const [slug, setSlug] = useState(agent?.slug ?? '')
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [prompt, setPrompt] = useState(agent?.systemPrompt ?? '')
  const [tools, setTools] = useState<string[]>([...(agent?.tools ?? [])])
  const [model, setModel] = useState(agent?.model ?? 'sonnet')
  const [enabled, setEnabled] = useState(agent?.enabled ?? false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const payload = { name, description, systemPrompt: prompt, tools, model, enabled }
      const res = await fetch(agent ? `/api/agents/${agent.id}` : '/api/agents', {
        method: agent ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(agent ? payload : { ...payload, slug }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } catch {
      setError('The request did not complete. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row-card">
      <h3 style={{ margin: '0 0 10px' }}>{agent ? `Edit ${agent.slug}` : 'Add an agent'}</h3>

      {agent ? null : (
        <label>
          Slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="researcher" autoComplete="off" />
          <span className="hint">
            Lower-case letters, digits and hyphens. It cannot be changed later — it is how the model
            names this agent and what every audit entry about it refers to.
          </span>
        </label>
      )}

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" autoComplete="off" />
      </label>

      <label>
        When to use it
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Reads one company deeply and works out the angle. Use after it is qualified and before anyone writes to them."
        />
        <span className="hint">
          The MODEL reads this to decide when to delegate — it is not a label for people. Say what
          the agent is for and when it should be reached for; a vague one is either never used or
          used for everything.
        </span>
      </label>

      <label>
        Instructions
        <textarea
          rows={10}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="You work out how to open a conversation with one company, from the evidence the agency has already gathered…"
        />
        <span className="hint">
          Its system prompt. The §2.2 rule applies to whatever this agent says: it must never state
          a finding that was not observed, and the tools it is given already refuse to return one.
        </span>
      </label>

      <label>
        Model
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="hint">
          <code>inherit</code> uses whatever the main agent is running. A cheaper model is usually
          right for narrow, mechanical work.
        </span>
      </label>

      <fieldset style={{ border: 0, padding: 0, margin: '10px 0 0' }}>
        <legend style={{ fontSize: 12.5, fontWeight: 600, padding: 0 }}>Tools</legend>
        <span className="hint" style={{ display: 'block', marginBottom: 6 }}>
          Tick nothing to let it inherit every tool the main agent has. Ticking narrows it — which
          is usually what you want, because a subagent with one job should not be able to do the
          others. High-risk tools still ask a person, whoever calls them.
        </span>
        <div className="tool-grid">
          {availableTools.map((t) => (
            <label key={t} className="tool-check">
              <input
                type="checkbox"
                checked={tools.includes(t)}
                onChange={(e) =>
                  setTools((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))
                }
              />
              <code>{t}</code>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="tool-check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled — the main agent can delegate to it from the next message
      </label>

      {error ? <div className="err-line">{error}</div> : null}

      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || !name || !description} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
