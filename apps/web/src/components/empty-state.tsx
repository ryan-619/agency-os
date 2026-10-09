import Link from 'next/link'
import type { ComponentType, ReactNode, SVGProps } from 'react'

export interface EmptyAction {
  readonly href: string
  readonly label: string
  /** The one thing to do first is dark; anything else beside it is plain. */
  readonly secondary?: boolean
}

/**
 * What a page with nothing on it yet says (2026-10-09): what will be here,
 * and the next step that puts it there, as a link to the page where that
 * step is taken. An empty page used to be one grey line; this is the first
 * thing a new team member sees on most pages, so it says what to do.
 *
 * Server-safe and client-safe alike — no hooks, no `@/` import — so a server
 * page and a client list both render it. Every action is a link to a page
 * that exists; nothing here does anything on its own.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  actions = [],
  compact = false,
}: {
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
  readonly title: string
  readonly children?: ReactNode
  readonly actions?: readonly EmptyAction[]
  /** Inside a card or a column, where a whole page's worth of space would be too much. */
  readonly compact?: boolean
}) {
  return (
    <div className={`empty${compact ? ' empty-compact' : ''}`} data-reveal>
      <div className="empty-icon" aria-hidden="true">
        <Icon />
      </div>
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
      {actions.length > 0 ? (
        <div className="empty-actions">
          {actions.map((a) => (
            <Link key={a.href} href={a.href} prefetch={false} className={a.secondary ? 'cta cta-secondary' : 'cta'}>
              {a.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}
