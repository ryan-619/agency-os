'use client'

import { useEffect } from 'react'
import { CircleAlert } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

/**
 * What a person sees when a page throws (2026-10-09), in place of Next's
 * grey box: a sentence, the error's digest (which the server log carries
 * too, so a teammate can find it), and a way to try again — never the
 * error's own message, which from the driver quotes a query and its bound
 * values, and from the network names a host.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // The server has logged the error itself; here only the digest, so the console never carries a message.
    if (error.digest) console.warn('page error', { digest: error.digest })
  }, [error])
  return (
    <div className="page-fallback">
      <EmptyState
        icon={CircleAlert}
        title="This page could not be shown"
        actions={[{ href: '/', label: 'Dashboard' }]}
      >
        Something went wrong while it was being built. Nothing you did was lost, and nothing was sent.
        {error.digest ? <> If it keeps happening, tell whoever runs this with the code <code>{error.digest}</code>.</> : null}
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </EmptyState>
    </div>
  )
}
