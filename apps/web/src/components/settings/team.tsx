'use client'

import { useState } from 'react'
import { When } from '@/components/when'

/**
 * Settings → Team.
 *
 * Grant, change a role, revoke, restore — and nothing that deletes. Every
 * rule is enforced by the routes and the statements behind them (the last
 * owner, revoking yourself, another org's address); this panel only decides
 * what to offer, and shows the route's sentence verbatim when it refuses.
 * Hiding a button is not access control.
 *
 * The grant form's error copy is deliberately the route's and nothing more.
 * "Already has access as member" is about this team's own roster; every
 * other refusal is one sentence that says nothing about whether the address
 * exists anywhere else on this deployment (§2.3).
 */

export interface TeamMemberView {
  readonly id: string
  readonly email: string
  readonly name: string | null
  readonly role: 'owner' | 'member'
  readonly grantedAt: string
  /** `email_verified`: the last completed magic link, or null for never. */
  readonly lastSignInAt: string | null
  readonly liveSessions: number
  readonly revokedAt: string | null
  readonly isViewer: boolean
}

export function TeamPanel({
  members,
  canWrite,
}: {
  members: readonly TeamMemberView[]
  canWrite: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'owner' | 'member'>('member')
  const [busy, setBusy] = useState<string | null>(null)
  const [grantError, setGrantError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const grant = async (): Promise<void> => {
    setBusy('grant')
    setGrantError('')
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: name.trim() || null, role }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setGrantError(body.error ?? 'That did not work.')
        return
      }
      window.location.reload()
    } catch {
      setGrantError('The request did not complete. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const change = async (m: TeamMemberView, body: Record<string, string>): Promise<void> => {
    setBusy(m.id)
    setErrors((e) => ({ ...e, [m.id]: '' }))
    try {
      const res = await fetch(`/api/users/${m.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const out = (await res.json().catch(() => ({}))) as { error?: string }
        setErrors((e) => ({ ...e, [m.id]: out.error ?? 'That did not work.' }))
        return
      }
      window.location.reload()
    } catch {
      setErrors((e) => ({ ...e, [m.id]: 'The request did not complete. Try again.' }))
    } finally {
      setBusy(null)
    }
  }

  const setMemberRole = (m: TeamMemberView, to: 'owner' | 'member'): void => {
    if (
      to === 'member' &&
      !window.confirm(
        m.isViewer
          ? 'Make yourself a member?\n\nYou will no longer be able to manage the team, connectors, agents, credentials or auto-send. Another owner can make you an owner again.'
          : `Make ${m.email} a member?\n\nThey will no longer be able to manage the team, connectors, agents, credentials or auto-send.`,
      )
    ) {
      return
    }
    void change(m, { action: 'role', role: to })
  }

  const revoke = (m: TeamMemberView): void => {
    if (
      !window.confirm(
        `Revoke access for ${m.email}?\n\n` +
          'They are signed out of every browser now and cannot sign in again until restored. ' +
          'Every approval and message they decided stays attributed to them.',
      )
    ) {
      return
    }
    void change(m, { action: 'revoke' })
  }

  const live = members.filter((m) => m.revokedAt === null)
  const revoked = members.filter((m) => m.revokedAt !== null)

  return (
    <>
      {canWrite ? (
        <div className="row-card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 6px' }}>Give somebody access</h3>
          <div className="two-up">
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="priya@youragency.com"
                autoComplete="off"
              />
            </label>
            <label>
              Name <span className="muted">(optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Priya Shah" autoComplete="off" />
            </label>
          </div>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'member')}>
              <option value="member">Member — works the pipeline, approves drafts, uses chat</option>
              <option value="owner">Owner — also manages the team, connectors, agents, credentials and auto-send</option>
            </select>
            <span className="hint">
              Nothing is sent from here. They sign in with this address on the sign-in page, and the
              link is mailed to them then.
            </span>
          </label>
          {grantError ? <div className="err-line">{grantError}</div> : null}
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busy === 'grant' || !email.trim()} onClick={() => void grant()}>
              {busy === 'grant' ? 'Granting…' : 'Grant access'}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>Only an owner can grant, change or revoke access.</p>
      )}

      <h2 style={{ fontSize: 15, margin: '18px 0 4px' }}>Members</h2>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Last signed in moves only when a magic link is completed — somebody who stays signed in keeps
        the date of their last link. Live sessions are browsers that can use the app right now without
        a new link.
      </p>
      <div className="rows">
        {live.map((m) => (
          <MemberRow
            key={m.id}
            m={m}
            canWrite={canWrite}
            busy={busy === m.id}
            error={errors[m.id] ?? ''}
            onRole={(to) => setMemberRole(m, to)}
            onRevoke={() => revoke(m)}
            onRestore={() => void change(m, { action: 'restore' })}
          />
        ))}
      </div>

      {revoked.length > 0 ? (
        <>
          <h2 style={{ fontSize: 15, margin: '22px 0 4px' }}>Revoked</h2>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Kept, not deleted, so that everything they approved, sent or handled still names them. They
            cannot sign in or start a chat turn.
          </p>
          <div className="rows">
            {revoked.map((m) => (
              <MemberRow
                key={m.id}
                m={m}
                canWrite={canWrite}
                busy={busy === m.id}
                error={errors[m.id] ?? ''}
                onRole={(to) => setMemberRole(m, to)}
                onRevoke={() => revoke(m)}
                onRestore={() => void change(m, { action: 'restore' })}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}

function MemberRow({
  m, canWrite, busy, error, onRole, onRevoke, onRestore,
}: {
  m: TeamMemberView
  canWrite: boolean
  busy: boolean
  error: string
  onRole: (to: 'owner' | 'member') => void
  onRevoke: () => void
  onRestore: () => void
}) {
  const isRevoked = m.revokedAt !== null
  return (
    <div className="row-card slim" style={isRevoked ? { opacity: 0.6 } : undefined}>
      <div className="row-head">
        <div>
          <code>{m.email}</code>
          {m.name ? <span style={{ marginLeft: 8 }}>{m.name}</span> : null}
          <span className="tag">{m.role}</span>
          {m.isViewer ? <span className="tag on">you</span> : null}
          {isRevoked ? <span className="tag warn">revoked</span> : null}
        </div>
        {canWrite ? (
          <div className="row-actions">
            {isRevoked ? (
              <button type="button" disabled={busy} onClick={onRestore}>Restore</button>
            ) : (
              <>
                {m.role === 'member' ? (
                  <button type="button" disabled={busy} onClick={() => onRole('owner')}>Make owner</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => onRole('member')}>Make member</button>
                )}
                {m.isViewer ? null : (
                  <button type="button" className="deny" disabled={busy} onClick={onRevoke}>Revoke</button>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Access granted <When iso={m.grantedAt} mode="date" />
        {' · '}
        Last signed in {m.lastSignInAt ? <When iso={m.lastSignInAt} /> : 'never'}
        {isRevoked ? null : (
          <>
            {' · '}
            {m.liveSessions === 0
              ? 'no live sessions'
              : `${m.liveSessions} live session${m.liveSessions === 1 ? '' : 's'}`}
          </>
        )}
        {m.revokedAt ? (
          <>
            {' · '}
            Revoked <When iso={m.revokedAt} mode="date" />
          </>
        ) : null}
      </div>
      {error ? <div className="err-line">{error}</div> : null}
    </div>
  )
}
