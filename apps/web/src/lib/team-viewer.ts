import 'server-only'
import { auth } from '@/auth'

/**
 * Whether the person opening one of a business's links is signed in to the
 * organisation that made it (2026-10-08). A teammate checking a link before
 * sending it is not the business reading it: their view is not counted — so
 * it raises no "they just opened it" task — and they cannot answer a quote in
 * the buyer's name; the team records an answer on the quote's own page. A
 * session that cannot be read — none, or a revoked member's, whose session
 * callback throws — is a stranger's.
 */
export async function viewerIsTeam(orgId: string): Promise<boolean> {
  try {
    const session = await auth()
    return session?.user?.orgId === orgId
  } catch {
    return false
  }
}
