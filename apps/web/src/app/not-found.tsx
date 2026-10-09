import { SearchX } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

/** A page that does not exist, or a record not in this org (2026-10-09): one sentence, two ways on. */
export default function NotFound() {
  return (
    <div className="page-fallback">
      <EmptyState
        icon={SearchX}
        title="Nothing at this address"
        actions={[
          { href: '/', label: 'Dashboard' },
          { href: '/companies', label: 'Companies', secondary: true },
        ]}
      >
        The page may have moved, or the record is not in your organisation. Nothing was changed.
      </EmptyState>
    </div>
  )
}
