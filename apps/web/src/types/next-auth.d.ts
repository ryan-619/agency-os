import type { Role } from '@agency/core'
import 'next-auth'

/**
 * The session callback in src/auth.ts attaches the signed-in user's
 * organisation and role. Declared here so every consumer sees them.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      orgId: string
      role: Role
      email?: string | null
      name?: string | null
      image?: string | null
    }
  }
}
