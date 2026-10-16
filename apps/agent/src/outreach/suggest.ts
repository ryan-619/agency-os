/**
 * A suggested answer on every email reply (0026, §5.5's `draft_reply`).
 *
 * After a reply is recorded, paused, cancelled, advanced and sorted, the
 * model is asked for a short answer a person can start from — from the
 * sender's own words, our message, the current scan's quotable lines, the
 * playbook and the catalogue (`replySuggestionFacts`, which refuses first
 * for every reply nobody should answer with a model's help). What it writes
 * is CHECKED (`replyDraftProblems`) and then stored beside the reply, never
 * as a message: a person reads it on /inbox, changes it, and drafts the
 * answer through the path every answer takes. Nothing here sends, resumes
 * or classifies anything.
 *
 * Two callers: `handleInboundMessage` right after triage, for a reply the
 * worker's own inbox read; and `startSuggestions`, a sweep every five
 * minutes over recent replies with no suggestion row — the ones the web's
 * webhooks recorded, or that arrived while the model was unreachable. A
 * refusal of the model (`replySuggestionFacts`, the model's own `NONE`, a
 * guard) is recorded `skipped` once; a provider that did not answer writes
 * nothing, so the sweep tries again within its window.
 *
 * A reply is a named person's words, so the task carries lead data and
 * `decideLlmCall` refuses a remote provider unless the operator allowed one
 * (`./tools/run-worker.sh --ai`). That refusal is the seam's, not restated.
 */
import { parseReplyDraft, replyDraftPrompt, replyDraftProblems, type LlmProvider } from '@agency/core'
import { attemptText } from '@agency/llm'
import {
  repliesAwaitingSuggestion, replySuggestionFacts, replySuggestionSkip, replySuggestionWrite, type AgencyDb,
  type ReplySuggestionSkip,
} from '@agency/db'
import type { Logger } from '../logger.js'
import { faultFields } from '../log-fields.js'

export type SuggestOutcome = 'drafted' | 'skipped' | 'already' | 'no_model' | 'refused' | 'failed'

export interface SuggestDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly llm: LlmProvider | null
  readonly allowRemoteForLeadData: boolean
  /** The web app's origin, for the booking link the draft may offer; null offers none. */
  readonly webOrigin: string | null
  readonly now?: () => Date
}

export async function suggestAnswer(
  deps: SuggestDeps,
  args: { readonly orgId: string; readonly touchId: string },
): Promise<SuggestOutcome> {
  if (!deps.llm) return 'no_model'
  const now = deps.now ? deps.now() : new Date()
  const gathered = await replySuggestionFacts(deps.db, { orgId: args.orgId, touchId: args.touchId, now, webOrigin: deps.webOrigin })
  if (!gathered.ok) {
    if (gathered.why === 'already') return 'already'
    await replySuggestionSkip(deps.db, { orgId: args.orgId, touchId: args.touchId, why: gathered.why })
    deps.log.info('no answer suggested', { touchId: args.touchId, why: gathered.why })
    return 'skipped'
  }
  const { facts } = gathered
  const built = replyDraftPrompt(facts.input)

  let refused: string | null = null
  const out = await attemptText({
    provider: deps.llm,
    allowRemoteForLeadData: deps.allowRemoteForLeadData,
    request: { task: 'draft_reply', system: built.system, prompt: built.prompt, maxTokens: 400, temperature: 0.4 },
    fallback: '',
    onRefused: (code, reason) => {
      refused = code
      deps.log.info('no answer suggested: the model was not asked', { touchId: args.touchId, code, reason })
    },
    onFailed: (error) => deps.log.warn('the suggesting model did not answer', { touchId: args.touchId, error }),
  })
  if (!out.usedModel) return refused ? 'refused' : 'failed'

  const body = parseReplyDraft(out.value)
  if (body === null) {
    await replySuggestionSkip(deps.db, { orgId: args.orgId, touchId: args.touchId, why: 'model_declined' })
    deps.log.info('no answer suggested: the model declined', { touchId: args.touchId })
    return 'skipped'
  }
  const problems = replyDraftProblems(body, facts.allowed)
  if (problems.length > 0) {
    // §2.3: the reason, never the text. A refused draft is still about a named person.
    const why: ReplySuggestionSkip = problems[0]!
    await replySuggestionSkip(deps.db, { orgId: args.orgId, touchId: args.touchId, why })
    deps.log.warn('the suggested answer was refused by the guard — nothing is shown', { touchId: args.touchId, problems })
    return 'skipped'
  }
  const written = await replySuggestionWrite(deps.db, {
    orgId: args.orgId,
    touchId: args.touchId,
    contactId: facts.contactId,
    companyId: facts.companyId,
    body,
    model: `${deps.llm.name}/${deps.llm.model}`,
  })
  if (!written.ok) return 'already'
  deps.log.info('answer suggested', { touchId: args.touchId, chars: [...body].length, provider: out.provider })
  return 'drafted'
}

export const SUGGEST_INTERVAL_MS = 5 * 60_000
/** How far back the sweep looks: a reply older than this with no row is left alone — somebody has moved on. */
export const SUGGEST_WINDOW_MS = 2 * 24 * 60 * 60_000
export const SUGGEST_PER_PASS = 10

/**
 * The sweep: every five minutes and once at boot, up to ten recent replies
 * with no suggestion row, oldest first. One pass never overlaps another; a
 * pass that fails is logged once per streak by the fault's class and code.
 */
export function startSuggestions(deps: SuggestDeps & { readonly intervalMs?: number }): () => void {
  let busy = false
  let failing: string | null = null
  const tick = async (): Promise<void> => {
    if (busy || !deps.llm) return
    busy = true
    try {
      const now = deps.now ? deps.now() : new Date()
      const waiting = await repliesAwaitingSuggestion(deps.db, { since: new Date(now.getTime() - SUGGEST_WINDOW_MS), limit: SUGGEST_PER_PASS })
      const counts: Record<SuggestOutcome, number> = { drafted: 0, skipped: 0, already: 0, no_model: 0, refused: 0, failed: 0 }
      for (const r of waiting) {
        const outcome = await suggestAnswer(deps, r).catch((err: unknown) => {
          deps.log.warn('suggesting an answer failed', { touchId: r.touchId, ...faultFields(err) })
          return 'failed' as const
        })
        counts[outcome]++
        // A provider that is refusing or failing is not asked ten times a pass.
        if (outcome === 'refused' || outcome === 'failed') break
      }
      if (waiting.length > 0) deps.log.info('suggested answers swept', { ...counts })
      if (failing !== null) deps.log.info('suggested answers sweep again', { after: failing })
      failing = null
    } catch (err) {
      const error = err instanceof Error ? err.name : 'UnknownError'
      if (error !== failing) deps.log.warn('suggested answers could not be swept', faultFields(err))
      failing = error
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? SUGGEST_INTERVAL_MS)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
