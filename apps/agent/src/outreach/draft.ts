/**
 * Letting a model improve an opener (§5.5's `draft_outreach`).
 *
 * `draftOpener` in packages/core has already produced a sendable draft by
 * the time this runs, quoting only what the scanner observed. Everything
 * here is an improvement on words that already exist, and every failure path
 * returns them unchanged.
 *
 * ## The model may rewrite the prose. It may not change the facts.
 *
 * §2.2 is absolute about outreach: an email is the one artefact a stranger
 * reads, so a finding nobody observed inside one is a false statement about
 * their company, in writing, with the agency's name on it. A prompt asking
 * politely for that is not a control.
 *
 * So the output is CHECKED rather than trusted: every claim the
 * deterministic draft quoted must still appear in the rewrite, and the
 * rewrite may not have grown far beyond it. A draft that drops a claim has
 * changed what is being asserted; one that balloons has added something.
 * Either way the deterministic text is what gets queued, and the caller is
 * none the wiser except in the log.
 *
 * None of this decides to SEND anything. The draft lands in the approvals
 * queue exactly as before (§2.4) and a human reads every word.
 */
import type { Draft, LlmProvider } from '@agency/core'
import { attemptText } from '@agency/llm'
import type { Logger } from '../logger.js'

const SYSTEM = [
  'You tighten a cold outreach email that has already been written.',
  '',
  'Rules you cannot break:',
  '- Do not add, remove or reword any factual claim. The observations listed',
  '  are the only facts that exist; inventing one is the worst thing you can do.',
  '- Do not describe the work as testing, scanning or an assessment of their',
  '  systems. It is a look at public pages from the outside.',
  '- Keep it under 150 words. Keep the invitation to correct us.',
  '- Reply with the email body only. No subject, no preamble, no commentary.',
].join('\n')

/** Roughly how much longer than the original a rewrite may be before it is suspect. */
const MAX_GROWTH = 1.6

export async function refineDraft(args: {
  readonly log: Logger
  readonly llm: LlmProvider | null
  readonly allowRemoteForLeadData: boolean
  readonly draft: Draft
  /** Ends the model call early — a caller with a time budget passes one; the written draft then stands. */
  readonly signal?: AbortSignal
}): Promise<Draft> {
  if (!args.llm) return args.draft

  const out = await attemptText({
    provider: args.llm,
    allowRemoteForLeadData: args.allowRemoteForLeadData,
    ...(args.signal ? { signal: args.signal } : {}),
    request: {
      task: 'draft_outreach',
      system: SYSTEM,
      prompt: [
        'The observations, which are the only facts available:',
        ...args.draft.quoted.map((c) => `- ${c}`),
        '',
        'The email as written:',
        args.draft.body,
      ].join('\n'),
      maxTokens: 600,
      temperature: 0.3,
    },
    fallback: args.draft.body,
    onRefused: (code, reason) => args.log.info('draft left as written', { code, reason }),
    onFailed: (error) => args.log.warn('the drafting model did not answer', { error }),
  })
  if (!out.usedModel) return args.draft

  const rewritten = out.value.trim()
  const verdict = keepsTheFacts(rewritten, args.draft)
  if (verdict !== 'ok') {
    // §2.3: the reason, never the text. A rejected draft is still a draft
    // about a named company.
    args.log.warn('the rewrite changed what the email asserts — keeping the written draft', { verdict })
    return args.draft
  }
  return { ...args.draft, body: rewritten }
}

/**
 * Does the rewrite still assert exactly what the original did?
 *
 * Deliberately crude, and crude in the safe direction: a claim the model
 * paraphrased beyond recognition reads as dropped, and the original is kept.
 * The cost of that is a draft that was fine being discarded; the cost of the
 * opposite is an email stating a finding nobody observed.
 */
function keepsTheFacts(rewritten: string, draft: Draft): 'ok' | 'empty' | 'dropped_a_claim' | 'grew' {
  if (!rewritten) return 'empty'
  if (rewritten.length > draft.body.length * MAX_GROWTH) return 'grew'
  const haystack = normalise(rewritten)
  const wordsOf = (claim: string): string[] =>
    normalise(claim).split(' ').filter((w) => w.length > 3)

  for (const claim of draft.quoted) {
    const words = wordsOf(claim)
    if (words.length === 0) continue

    /**
     * The words UNIQUE to this claim have to survive, and the shared ones
     * are ignored.
     *
     * Measuring every word instead let a dropped claim pass: "No security or
     * trust page" shares `security` with "No Content-Security-Policy", so a
     * rewrite that deleted the trust page entirely still scored two words
     * out of three and read as kept. What actually distinguishes one claim
     * from another is the word the others do not have.
     */
    const elsewhere = new Set(
      draft.quoted.filter((c) => c !== claim).flatMap((c) => wordsOf(c)),
    )
    const distinctive = words.filter((w) => !elsewhere.has(w))
    if (distinctive.length > 0) {
      if (!distinctive.every((w) => haystack.includes(w))) return 'dropped_a_claim'
      continue
    }
    // Nothing distinguishes it from its neighbours, so fall back to asking
    // whether most of it is still there.
    const kept = words.filter((w) => haystack.includes(w)).length
    if (kept / words.length < 0.6) return 'dropped_a_claim'
  }
  return 'ok'
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
