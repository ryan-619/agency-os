import { bearerFromHeader, secretMatches } from './secret-compare'

/**
 * The contract every cron route checks before doing anything (§2.3, §2.4).
 *
 * A cron route is a public URL that does work nobody asked for at the
 * moment it runs — rescanning companies, posting a digest — so it has to
 * prove three things about a request, in this order:
 *
 *   1. it is configured at all: no `CRON_SECRET`, no cron, 503. The route
 *      answers exactly as the inbound webhook does with no secret;
 *   2. the caller holds the secret, compared in constant time, 401 otherwise.
 *      Vercel sends it as `Authorization: Bearer <CRON_SECRET>`;
 *   3. this is PRODUCTION. Vercel runs the schedule against the production
 *      deployment, but a preview deployment inherits the same environment
 *      and answers the same URL — and a preview that rescans the pipeline
 *      or sends the digest twice is a job nobody scheduled. `VERCEL_ENV`
 *      unset (a local run, a container) is allowed through: there is no
 *      platform there to disagree with.
 *
 * Pure over its inputs, so the four outcomes can be pinned without a request
 * or an environment. A route logs `{ route, outcome }` and nothing else —
 * never the header, never the secret.
 */
export type CronCheck = { ok: true } | { ok: false; status: 401 | 403 | 503; error: string }

export function cronRequest(input: {
  readonly authorization: string | null
  readonly secret: string | undefined
  readonly vercelEnv: string | undefined
}): CronCheck {
  if (!input.secret) return { ok: false, status: 503, error: 'not_configured' }
  if (!secretMatches(input.secret, bearerFromHeader(input.authorization))) {
    return { ok: false, status: 401, error: 'unauthorized' }
  }
  if (input.vercelEnv !== undefined && input.vercelEnv !== 'production') {
    return { ok: false, status: 403, error: 'not_production' }
  }
  return { ok: true }
}
