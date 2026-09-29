import 'server-only'
import { env } from '@/lib/env'
import { flagsFrom, type Deployment } from '@/lib/deployment-facts'

/**
 * What THIS deployment can actually do — read from the environment.
 *
 * The facts and the sentences live in `lib/deployment-facts.ts`, which is
 * pure and tested; this file is the one line that reads `env()`, kept
 * behind `server-only` so nothing that runs in a browser can ask which
 * secrets a deployment holds. Every page that would promise sending, reply
 * detection, a scheduled job or a notification asks `deployment()` first.
 */
export type { Deployment } from '@/lib/deployment-facts'
export { flagsFrom, noRepliesReadNote, nothingWillSendNote } from '@/lib/deployment-facts'

export function deployment(): Deployment {
  return flagsFrom(env())
}
