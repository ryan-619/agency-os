'use client'

import { useEffect } from 'react'
import { VIEW_AFTER_MS, type LinkKind } from '@/lib/link-view'

/**
 * Counts this page as read — once, after it has been visible for
 * `VIEW_AFTER_MS` in a browser that runs scripts, which a preview fetcher
 * does not (`lib/link-view.ts`). Renders nothing.
 */
export function ViewBeacon({ token, kind }: { token: string; kind: LinkKind }) {
  useEffect(() => {
    let sent = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const send = () => {
      if (sent) return
      sent = true
      void fetch(`/api/l/${token}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {})
    }
    const arm = () => {
      if (timer || sent || document.visibilityState !== 'visible') return
      timer = setTimeout(send, VIEW_AFTER_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') arm()
      else if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer) clearTimeout(timer)
    }
  }, [token, kind])
  return null
}
