/**
 * The sender tick (PROMPT.md §8.4).
 *
 * Every `OUTREACH_TICK_MS`, take the messages that are due — `approved` by a
 * person, or `queued` by an auto-send campaign — and run each one through
 * `dispatchTouch`. That function is the single send path: it re-checks every
 * §2.1 rule at the moment of sending and is the only thing that talks to the
 * provider. This file decides nothing; it schedules.
 *
 * ## Why a tick and not a trigger
 *
 * Approving a draft could call the provider directly from the web route. It
 * does not, for two reasons. The web app must not hold a mail transport (it is
 * built with no secrets, and a transport that can deliver has no business in
 * that graph — see packages/db/src/queries.ts). And a message approved at
 * 23:00 in the recipient's zone should be SENT at 08:00, not refused at 23:00
 * — the tick will find it still `approved` next morning, and the quiet-hours
 * refusal is what happens to it in the meantime. That second point is why a
 * `quiet_hours` refusal is not terminal for an approved message; see below.
 *
 * ## One worker, one tick
 *
 * Two workers would both pick up the same `approved` row and both send it.
 * The single-worker advisory lock is what prevents that, and CLAUDE.md §4
 * records that the lock does not isolate over the local PGlite bridge — so on
 * a developer's machine two workers really would double-send. The claim
 * below (`status = 'sending'` in the predicate) is the second layer: it turns
 * a double-send into a "matched 0 rows" for the loser.
 *
 * A worker that dies between the claim and the provider leaves a row in
 * `sending` forever. `recoverStuckSends` at boot marks those `failed` with a
 * reason — the SAFE direction, because the alternative is guessing whether the
 * provider was reached and sending it again.
 *
 * ## A campaign that bounces pauses itself
 *
 * Before each pass that sends email, every active email campaign that has
 * written to at least twenty people in the last thirty days is checked: if
 * more than `OUTREACH_BOUNCE_PAUSE_PCT` of their addresses have bounced
 * since, the campaign is set `paused` — once, audited, and said in one log
 * line. A tick carrying SMS alone skips it: a bounce is about an address,
 * and that tick writes to none. There is no new stop mechanism:
 * `campaign_inactive` already defers everything in a paused campaign, and a
 * person sets it active again after fixing the list. A mailbox that keeps
 * writing to dead addresses stops being one that reaches anybody, and that
 * is the whole agency's outreach, not one list's.
 *
 * BEFORE, not after: the bounces that cross the threshold arrive between
 * ticks (the IMAP listener records them), and `dispatchTouch` re-reads the
 * campaign's status for every row — so a pause taken first defers this
 * tick's messages in that campaign, where a pause taken after the pass let
 * up to a whole batch more go to a list already known to be bouncing.
 *
 * ## One provider per channel, and rows nobody can carry are left alone
 *
 * The worker hands the tick every provider it has — the SMTP mailbox for
 * email, DoveSoft for SMS (0019) — and each row goes to the one that names
 * its channel. The due query asks only for those channels, because
 * `dispatchTouch` refuses a channel its provider lacks WITHOUT touching the
 * row: a row claimed `sending` for a channel nobody carries would be a row
 * the tick could neither send nor put back. So an approved SMS on a worker
 * with no DoveSoft stays `approved`, and the tick says so — ids only, once
 * per tick at most, and again only when the set of waiting rows changes —
 * for the channels the worker names as `unserved`. LinkedIn is never one of
 * them: a person sends it from /tasks, and the worker hands the tick no
 * provider that carries it.
 *
 * ## What is deferred, and what is not
 *
 * The deferrals are `deferUntil`'s, in packages/core — `quiet_hours`,
 * `daily_cap`, `campaign_inactive`: the clock and a person's switch. Every
 * other refusal code is terminal (`refused`), including any added later, so
 * a new rule that time will not fix — stale evidence among them, and a
 * promotional band that never opens — needs no change here.
 */
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { deferUntil, type Channel } from '@agency/core'
import {
  campaignAutoPause, campaignBounceRates, dispatchTouch, dueTouches, schema,
  type AgencyDb, type MessageProvider, type TouchRow,
} from '@agency/db'
import type { Logger } from '../logger.js'
import { faultFields } from '../log-fields.js'

/**
 * The channels a worker provider exists for: email through the mailbox, SMS
 * through DoveSoft. Not LinkedIn — a person sends it — and not voice or
 * WhatsApp, which nothing here can place or send.
 */
export const WORKER_SEND_CHANNELS: readonly Channel[] = ['email', 'sms']

export interface SenderDeps {
  readonly db: AgencyDb
  /**
   * The provider, or one per channel. Each due row goes to the first one
   * that names its channel, and the due query asks for those channels only.
   */
  readonly provider: MessageProvider | readonly MessageProvider[]
  readonly log: Logger
  readonly batch: number
  readonly now?: () => Date
  /**
   * Headers this deployment adds to an outbound message — the RFC 8058
   * `List-Unsubscribe` pair, built by `outreachOptions` when the worker can
   * name a link the web app will verify. Handed to `dispatchTouch`, which
   * merges it over the threading headers AFTER every §2.1 rule has passed;
   * it is never consulted for the decision. Absent, or null for a touch,
   * adds nothing.
   */
  readonly headersFor?: (touch: TouchRow) => Readonly<Record<string, string>> | null
  /**
   * `OUTREACH_BOUNCE_PAUSE_PCT`: a campaign whose addresses bounce past this
   * percentage — strictly more than it, once it has written to at least
   * `BOUNCE_PAUSE_MIN_SENT_TO` people — is paused before the tick's pass. Absent
   * turns the check off; `100` can never be exceeded, so it is off too.
   */
  readonly bouncePausePct?: number
  /**
   * Channels this worker COULD carry but has no provider for — SMS without
   * DoveSoft, email without a mailbox. Due rows on them are never picked
   * up; the tick reports their ids. Absent reports nothing.
   */
  readonly unserved?: readonly Channel[]
}

/**
 * What a running sender remembers between ticks: the waiting rows it last
 * reported, so the same set is not logged every fifteen seconds for as long
 * as DoveSoft is unconfigured — 5,760 identical lines a day trains everybody
 * to stop reading the log.
 */
export interface SenderMemo {
  waitingReported: string | null
}

export interface TickSummary {
  readonly picked: number
  readonly sent: number
  readonly refused: number
  readonly deferred: number
  readonly failed: number
  /** Campaigns this tick paused because their addresses were bouncing. */
  readonly autoPaused: number
  /** Due rows on an `unserved` channel, left exactly as they were (at most `WAITING_REPORT_LIMIT`). */
  readonly waiting: number
}

/** How many waiting ids one report names. The rest are "more". */
export const WAITING_REPORT_LIMIT = 20

/** Below this many people written to, a bounce rate is noise: two in five is not a rate. */
export const BOUNCE_PAUSE_MIN_SENT_TO = 20
/** The window a campaign's rate is read over. */
const BOUNCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Pause every active campaign bouncing past the threshold. Returns how many
 * it paused.
 *
 * Never throws — a failed check must not take the send tick with it — and
 * never un-pauses anything: only a person does that. The decision is made
 * in whole counts (`bounced × 100 > threshold × sentTo`), so a rounding in
 * the displayed percentage can never be what paused a campaign.
 */
export async function pauseBouncingCampaigns(
  deps: Pick<SenderDeps, 'db' | 'log' | 'bouncePausePct'>,
  now: Date,
): Promise<number> {
  const threshold = deps.bouncePausePct
  if (threshold === undefined || !Number.isFinite(threshold)) return 0

  let rates
  try {
    rates = await campaignBounceRates(deps.db, {
      since: new Date(now.getTime() - BOUNCE_WINDOW_MS),
      minSentTo: BOUNCE_PAUSE_MIN_SENT_TO,
    })
  } catch (err) {
    deps.log.warn('bounce check could not read the rates', faultFields(err))
    return 0
  }

  let paused = 0
  for (const r of rates) {
    if (r.bounced * 100 <= threshold * r.sentTo) continue
    const detail = { bouncePct: r.pct, threshold, sentTo: r.sentTo, bounced: r.bounced }
    try {
      if (await campaignAutoPause(deps.db, { orgId: r.orgId, campaignId: r.campaignId, detail })) {
        paused += 1
        // Counts and ids. Never who bounced.
        deps.log.warn('campaign paused automatically: too many of its addresses bounced', {
          orgId: r.orgId,
          campaignId: r.campaignId,
          ...detail,
        })
      }
    } catch (err) {
      deps.log.warn('could not pause a bouncing campaign', {
        campaignId: r.campaignId,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }
  return paused
}

/**
 * Each channel's provider: the first one given that names it. Two providers
 * naming one channel is a wiring mistake `startSender` refuses at boot; here
 * the first simply wins, because a tick never throws.
 */
export function providersByChannel(provider: SenderDeps['provider']): ReadonlyMap<Channel, MessageProvider> {
  const byChannel = new Map<Channel, MessageProvider>()
  for (const p of providerList(provider)) for (const c of p.channels) if (!byChannel.has(c)) byChannel.set(c, p)
  return byChannel
}

function providerList(provider: SenderDeps['provider']): readonly MessageProvider[] {
  return 'send' in provider ? [provider] : provider
}

/**
 * Report the due rows no provider here can carry, and return how many there
 * are (up to `WAITING_REPORT_LIMIT`). Ids only: never the recipient, never
 * the words (§2.3). A row is listed only when it is DUE — one waiting on the
 * clock is not waiting on a provider yet. Never throws.
 */
async function reportWaiting(
  deps: Pick<SenderDeps, 'db' | 'log' | 'unserved'>,
  carried: ReadonlyMap<Channel, MessageProvider>,
  now: Date,
  memo: SenderMemo | undefined,
): Promise<number> {
  const channels = (deps.unserved ?? []).filter((c) => !carried.has(c))
  if (channels.length === 0) return 0
  let rows: { id: string }[]
  try {
    rows = await deps.db
      .select({ id: schema.touches.id })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.direction, 'out'),
          inArray(schema.touches.status, ['approved', 'queued']),
          inArray(schema.touches.channel, [...channels]),
          or(isNull(schema.touches.scheduledFor), lte(schema.touches.scheduledFor, now)),
        ),
      )
      .orderBy(asc(schema.touches.createdAt))
      .limit(WAITING_REPORT_LIMIT + 1)
  } catch (err) {
    deps.log.warn('sender could not read the rows waiting for a provider', faultFields(err))
    return 0
  }

  const ids = rows.slice(0, WAITING_REPORT_LIMIT).map((r) => r.id)
  const key = ids.length === 0 ? null : `${channels.join(',')}:${ids.join(',')}`
  if (key !== null && key !== memo?.waitingReported) {
    deps.log.warn(`${channels.join(' and ')} rows waiting: no provider`, {
      touchIds: ids,
      more: rows.length > WAITING_REPORT_LIMIT,
    })
  }
  if (memo) memo.waitingReported = key
  return ids.length
}

/**
 * One pass over what is due.
 *
 * Never throws: a tick that died on one bad row would stop every message
 * behind it. Each row is settled by `dispatchTouch` into an explained state,
 * and a provider failure — which `dispatchTouch` re-throws so a caller CAN
 * retry — is logged here and left as `failed` for a person to look at.
 *
 * `memo` is what a running sender keeps between ticks; without one, every
 * tick reports the rows waiting for a provider afresh.
 */
export async function runSenderTick(deps: SenderDeps, memo?: SenderMemo): Promise<TickSummary> {
  const now = deps.now?.() ?? new Date()
  const summary = { picked: 0, sent: 0, refused: 0, deferred: 0, failed: 0, autoPaused: 0, waiting: 0 }
  const carried = providersByChannel(deps.provider)

  // Before the pass (see the top of this file), and only when this tick
  // sends email: a bounce is about an address, and a worker carrying SMS
  // alone pauses nothing it is not sending. It never throws.
  if (carried.has('email')) summary.autoPaused = await pauseBouncingCampaigns(deps, now)
  // Rows nobody here can carry are left as they are, and said. Never throws.
  summary.waiting = await reportWaiting(deps, carried, now, memo)

  let due
  try {
    due = await dueTouches(deps.db, deps.batch, now, [...carried.keys()])
  } catch (err) {
    deps.log.warn('sender could not read the queue', faultFields(err))
    if (summary.autoPaused > 0) deps.log.info('sender tick', summary)
    return summary
  }
  summary.picked = due.length

  for (const touch of due) {
    // The due query named only carried channels, so this is never undefined;
    // the guard is for the type, and leaves such a row exactly as it is.
    const provider = carried.get(touch.channel as Channel)
    if (!provider) continue
    // The clock is read per row, not per tick: with a slow provider a batch
    // can straddle midnight or the edge of a quiet window, and every row was
    // stamped and judged as if it went at the tick's first instant.
    const now = deps.now?.() ?? new Date()
    // Claim it. `sending` is a status the CHECK knows (0011), and the
    // predicate is what makes a second worker's identical pick match nothing.
    // The ORIGINAL row is what goes to `dispatchTouch`, so it still reads as
    // approved or queued there and `approvedByHuman` is computed correctly.
    const claimed = await deps.db
      .update(schema.touches)
      .set({ status: 'sending' })
      .where(and(eq(schema.touches.id, touch.id), inArray(schema.touches.status, ['approved', 'queued'])))
      .returning({ id: schema.touches.id })
      .catch(() => [])
    if (claimed.length === 0) continue

    try {
      const result = await dispatchTouch(deps.db, provider, touch, {
        now,
        ...(deps.headersFor ? { headersFor: deps.headersFor } : {}),
      })
      if (result.sent) {
        summary.sent += 1
        continue
      }
      const code = result.decision.allowed ? 'send_now' : result.decision.code

      /**
       * A message refused for quiet hours or the cap is not dead: the person
       * (or the campaign) said yes, and the only thing wrong is the clock. Put
       * it back to the status it came from with `scheduled_for` set, so a tick
       * after the window finds it. Everything else — suppression, consent, a
       * missing recipient — stays refused, because time will not change it.
       *
       * Quiet hours wait for the minute the decision names: the end of the
       * window, or a promotional SMS's band opening (`deferUntil`). They
       * waited a flat hour until review round 5, and a band half an hour wide
       * was stepped over by every retry whose minute past the hour fell
       * outside it, for up to ten days. The cap and a paused campaign wait six
       * hours. None of it is a promise: the tick re-checks the real rule when
       * it arrives, and a message that is still too early is deferred again.
       */
      const retryAt = deferUntil(result.decision, now)
      if (retryAt !== null) {
        await deps.db
          .update(schema.touches)
          .set({ status: touch.status, refusalCode: null, scheduledFor: retryAt })
          .where(eq(schema.touches.id, touch.id))
        summary.deferred += 1
        deps.log.info('deferred an approved message', { touchId: touch.id, because: code, until: retryAt.toISOString() })
        continue
      }
      summary.refused += 1
    } catch (err) {
      // `dispatchTouch` has already marked the row `failed` with the reason.
      summary.failed += 1
      deps.log.error('a message failed at the provider', {
        touchId: touch.id,
        provider: provider.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
  }

  if (summary.picked > 0 || summary.autoPaused > 0) deps.log.info('sender tick', summary)
  return summary
}

/**
 * Start the tick. Returns a stop function that resolves once no tick is
 * mid-flight. Throws — at boot, before any tick — when two providers name
 * the same channel: which one a row went through would then depend on the
 * order somebody wrote them in.
 */
export function startSender(deps: SenderDeps & { readonly intervalMs: number }): () => Promise<void> {
  const named = providerList(deps.provider).flatMap((p) => p.channels)
  const twice = named.filter((c, i) => named.indexOf(c) !== i)
  if (twice.length > 0) {
    throw new Error(`Two providers carry ${[...new Set(twice)].join(', ')}; the sender needs one per channel.`)
  }

  let inFlight: Promise<unknown> = Promise.resolve()
  let queued = false
  let stopped = false
  const memo: SenderMemo = { waitingReported: null }

  const timer = setInterval(() => {
    if (stopped || queued) return
    // Never overlap, and never QUEUE more than one: with a slow provider the
    // old chain grew a tick per interval, and every one of them ran after
    // stop() had been called — claiming and sending during shutdown. Found
    // by review. One tick may wait behind the one in flight; the rest are
    // skipped, and the next interval tries again.
    queued = true
    inFlight = inFlight
      .then(() => {
        queued = false
        return stopped ? undefined : runSenderTick(deps, memo)
      })
      .catch(() => {})
  }, deps.intervalMs)
  timer.unref()

  return async () => {
    stopped = true
    clearInterval(timer)
    await inFlight
  }
}
