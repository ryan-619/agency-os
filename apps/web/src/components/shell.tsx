import { can, type Role } from '@agency/core'

export interface ShellUser {
  /** Needed by `can()` — authorisation is about a principal, not a display name. */
  readonly id: string
  readonly email?: string | null
  readonly role: Role
  readonly orgId: string
}

/**
 * The sidebar every signed-in page sits inside. Phases that have not been
 * built are shown but not linked — an honest map of the product, rather than
 * a nav that pretends.
 */
export function Shell({
  user, orgName, current, children, signOut, pendingApprovals = 0,
}: {
  user: ShellUser
  orgName: string
  current: 'dashboard' | 'companies' | 'chat' | 'approvals'
  children: React.ReactNode
  signOut: () => Promise<void>
  /**
   * §5.4's `notifyTeam` is this number, plus the row and the card. Phase 2
   * ships no send path, and §8.4 says there must be exactly one — so adding a
   * second here, to notify about the first, would be the joke writing itself.
   */
  pendingApprovals?: number
}) {
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Agency OS</div>
        <div className="brand-sub">{orgName}</div>

        <nav className="nav">
          <a href="/" className={current === 'dashboard' ? 'on' : undefined}>Dashboard</a>
          <a href="/companies" className={current === 'companies' ? 'on' : undefined}>Companies</a>
          <a href="/chat" className={current === 'chat' ? 'on' : undefined}>Chat</a>
          <a href="/approvals" className={current === 'approvals' ? 'on' : undefined}>
            Approvals
            {pendingApprovals > 0 ? <em className="badge">{pendingApprovals}</em> : null}
          </a>
          <span>Connectors <em className="phase-tag">phase 3</em></span>
          <span>Campaigns <em className="phase-tag">phase 4</em></span>
          <span>Pipeline <em className="phase-tag">phase 5</em></span>
        </nav>

        <div className="who">
          <div>{user.email}</div>
          <div style={{ marginTop: 5 }}>
            <span className="role">{user.role}</span>
            {can(user, 'connectors:write') ? null : (
              <span style={{ marginLeft: 6 }}>read-only settings</span>
            )}
          </div>
          <form action={signOut}>
            <button style={{ marginTop: 12, padding: '5px 10px', fontSize: 12.5 }}>Sign out</button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
