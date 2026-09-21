/**
 * One call's conversation (PROMPT.md §8.5).
 *
 * ConversationRelay hands us a WebSocket and a stream of `prompt` messages —
 * what the caller said — and we answer with `text` tokens it speaks back.
 * Everything in between is this file, and it is deliberately thin: the
 * RULES live in `packages/core/src/voice.ts`, pure and unit-tested, because
 * a rule that only exists inside a socket handler cannot be tested without
 * a phone line and therefore will not be.
 *
 * ## The order of precedence is §2.1's, not the conversation's
 *
 * On every single turn, before anything else is considered:
 *
 *   1. did they ask to be left alone?  → suppress, say so, hang up;
 *   2. did they ask for a person?      → hand off;
 *   3. is the conversation going badly? → hand off anyway;
 *   4. only then, the script.
 *
 * A model-backed policy would sit at step 4 and NOTHING else: the first
 * three are detected on the caller's own words by pure functions, never
 * left to a model to notice. That is the whole point of the ordering — a
 * model that is having a nice conversation is exactly the one that misses
 * "stop calling me".
 *
 * ## Why the disclosure is not sent from here
 *
 * §2.1 requires the AI to disclose itself in the FIRST utterance, and the
 * safest way to guarantee something is first is to make it impossible for
 * anything to precede it. It is passed as `welcomeGreeting` on the
 * `<ConversationRelay>` noun, so Twilio speaks it at connect time, before
 * this socket has said a word, and `welcomeGreetingInterruptible="none"`
 * means the caller cannot talk over it either.
 */
import {
  INITIAL_STATE, decideInboundCall, scriptedOpening, scriptedTurn, shouldHandOffForSentiment,
  spokenOptOut, wantsHuman,
  type QualificationState, type TranscriptEntry,
} from '@agency/core'
import {
  appendTranscript, clearDisclosure, endCall, recordDisclosure, recordHandoff, recordOptOut,
  type AgencyDb,
} from '@agency/db'
import { attemptText } from '@agency/llm'
import type { LlmProvider } from '@agency/core'
import type { Logger } from './logger.js'

/** What the socket should do after a turn. */
export interface SessionAction {
  /** Spoken to the caller. Empty means say nothing. */
  readonly say: string
  /** End the ConversationRelay session after speaking. */
  readonly end: boolean
  /** Why it ended, passed to the `<Connect action>` webhook as handoffData. */
  readonly handoff?: { readonly reason: 'live-agent-handoff' | 'opted-out' | 'done'; readonly detail: string }
}

export interface SessionDeps {
  readonly db: AgencyDb
  readonly log: Logger
  readonly orgId: string
  readonly orgName: string
  readonly callId: string
  /** The caller's number, for the suppression row if they opt out. */
  readonly theirNumber: string
  /** False when the number is already on the do-not-contact list. */
  readonly mayQualify: boolean
  /**
   * Whether there is anywhere to transfer a caller to. False when neither a
   * TaskRouter workflow nor an on-call number is configured — and a caller
   * who is told "connecting you now" and then hears "nobody is available"
   * was misled by this service, not by the configuration.
   */
  readonly canHandOff?: boolean
  /**
   * The single-shot model for the call summary (§5.5), or null for the
   * deterministic extractive one. Null is a complete configuration, not a
   * degraded one — see `finish()`.
   */
  readonly llm?: LlmProvider | null
  /** The operator has accepted sending a transcript to a remote model. */
  readonly allowRemoteForLeadData?: boolean
  readonly now?: () => Date
}

export class VoiceSession {
  private state: QualificationState = INITIAL_STATE
  private readonly transcript: TranscriptEntry[] = []
  private finished = false

  constructor(private readonly deps: SessionDeps) {}

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  /** Record a line both in memory (for the outcome) and in the database. */
  private async remember(role: TranscriptEntry['role'], text: string): Promise<void> {
    const entry: TranscriptEntry = { role, text, at: this.at() }
    this.transcript.push(entry)
    // Never let a transcript write break a live call: the caller is on the
    // line, and a failed append is a lost line, not a lost conversation.
    await appendTranscript(this.deps.db, this.deps.callId, entry).catch((err: unknown) => {
      this.deps.log.warn('transcript append failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    })
  }

  /**
   * The session is live and the greeting is about to play.
   *
   * This is where the disclosure is recorded, not where it is spoken —
   * Twilio speaks it. Recording it at TwiML time instead would mark calls
   * that never connected as disclosed.
   */
  async onSetup(): Promise<SessionAction> {
    await recordDisclosure(this.deps.db, this.deps.callId, this.deps.now?.() ?? new Date())
    const disclosure = `[welcome greeting: AI disclosure and opt-out, spoken by the carrier]`
    await this.remember('system', disclosure)

    if (!this.deps.mayQualify) {
      // §2.1: a suppressed number is answered — they called US — but nothing
      // is asked of them and nothing is pitched. `decideInboundCall` is the
      // pure statement of that rule.
      const mode = decideInboundCall({ suppressed: true })
      this.deps.log.info('call answered in service-only mode', { callId: this.deps.callId, mode: mode.mode })
      // The opt-out offer is repeated even here. §2.1 wants an INTERACTIVE
      // opt-out on every AI call, and a caller who is already suppressed is
      // exactly the one most likely to want to say it again and be sure.
      const say =
        'Before we go on — your number is on our do-not-contact list, so I will not ask you anything. ' +
        'Say "stop" at any time and I will end the call. If you would like to speak to a person, say so; ' +
        'otherwise I will end the call.'
      await this.remember('agent', say)
      return { say, end: false }
    }

    const opening = scriptedOpening()
    await this.remember('agent', opening)
    return { say: opening, end: false }
  }

  /** The caller said something. */
  async onPrompt(text: string): Promise<SessionAction> {
    if (this.finished) return { say: '', end: false }
    const said = text.trim()
    if (!said) return { say: '', end: false }
    await this.remember('caller', said)

    // ---- 1. an opt-out beats everything, including the script ------------
    if (spokenOptOut(said)) return this.optOut()

    // ---- 2. they asked for a person --------------------------------------
    if (wantsHuman(said)) {
      return this.handOff('they asked to speak to a person')
    }

    // A suppressed caller is never qualified; the only thing on offer is a
    // person or a goodbye.
    if (!this.deps.mayQualify) {
      const say = 'Understood. I will end the call here. Thanks for ringing.'
      await this.remember('agent', say)
      this.finished = true
      return { say, end: true, handoff: { reason: 'done', detail: 'suppressed caller, no handoff requested' } }
    }

    // ---- 3. going badly enough that a person should take over ------------
    if (shouldHandOffForSentiment(this.transcript)) {
      return this.handOff('the caller sounded unhappy')
    }

    // ---- 4. the script ---------------------------------------------------
    const turn = scriptedTurn(this.state, said, this.deps.orgName)
    this.state = turn.next
    await this.remember('agent', turn.reply)

    if (turn.action === 'opted_out') return this.optOut(turn.reply)
    if (turn.action === 'handoff') {
      return this.handOff('the caller asked for a person at the close', turn.reply)
    }
    if (turn.action === 'end') {
      this.finished = true
      return { say: turn.reply, end: true, handoff: { reason: 'done', detail: 'qualified, follow-up by email' } }
    }
    return { say: turn.reply, end: false }
  }

  /**
   * The relay reported an error.
   *
   * Twilio documents the TTS failures (64111 provider error, 64112
   * conversion error) as NON-fatal — the session carries on and the caller
   * simply heard nothing. If that happens before the caller has said a
   * word, the text that went unheard was the AI disclosure, and continuing
   * would be running an AI conversation with somebody who was never told.
   * So the record is corrected and the call ends: §2.1 is not negotiable,
   * and a call nobody can legally continue is one to hand to a person.
   */
  async onRelayError(description: string): Promise<SessionAction> {
    const tts = /\b(64111|64112)\b/.test(description) || /tts|text.to.speech|synthes/i.test(description)
    const heardNothingYet = !this.transcript.some((e) => e.role === 'caller')
    if (!tts || !heardNothingYet || this.finished) {
      await this.remember('system', `[relay error: ${description.slice(0, 200)}]`)
      return { say: '', end: false }
    }

    this.finished = true
    await clearDisclosure(this.deps.db, this.deps.callId)
    await this.remember('system', `[the AI disclosure was not spoken — ${description.slice(0, 160)}]`)
    this.deps.log.error('DISCLOSURE NOT HEARD — ending the call', { callId: this.deps.callId })
    return {
      // Said, not synthesised by the provider that just failed — but if this
      // does not reach them either, the call still ends, which is the
      // outcome §2.1 requires.
      say: 'Sorry, there is a fault on this line. I am an AI assistant and I will end the call here. Somebody will call you back.',
      end: true,
      handoff: { reason: 'live-agent-handoff', detail: 'AI disclosure could not be spoken' },
    }
  }

  /**
   * A keypress. Zero is the convention for "give me a person", and honouring
   * it costs nothing; anything else is left alone rather than guessed at.
   */
  async onDtmf(digit: string): Promise<SessionAction> {
    if (this.finished) return { say: '', end: false }
    await this.remember('caller', `[pressed ${digit}]`)
    if (digit === '0') return this.handOff('the caller pressed 0')
    return { say: '', end: false }
  }

  private async optOut(alreadySaid?: string): Promise<SessionAction> {
    this.finished = true
    // Belt and braces over `recordOptOut`'s own try/catch: nothing in this
    // method may throw, because the caller has asked to be left alone and
    // an exception here is the request being dropped in silence.
    let out: { suppressed: boolean; message?: string }
    try {
      out = await recordOptOut(this.deps.db, {
        orgId: this.deps.orgId,
        callId: this.deps.callId,
        phone: this.deps.theirNumber,
        now: this.deps.now?.(),
      })
    } catch (err) {
      out = { suppressed: false, message: err instanceof Error ? err.name : 'UnknownError' }
    }
    if (!out.suppressed) {
      // §2.1's obligation: an opt-out that could not be stored must fail
      // loudly to a human, never be swallowed. The caller still gets the
      // promise; the team gets an error they cannot miss.
      this.deps.log.error('OPT-OUT NOT RECORDED — follow up by hand', {
        callId: this.deps.callId,
        reason: out.message ?? 'unknown',
      })
    }
    const say =
      alreadySaid ??
      `Understood. I have ended this and made sure nobody from ${this.deps.orgName} contacts you again. Goodbye.`
    if (!alreadySaid) await this.remember('agent', say)
    this.state = { ...this.state, ending: 'opted_out' }
    return { say, end: true, handoff: { reason: 'opted-out', detail: 'caller asked to be removed' } }
  }

  private async handOff(reason: string, alreadySaid?: string): Promise<SessionAction> {
    this.finished = true
    await recordHandoff(this.deps.db, { orgId: this.deps.orgId, callId: this.deps.callId, reason })
    // Only promise a transfer that can actually happen. With nowhere to
    // send them, say so — the call still ends as a handoff so a person
    // picks it up from the board, but the caller is not told they are being
    // connected to somebody who does not exist.
    const say =
      alreadySaid ??
      (this.deps.canHandOff === false
        ? 'There is nobody on the line to take this right now, so I will make sure somebody calls you back today. Sorry about that.'
        : 'Of course. I will connect you to a person now — one moment.')
    if (!alreadySaid) await this.remember('agent', say)
    this.state = { ...this.state, ending: 'handoff' }
    return { say, end: true, handoff: { reason: 'live-agent-handoff', detail: reason } }
  }

  /**
   * The call is over, however it ended.
   *
   * Safe to call twice — a hang-up and the status callback race, and both
   * legitimately want to close the record.
   */
  async finish(status: 'completed' | 'failed' | 'no_answer' | 'busy' | 'cancelled' = 'completed'): Promise<void> {
    const summary = await this.summarise()
    await endCall(this.deps.db, {
      orgId: this.deps.orgId,
      callId: this.deps.callId,
      status,
      state: this.state,
      // undefined lets endCall write the deterministic extractive summary,
      // which is exactly what happens when no model is configured, when the
      // model is unreachable, or when §5.5 refuses to send a transcript
      // offsite. A call record is never left without a summary because a
      // model was down.
      ...(summary ? { summary } : {}),
      now: this.deps.now?.(),
    }).catch((err: unknown) => {
      this.deps.log.error('could not close the call record', {
        callId: this.deps.callId,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    })
  }

  /**
   * A better summary than the extractive one, if a model will give us one.
   *
   * Returns null rather than a string on every failure path, and the caller
   * treats null as "let the database write the deterministic summary". The
   * transcript is a named person's words, so §5.5's rule applies and is
   * applied by `attemptText` rather than here.
   */
  private async summarise(): Promise<string | null> {
    if (!this.deps.llm || this.transcript.length === 0) return null
    const said = this.transcript
      .filter((e) => e.role !== 'system')
      .map((e) => `${e.role === 'caller' ? 'Caller' : 'Agent'}: ${e.text}`)
      .join('\n')

    const out = await attemptText({
      provider: this.deps.llm,
      allowRemoteForLeadData: this.deps.allowRemoteForLeadData ?? false,
      request: {
        task: 'summarise_call',
        system:
          'You summarise a sales qualification call for the person who will follow it up. ' +
          'Three sentences at most. State only what was said — never infer intent, budget or ' +
          'authority that was not stated. If the caller asked to be left alone, say that first.',
        prompt: said,
        maxTokens: 300,
        temperature: 0,
      },
      fallback: '',
      onRefused: (code, reason) => this.deps.log.info('call summary left to the deterministic one', { code, reason }),
      onFailed: (error) => this.deps.log.warn('the summary model did not answer', { error }),
    })
    // Never the prompt, and never the answer either — the summary is about
    // a named person and belongs in the record, not the log (§2.3).
    if (out.usedModel) this.deps.log.info('call summary written by a model', { provider: out.provider })
    return out.usedModel && out.value.trim() ? out.value.trim() : null
  }

  /** For the tests and the handoff TwiML. */
  get qualification(): QualificationState {
    return this.state
  }
}
