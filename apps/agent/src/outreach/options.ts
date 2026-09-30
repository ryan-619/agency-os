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
 *
 * ## One-click unsubscribe (RFC 8058, §2.1)
 *
 * With `UNSUBSCRIBE_SECRET` and `WEB_PUBLIC_URL` both set, every outbound
 * EMAIL carries `List-Unsubscribe: <…/api/unsubscribe/<token>>` and
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The token names the
 * touch and nothing else; the web app, holding the same secret, verifies it
 * and writes the suppression row (packages/db/src/unsubscribe.ts).
 *
 * Either one unset means no header at all, said once at boot. A link built
 * with no origin points nowhere a mail client can reach, and one signed with
 * a secret the web app does not hold is a button that does nothing when
 * somebody presses it to be left alone — both worse than no link, because
 * the person believes they asked. Other channels never get it: a LinkedIn
 * message is typed by a person, and a header on it would be carried nowhere.
 *
 * ## The bounce threshold
 *
 * `OUTREACH_BOUNCE_PAUSE_PCT` (default 5) becomes `bouncePausePct`: after
 * each tick, a campaign whose addresses bounced past it — once it has
 * written to twenty people — is paused, and a person re-activates it. Said
 * once at boot, with the number, so a deployment knows the check is on.
 */
import { unsubscribeHeaders } from '@agency/db'
import type { loadEnv } from '../env.js'
import type { Logger } from '../logger.js'
import { BOUNCE_PAUSE_MIN_SENT_TO, type SenderDeps } from './sender.js'

export type OutreachOptions = Partial<Omit<SenderDeps, 'db' | 'provider' | 'log' | 'batch'>>

/** The optional sender settings derived from the environment. */
export function outreachOptions(env: ReturnType<typeof loadEnv>, log: Logger): OutreachOptions {
  return { ...unsubscribeOptions(env, log), ...bounceOptions(env, log) }
}

function bounceOptions(env: ReturnType<typeof loadEnv>, log: Logger): OutreachOptions {
  // `loadEnv` always supplies a number (zod's default); an env assembled by
  // hand without it — a test naming only the variables it cares about —
  // leaves the check off rather than inventing a threshold.
  const pct = env.OUTREACH_BOUNCE_PAUSE_PCT
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return {}
  log.info('bounce auto-pause: on', { thresholdPct: pct, minSentTo: BOUNCE_PAUSE_MIN_SENT_TO })
  return { bouncePausePct: pct }
}

function unsubscribeOptions(env: ReturnType<typeof loadEnv>, log: Logger): OutreachOptions {
  const secret = env.UNSUBSCRIBE_SECRET
  const origin = env.WEB_PUBLIC_URL
  if (!secret || !origin) {
    // A warn, not an info: outreach going out with no one-click opt-out is
    // something the person who deployed this should notice, and mailbox
    // providers increasingly treat it as a bulk sender that ignored the rule.
    log.warn('unsubscribe: headers off', {
      missing: [...(secret ? [] : ['UNSUBSCRIBE_SECRET']), ...(origin ? [] : ['WEB_PUBLIC_URL'])],
    })
    return {}
  }
  log.info('unsubscribe: headers on')
  return {
    headersFor: (touch) => (touch.channel === 'email' ? unsubscribeHeaders(secret, origin, touch.id) : null),
  }
}
