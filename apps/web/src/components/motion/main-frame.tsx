'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * The page's content area (2026-10-09). Keyed by the path, so moving to
 * another page mounts it afresh and the stylesheet's entrance (`.main > *`)
 * plays again; moving within one page — a filter, a sort, a refresh after an
 * action — keeps it, and keeps what was typed into it.
 */
export function MainFrame({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname()
  return (
    <main className="main" key={pathname}>
      {children}
    </main>
  )
}
