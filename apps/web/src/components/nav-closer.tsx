'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'

/**
 * On a phone the sidebar's menu opens over the page (a checkbox, `#nav-toggle`
 * in shell.tsx). Its links move between pages without reloading, so the menu
 * would stay open over the page it opened; this folds it away whenever the
 * page changes.
 */
export function NavCloser() {
  const pathname = usePathname()
  useEffect(() => {
    const toggle = document.getElementById('nav-toggle')
    if (toggle instanceof HTMLInputElement) toggle.checked = false
  }, [pathname])
  return null
}
