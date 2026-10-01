/**
 * Refining a reply's kind with a model (§5.5's `classify_reply`).
 *
 * `recordInboundReply` has already stored a deterministic kind by the time
 * this runs, so everything below is an IMPROVEMENT on an answer that exists.
 * Nothing here can fail in a way that loses one: every path either writes a
 * better kind or leaves the deterministic one alone.
 *
 * Two rules it cannot break, and both are enforced by construction rather
 * than by the prompt:
 *
 *  - **`opted_out` is never a model's decision** (§2.1). A reply the
 *    detector already read as an opt-out is returned untouched and the model
 *    is not called at all; and a model that answers `opted_out` for anything
 *    else is IGNORED, because the suppression row that word implies was
 *    decided by a pure function over the person's own words and is not this
 *    function's to contradict.
 *  - **A reply is a named person's words**, so `TASK_CARRIES_LEAD_DATA`
 *    marks this task as carrying lead data and `decideLlmCall` refuses a
 *    remote provider unless the operator allowed one. That refusal is the
 *    seam's, not restated here.
 *
 * And a better kind is WRITTEN the way a person's is: through the inbox's
 * reclassify path (`replyReclassifyIfStill`, actor `agent`), so every guard
 * a person meets applies, a move off `auto_reply` pauses the person and
 * cancels what was queued for them as their reply would have, the move is
 * audited, and a kind somebody else set while the model was answering
 * stands. It used to be an UPDATE by id: a header-flagged auto-reply the
 * model read as a person's became `wrong_person` and paused nobody. Found
 * by review (round 3, finding 8).
 */
import { REPLY_KINDS, type LlmProvider, type ReplyKind } from '@agency/core'
import { attemptText } from '@agency/llm'
import { replyReclassifyIfStill, schema, type AgencyDb, type ReplyHumanKind } from '@agency/db'
import { eq } from 'drizzle-orm'
import type { Logger } from '../logger.js'

const SYSTEM = [
  'You sort replies to a sales email into one category, for triage.',
  'Answer with exactly one of: interested, not_now, wrong_person, auto_reply, other.',
  'One word, lower case, nothing else.',
  '',
  'interested   — they want to talk, or asked for more.',
  'not_now      — a real answer, but later: budget, timing, already have something.',
  'wrong_person — they have left, or it is not their area, or they named somebody else.',
  'auto_reply   — an out-of-office or other automatic message.',
  'other        — anything you cannot place. Prefer this over guessing.',
].join('\n')

export async function refineReplyKind(args: {
  readonly db: AgencyDb
  readonly log: Logger
  readonly llm: LlmProvider | null
  readonly allowRemoteForLeadData: boolean
  readonly touchId: string
  readonly body: string | null
  readonly deterministic: ReplyKind
}): Promise<ReplyKind> {
  // Settled by a pure function. A model is not asked, and could not change it.
  if (args.deterministic === 'opted_out') return 'opted_out'
  if (!args.llm || !args.body?.trim()) return args.deterministic

  const out = await attemptText({
    provider: args.llm,
    allowRemoteForLeadData: args.allowRemoteForLeadData,
    request: {
      task: 'classify_reply',
      system: SYSTEM,
      // Bounded: a quoted thread can run to tens of thousands of characters
      // and the category is decided in the first few lines a person wrote.
      prompt: args.body.trim().slice(0, 4000),
      maxTokens: 8,
      temperature: 0,
    },
    fallback: args.deterministic,
    onRefused: (code, reason) => args.log.info('reply left to the deterministic kind', { code, reason }),
    onFailed: (error) => args.log.warn('the classifier did not answer', { error }),
  })
  if (!out.usedModel) return args.deterministic

  const said = out.value.trim().toLowerCase().replace(/[^a-z_]/g, '')
  // A model answering `opted_out` is ignored rather than obeyed: that word
  // implies a suppression row this function has no business writing, and the
  // detector that does write one already said no.
  if (said === 'opted_out' || !(REPLY_KINDS as readonly string[]).includes(said)) {
    args.log.info('classifier answered outside its vocabulary — keeping the deterministic kind')
    return args.deterministic
  }
  // Not `opted_out`, and one of the kinds: one a person may choose.
  const kind = said as ReplyHumanKind
  if (kind === args.deterministic) return kind

  const at = await args.db
    .select({ orgId: schema.touches.orgId })
    .from(schema.touches)
    .where(eq(schema.touches.id, args.touchId))
    .limit(1)
  const orgId = at[0]?.orgId
  if (!orgId) return args.deterministic

  // Only while the reply still has the kind the model was asked about; a
  // guard that refuses (the person is suppressed, say) keeps what is stored.
  const written = await replyReclassifyIfStill(args.db, {
    orgId, touchId: args.touchId, kind, actor: 'agent', expected: args.deterministic,
  })
  if (!written.ok) {
    args.log.info('the classifier’s kind was not written', { reason: written.reason })
    return written.reason === 'changed_meanwhile' ? (written.current ?? args.deterministic) : args.deterministic
  }
  args.log.info('reply re-classified', {
    from: args.deterministic, to: kind, paused: written.paused, cancelled: written.cancelled,
  })
  return kind
}
