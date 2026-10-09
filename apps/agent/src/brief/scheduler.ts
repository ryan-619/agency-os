/**
 * The morning brief, started by the worker (0020).
 *
 * Once a minute, and once at boot: every org whose brief is due (`briefsDue`,
 * by its own zone's clock, or at once when an owner pressed "Run it now") is
 * CLAIMED for that day (`claimBrief`, one UPDATE that matches only while the
 * day has not run or a request waits, and spends both), given a fresh thread
 * in the name of the person who switched it on, and one unattended turn is
 * started there with `morningBriefPrompt`. The gate declines anything in that turn
 * that would need a person, so it reads, scans and writes the brief, and
 * lists everything else as a next step.
 *
 * One brief at a time, and a tick never overlaps another: a laptop waking at
 * noon with three orgs due starts them one after the other. The day is spent
 * once claimed — a brief that could not start (chat off, the person gone) is
 * audited `assistant.brief_failed` and tried again tomorrow, never every
 * minute.
 */
import { briefThreadTitle, morningBriefPrompt } from '@agency/core'
import { appendAudit, briefsDue, claimBrief, createChatSession, type AgencyDb } from '@agency/db'
import type { Logger } from '../logger.js'
import { faultFields } from '../log-fields.js'

/** Starts the unattended turn; `finished` settles when the turn has ended. */
export type BriefStarter = (req: {
  readonly chatSessionId: string
  readonly userId: string
  readonly text: string
}) => Promise<{ readonly ok: true; readonly finished: Promise<void> } | { readonly ok: false; readonly message: string }>

export interface MorningBriefDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly now: () => Date
  readonly start: BriefStarter
  /** How often to look; a minute by default. */
  readonly intervalMs?: number
}

/** Runs one look: every due brief, one at a time. Exported for the tests. */
export async function runDueBriefs(deps: MorningBriefDeps): Promise<number> {
  let started = 0
  for (const b of await briefsDue(deps.db, deps.now())) {
    const claimed = await claimBrief(deps.db, { orgId: b.orgId, localDate: b.localDate })
    if (!claimed) continue
    const thread = await createChatSession(deps.db, {
      orgId: b.orgId,
      userId: claimed.userId,
      title: briefThreadTitle(b.localDate),
    })
    const begun = await deps.start({
      chatSessionId: thread.id,
      userId: claimed.userId,
      // The time it STARTS, which is later than b.at when the worker slept through it.
      text: morningBriefPrompt({ localDate: b.localDate, at: b.localTime, timeZone: b.timeZone }),
    })
    await appendAudit(deps.db, {
      orgId: b.orgId,
      actor: 'system',
      action: begun.ok ? 'assistant.brief_started' : 'assistant.brief_failed',
      subjectType: 'chat_session',
      subjectId: thread.id,
      // The refusal's code ('chat_disabled', 'no_such_conversation'), never more.
      detail: begun.ok
        ? { date: b.localDate, requested: b.requested }
        : { date: b.localDate, requested: b.requested, why: begun.message.slice(0, 64) },
    }).catch(() => {})
    if (!begun.ok) {
      deps.log.warn('the morning brief could not start', { orgId: b.orgId, date: b.localDate, why: begun.message })
      continue
    }
    deps.log.info('morning brief started', {
      orgId: b.orgId, date: b.localDate, requested: b.requested, chatSessionId: thread.id,
    })
    started++
    await begun.finished
  }
  return started
}

/**
 * Look now and then every `intervalMs`; the returned function stops it. A
 * look that fails is logged once per streak, by the error's class (a driver
 * message can carry the DSN), and once when it works again — not 1,440 times
 * a day while, say, 0020 is not yet applied to the database it reads.
 */
export function startMorningBriefs(deps: MorningBriefDeps): () => void {
  let busy = false
  let failing: string | null = null
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await runDueBriefs(deps)
      if (failing !== null) deps.log.info('the morning brief check works again', { after: failing })
      failing = null
    } catch (err) {
      const error = err instanceof Error ? err.name : 'UnknownError'
      if (error !== failing) deps.log.warn('the morning brief check failed', faultFields(err))
      failing = error
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
