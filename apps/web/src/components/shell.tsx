import { can, type Role } from '@agency/core'
import { SearchBox } from '@/components/search-box'
import { orgIdentity } from '@/lib/org-identity'

export interface ShellUser {
  /** Needed by `can()` — authorisation is about a principal, not a display name. */
  readonly id: string
  readonly email?: string | null
  readonly role: Role
  readonly orgId: string
}

/**
 * The sidebar every signed-in page sits inside. Every link here is a page
 * that exists; a phase that has not been built is not shown as if it had.
 *
 * The list is written once, in final form, so that a feature adding a page
 * adds the page and not a line here. The settings pages — team, credentials,
 * the ICP, spend, mail, deployment — all light the one Settings link, since
 * they are one area with a landing page rather than six entries.
 */
export type ShellCurrent =
  | 'dashboard'
  | 'companies'
  | 'contacts'
  | 'inbox'
  | 'tasks'
  | 'chat'
  | 'approvals'
  | 'pipeline'
  | 'campaigns'
  | 'calls'
  | 'suppressions'
  | 'compliance'
  | 'audit'
  | 'settings'
  | 'connectors'
  | 'agents'
  | 'team'
  | 'credentials'
  | 'icp'
  | 'spend'
  | 'mail'
  | 'deployment'

const SETTINGS_PAGES: ReadonlySet<ShellCurrent> = new Set<ShellCurrent>([
  'settings', 'team', 'credentials', 'icp', 'spend', 'mail', 'deployment',
])

/**
 * The subtitle under "Agency OS" is the organisation's own name, read here
 * from `orgs.name` and never handed in by a page. It used to be a prop, and
 * most pages filled it with the active ICP's label — the name of a scoring
 * profile — while the dashboard and the settings area filled it with the
 * org's, so the sidebar named a different thing depending on the page. An
 * async server component may read the database; `orgIdentity` is
 * `server-only`, so Shell can never be pulled into a client bundle either.
 */
export async function Shell({
  user, current, children, signOut, pendingApprovals = 0,
}: {
  user: ShellUser
  current: ShellCurrent
  children: React.ReactNode
  signOut: () => Promise<void>
  /**
   * §5.4's `notifyTeam` is this number, plus the row and the card. Phase 2
   * ships no send path, and §8.4 says there must be exactly one — so adding a
   * second here, to notify about the first, would be the joke writing itself.
   */
  pendingApprovals?: number
}): Promise<React.ReactNode> {
  const org = await orgIdentity(user.orgId)
  const on = (page: ShellCurrent): string | undefined => (current === page ? 'on' : undefined)
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Agency OS</div>
        <div className="brand-sub">{org.name}</div>

        <SearchBox />

        <nav className="nav">
          <a href="/" className={on('dashboard')}>Dashboard</a>
          <a href="/companies" className={on('companies')}>Companies</a>
          <a href="/contacts" className={on('contacts')}>Contacts</a>
          <a href="/inbox" className={on('inbox')}>Inbox</a>
          <a href="/tasks" className={on('tasks')}>Tasks</a>
          <a href="/chat" className={on('chat')}>Chat</a>
          <a href="/approvals" className={on('approvals')}>
            Approvals
            {pendingApprovals > 0 ? <em className="badge">{pendingApprovals}</em> : null}
          </a>
          <a href="/pipeline" className={on('pipeline')}>Pipeline</a>
          <a href="/campaigns" className={on('campaigns')}>Campaigns</a>
          <a href="/calls" className={on('calls')}>Calls</a>
          <a href="/suppressions" className={on('suppressions')}>Suppressions</a>
          <a href="/compliance" className={on('compliance')}>Compliance</a>
          <a href="/audit" className={on('audit')}>Audit</a>
          <a href="/settings" className={SETTINGS_PAGES.has(current) ? 'on' : undefined}>Settings</a>
          <a href="/settings/connectors" className={on('connectors')}>Connectors</a>
          <a href="/settings/agents" className={on('agents')}>Agents</a>
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
