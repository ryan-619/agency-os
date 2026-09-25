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
 */
import { REPLY_KINDS, type LlmProvider, type ReplyKind } from '@agency/core'
import { attemptText } from '@agency/llm'
import { schema, type AgencyDb } from '@agency/db'
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
  const kind = said as ReplyKind

  if (kind !== args.deterministic) {
    await db_update(args.db, args.touchId, kind)
    args.log.info('reply re-classified', { from: args.deterministic, to: kind })
  }
  return kind
}

async function db_update(db: AgencyDb, touchId: string, kind: ReplyKind): Promise<void> {
  await db.update(schema.touches).set({ replyKind: kind }).where(eq(schema.touches.id, touchId))
}
