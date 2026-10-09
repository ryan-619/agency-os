import Link from 'next/link'
import type { ComponentType, SVGProps } from 'react'
import {
  Ban, BadgeCheck, Bot, Building, ContactRound, Inbox, LayoutDashboard, ListChecks, LogOut, Megaphone, Phone, Plug,
  ReceiptText, Route, ScrollText, Settings, ShieldCheck, Sparkles, SquareKanban, TrendingUp, Workflow,
} from 'lucide-react'
import { can, type Role } from '@agency/core'
import { MainFrame } from '@/components/motion/main-frame'
import { NavIndicator } from '@/components/motion/nav-indicator'
import { NavCloser } from '@/components/nav-closer'
import { SearchBox } from '@/components/search-box'
import { ThemeSwitch } from '@/components/theme/theme-switch'
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
  | 'quotes'
  | 'campaigns'
  | 'calls'
  | 'suppressions'
  | 'compliance'
  | 'audit'
  | 'settings'
  | 'assistant'
  | 'connectors'
  | 'agents'
  | 'team'
  | 'credentials'
  | 'icp'
  | 'spend'
  | 'mail'
  | 'deployment'
  | 'profile'
  | 'night'
  | 'visits'
  | 'insights'

const SETTINGS_PAGES: ReadonlySet<ShellCurrent> = new Set<ShellCurrent>([
  'settings', 'team', 'credentials', 'icp', 'spend', 'mail', 'deployment', 'profile', 'night',
])

type Icon = ComponentType<SVGProps<SVGSVGElement>>
interface NavItem {
  readonly href: string
  readonly page: ShellCurrent
  readonly label: string
  readonly icon: Icon
}

/**
 * The sidebar's pages in four groups (2026-10-09), each with an icon, in
 * the order they always had. A link is a client-side navigation — the
 * sidebar stays, only the page beside it changes — and prefetches nothing,
 * because every page here reads the database and twenty links in view
 * would read it twenty times for pages nobody opened.
 */
const NAV: ReadonlyArray<{ readonly group: string | null; readonly items: readonly NavItem[] }> = [
  { group: null, items: [{ href: '/', page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    group: 'Work',
    items: [
      { href: '/companies', page: 'companies', label: 'Companies', icon: Building },
      { href: '/contacts', page: 'contacts', label: 'Contacts', icon: ContactRound },
      { href: '/inbox', page: 'inbox', label: 'Inbox', icon: Inbox },
      { href: '/tasks', page: 'tasks', label: 'Tasks', icon: ListChecks },
      { href: '/visits', page: 'visits', label: 'Visits', icon: Route },
      { href: '/chat', page: 'chat', label: 'Chat', icon: Sparkles },
      { href: '/approvals', page: 'approvals', label: 'Approvals', icon: BadgeCheck },
    ],
  },
  {
    group: 'Sell',
    items: [
      { href: '/pipeline', page: 'pipeline', label: 'Pipeline', icon: SquareKanban },
      { href: '/quotes', page: 'quotes', label: 'Quotes', icon: ReceiptText },
      { href: '/insights', page: 'insights', label: 'What’s working', icon: TrendingUp },
      { href: '/campaigns', page: 'campaigns', label: 'Campaigns', icon: Megaphone },
      { href: '/calls', page: 'calls', label: 'Calls', icon: Phone },
    ],
  },
  {
    group: 'Trust',
    items: [
      { href: '/suppressions', page: 'suppressions', label: 'Suppressions', icon: Ban },
      { href: '/compliance', page: 'compliance', label: 'Compliance', icon: ShieldCheck },
      { href: '/audit', page: 'audit', label: 'Audit', icon: ScrollText },
    ],
  },
  {
    group: 'Setup',
    items: [
      { href: '/settings', page: 'settings', label: 'Settings', icon: Settings },
      { href: '/settings/assistant', page: 'assistant', label: 'Assistant', icon: Bot },
      { href: '/settings/connectors', page: 'connectors', label: 'Connectors', icon: Plug },
      { href: '/settings/agents', page: 'agents', label: 'Agents', icon: Workflow },
    ],
  },
]

/** The app's mark, the same drawing as `app/icon.svg`. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#111827" />
      <path d="M256 96 416 416H344L256 232 168 416H96Z" fill="#ffffff" />
      <path d="M211 320H301L322 364H190Z" fill="#ffffff" />
      <circle cx="404" cy="124" r="36" fill="#22c55e" />
    </svg>
  )
}

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
  const lit = (page: ShellCurrent): boolean => (page === 'settings' ? SETTINGS_PAGES.has(current) : current === page)
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-top">
          <div className="brand-row">
            <BrandMark />
            <div>
              <div className="brand">Agency OS</div>
              <div className="brand-sub">{org.name}</div>
            </div>
          </div>
          {/* On a phone the menu folds away behind this, with no script: the checkbox below opens it. */}
          <label htmlFor="nav-toggle" className="nav-toggle-label">Menu</label>
        </div>
        <input type="checkbox" id="nav-toggle" className="nav-toggle" aria-label="Show the menu" />
        <NavCloser />
        <div className="side-body">
        <SearchBox />

        <nav className="nav">
          <NavIndicator />
          {NAV.map(({ group, items }) => (
            <div key={group ?? 'home'} className="nav-group">
              {group ? <div className="nav-heading">{group}</div> : null}
              {items.map(({ href, page, label, icon: Icon }) => (
                <Link key={href} href={href} prefetch={false} className={lit(page) ? 'on' : undefined} aria-current={lit(page) ? 'page' : undefined}>
                  <Icon aria-hidden="true" />
                  <span className="nav-label">{label}</span>
                  {page === 'approvals' && pendingApprovals > 0 ? <em className="badge">{pendingApprovals}</em> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="who">
          <div className="who-email">{user.email}</div>
          <div style={{ marginTop: 5 }}>
            <span className="role">{user.role}</span>
            {can(user, 'connectors:write') ? null : (
              <span style={{ marginLeft: 6 }}>read-only settings</span>
            )}
          </div>
          <ThemeSwitch />
          <form action={signOut}>
            <button className="signout">
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
        </div>
      </aside>
      <MainFrame>{children}</MainFrame>
    </div>
  )
}
