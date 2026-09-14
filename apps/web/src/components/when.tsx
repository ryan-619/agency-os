'use client'

import { useEffect, useState } from 'react'

/**
 * A timestamp in a client component, without a hydration error.
 *
 * `toLocaleString()` in a client component runs twice — once on the server,
 * once in the browser — with different locales and different zones, and
 * React reports the difference as a hydration failure on every page that
 * shows a date. (The first live check of the outreach screens had four.)
 *
 * So the first render is the same on both sides by construction: the ISO
 * value, trimmed, in UTC. The effect then replaces it with the viewer's own
 * format. The swap is visible for one frame and is the honest version of the
 * alternative, which is a text node that is wrong on one side and suppressed.
 */
export function When({ iso, mode = 'datetime' }: { iso: string; mode?: 'date' | 'time' | 'datetime' }) {
  const [text, setText] = useState(() => `${iso.slice(0, 16).replace('T', ' ')} UTC`)
  useEffect(() => {
    const d = new Date(iso)
    setText(mode === 'date' ? d.toLocaleDateString() : mode === 'time' ? d.toLocaleTimeString() : d.toLocaleString())
  }, [iso, mode])
  return <span>{text}</span>
}
