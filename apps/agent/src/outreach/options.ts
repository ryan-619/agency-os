// STUB — filled in wave 2 by unsubscribe-link, then wave 3 by mail-signals-and-bounce-pause
/**
 * The sender's OPTIONAL settings, derived from the environment in one place.
 *
 * `startSender` takes what it must have — the database, the provider, the
 * logger, the batch size — as required arguments, and everything a later
 * feature adds (the one-click unsubscribe headers, the bounce threshold that
 * pauses a campaign) as optional ones. This function is where those optional
 * ones are built from `loadEnv()`'s result, so `index.ts` spreads its answer
 * into the `startSender` call and is never edited to add one.
 *
 * The type is derived from `SenderDeps` rather than written out, so a setting
 * added to the sender is offered here without a second declaration to drift.
 * Whatever is logged here is a NAME and an on/off — never a secret's value,
 * and never the URL a secret rides on (§2.3).
 */
import type { loadEnv } from '../env.js'
import type { Logger } from '../logger.js'
import type { SenderDeps } from './sender.js'

export type OutreachOptions = Partial<Omit<SenderDeps, 'db' | 'provider' | 'log' | 'batch'>>

/** The optional sender settings derived from the environment. The stub adds nothing. */
export function outreachOptions(_env: ReturnType<typeof loadEnv>, _log: Logger): OutreachOptions {
  return {}
}
