/**
 * A meeting brief (PROMPT.md §8.6, §7's closer: "prepares meeting briefs").
 *
 * One page a person reads in the two minutes before a call: who they are
 * talking to, what the agency actually observed, what has been said so far,
 * where the deal is, and what to ask. Deterministic, so two people preparing
 * for the same meeting read the same brief — and pure, so it can be tested
 * against the edge that matters most: findings that have aged out, which the
 * brief must flag rather than repeat (§2.2).
 *
 * Nothing here is generated prose about the company. The findings are the
 * scan's, the thread is the thread, and the questions are the agency's own
 * standard questions keyed to the gaps it saw.
 */
export interface BriefFinding {
  readonly signalKey: string
  readonly observed: boolean
  readonly gap: boolean | null
  readonly weight: number
  readonly detail: string | null
  /**
   * `findings.scored`. False for an informational signal, which is context on
   * the company page and never a talking point: the brief leaves it out of
   * both the gaps and the things in place. Optional so an older caller that
   * does not pass it still gets the ICP-key filter below.
   */
  readonly scored?: boolean
}

export interface BriefTouch {
  readonly direction: 'in' | 'out'
  readonly status: string
  readonly subject: string | null
  readonly body: string | null
  readonly at: Date
}

export interface BriefInput {
  readonly meeting: { readonly startsAt: Date; readonly timeZone: string; readonly title: string | null }
  readonly company: { readonly domain: string; readonly name: string | null; readonly country: string | null }
  readonly contacts: readonly { readonly name: string; readonly title: string | null; readonly email: string | null }[]
  readonly deal: { readonly stage: string; readonly nextAction: string | null; readonly valueCents: number | null } | null
  /** The ICP's signals — only `why` is read. Empty when there is no ICP. */
  readonly signals: Readonly<Record<string, { readonly why: string }>>
  readonly findings: readonly BriefFinding[]
  readonly scan: { readonly ranAt: Date; readonly stale: boolean; readonly ok: boolean } | null
  readonly score: { readonly score: number; readonly tier: string | null } | null
  /** Most recent first. */
  readonly thread: readonly BriefTouch[]
}

export interface Brief {
  readonly headline: string
  readonly when: string
  readonly who: readonly string[]
  readonly posture: {
    readonly summary: string
    readonly gaps: readonly { readonly signalKey: string; readonly why: string; readonly detail: string | null }[]
    readonly strengths: readonly string[]
    readonly caveat: string | null
  }
  readonly conversation: readonly string[]
  readonly deal: string
  readonly agenda: readonly string[]
  readonly questions: readonly string[]
}

/** The question worth asking about each gap, in the buyer's language. */
const QUESTIONS: Readonly<Record<string, string>> = {
  csp: 'Has a customer security questionnaire ever asked about Content-Security-Policy? What happened?',
  hsts: 'Is anything still served over plain HTTP anywhere in the product?',
  trust_page: 'Where do prospects go today when procurement asks for your security posture?',
  compliance_claim: 'Has a deal stalled or slowed on SOC 2 or ISO 27001? Is there a timeline?',
  security_txt: 'If a researcher found something tomorrow, how would they reach you — and who would answer?',
  outdated_js: 'Who owns front-end dependency updates, and how often do they happen?',
  tls: 'When was the TLS configuration last reviewed, and by whom?',
  server_banner: 'Is there a reason the server version is disclosed, or has nobody looked?',
  frame_protection: 'Does anything legitimately embed your app in a frame?',
}

export function meetingBrief(input: BriefInput): Brief {
  const companyName = input.company.name ?? input.company.domain
  const signals = input.signals

  const fresh = input.scan !== null && input.scan.ok && !input.scan.stale
  // Only what the score was computed from is a posture talking point. A row
  // marked unscored is out, and so — when there IS an ICP to ask — is any key
  // the ICP does not name, which catches a caller that never mapped `scored`.
  const scoredOnly = input.findings.filter(
    (f) => f.scored !== false && (Object.keys(signals).length === 0 || f.signalKey in signals),
  )
  const gaps = fresh
    ? scoredOnly
        .filter((f) => f.observed && f.gap === true)
        .sort((a, b) => b.weight - a.weight)
        .map((f) => ({ signalKey: f.signalKey, why: signals[f.signalKey]?.why ?? f.signalKey, detail: f.detail }))
    : []
  // Signal KEYS, not the ICP's `why`: `why` is written as the gap ("No
  // Content-Security-Policy — …"), so quoting it under "already in place"
  // states the opposite of what was observed. The first live brief did.
  const strengths = fresh
    ? scoredOnly
        .filter((f) => f.observed && f.gap === false)
        .map((f) => f.signalKey)
    : []

  // §2.2. A stale scan is not quoted; it is named as the reason the posture
  // section is thin, and the fix is in the caveat.
  let caveat: string | null = null
  if (!input.scan) caveat = `${input.company.domain} has never been scanned. Nothing below is about their posture; scan them before the call.`
  else if (!input.scan.ok) caveat = `The last scan (${day(input.scan.ranAt)}) never reached the site. Nothing was observed; scan again before quoting anything.`
  else if (input.scan.stale) caveat = `The last scan ran on ${day(input.scan.ranAt)} and has aged out. Do not quote its findings in the meeting — re-scan first (§2.2).`

  const posture = fresh
    ? `Scanned ${day(input.scan!.ranAt)}${input.score ? `: ${input.score.score}/100${input.score.tier ? `, tier ${input.score.tier}` : ''}` : ''}. ` +
      `${gaps.length} gap${gaps.length === 1 ? '' : 's'} observed, ${strengths.length} thing${strengths.length === 1 ? '' : 's'} already in place.`
    : 'No current evidence.'

  const conversation = input.thread.slice(0, 8).map((t) => {
    const who = t.direction === 'in' ? 'They wrote' : t.status === 'sent' || t.status === 'delivered' ? 'We sent' : `We ${t.status.replace(/_/g, ' ')}`
    const first = (t.body ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
    return `${day(t.at)} — ${who}: ${t.subject ?? '(no subject)'}${first ? ` — "${first.slice(0, 120)}${first.length > 120 ? '…' : ''}"` : ''}`
  })

  const deal = input.deal
    ? `Stage: ${input.deal.stage}${input.deal.nextAction ? ` · next: ${input.deal.nextAction}` : ''}${
        input.deal.valueCents ? ` · value ${(input.deal.valueCents / 100).toLocaleString('en-US')}` : ''
      }`
    : 'No deal recorded yet.'

  const agenda = [
    'Confirm who is on the call and what they own.',
    ...(gaps.length > 0
      ? [`Walk through the ${Math.min(gaps.length, 3)} most consequential things observed from the outside, with the evidence on screen.`]
      : []),
    'Ask what a security questionnaire or a lost deal has cost them recently.',
    'Agree whether a scoped remediation proposal is worth writing, and who would read it.',
    'Agree the next step and the date.',
  ]

  const questions = [
    ...gaps.slice(0, 4).map((g) => QUESTIONS[g.signalKey] ?? `What is the story behind ${g.why.toLowerCase()}?`),
    'Who signs off on security spend, and what does their year look like?',
  ]

  return {
    headline: input.meeting.title ?? `Meeting with ${companyName}`,
    when: `${input.meeting.startsAt.toISOString()} (${input.meeting.timeZone})`,
    who: input.contacts.map((c) => `${c.name}${c.title ? `, ${c.title}` : ''}${c.email ? ` <${c.email}>` : ''}`),
    posture: { summary: posture, gaps, strengths, caveat },
    conversation,
    deal,
    agenda,
    questions,
  }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}
