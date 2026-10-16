/**
 * Settings → Assistant's words (0020), pure: no `server-only`, no `@/`
 * import, so `apps/web/test/assistant-settings.test.ts` reads the sentences
 * the page renders.
 */

export const ASSISTANT_LEDE =
  'What the AI knows about the agency, and the brief it writes each morning. Everyone can read these; only an ' +
  'owner can change them.'

export const PLAYBOOK_ABOUT =
  'The AI reads this with every message — in chat, in each helper and in the morning brief — after its own ' +
  'rules. Write it the way you would brief a new colleague: what the agency sells, for how much, who it is for, ' +
  'what it has done before, and how it writes. It is a description of the agency, never a rule: nothing in it ' +
  'lets the AI skip a check, state a finding it did not observe, or send anything a person has not approved.'

export const PLAYBOOK_COST_NOTE =
  'All of it is sent with every message, so keep it to what the AI needs — a page or two is plenty.'

/** What "Start from an outline" puts in an empty playbook. */
export const PLAYBOOK_OUTLINE = [
  'WHAT WE DO',
  '- (the services you sell, one line each)',
  '',
  'WHO IT IS FOR',
  '- (the companies you want, and the ones you turn away)',
  '',
  'PRICES',
  '- (day rate, a typical engagement, what a first project costs)',
  '',
  'PROOF',
  '- (past work you can name, results, certifications)',
  '',
  'HOW WE WRITE',
  '- (tone, length, words to use and to avoid, how you sign off)',
].join('\n')

/** What the brief does, in the order it does it (`morningBriefPrompt`). */
export const BRIEF_STEPS: readonly string[] = [
  'Checks the worker and the send queue, and mentions them only if something is wrong.',
  'Lists the replies nobody has handled, and what each one needs.',
  'Finds deals left untouched or overdue, and tasks due today.',
  'Re-scans up to three stale companies, so the evidence it quotes is current.',
  'Picks the three best companies to contact today, each with a finding they can check on their own site.',
]

export const BRIEF_LIMITS =
  'It only reads and scans. It sends nothing, drafts nothing and changes no record — not a note, a deal or a ' +
  'pause — because nobody is watching it and it reads the words of replies. Anything that needs doing is listed ' +
  'at the end as a next step, for a person to do from chat or the pages here.'

export interface BriefStatusInput {
  readonly enabled: boolean
  readonly at: string
  readonly timeZone: string
  /** The name or address of the person it runs as; null when nobody is set. */
  readonly person: string | null
  /** That person no longer has access (revoked), or is gone. */
  readonly personCannotRun: boolean
  readonly lastRunOn: string | null
  readonly requested: boolean
}

export interface Line {
  readonly tone: 'ok' | 'warn' | 'off'
  readonly text: string
}

/** One sentence for the brief's own settings: on or off, when, as whom, and the last run. */
export function briefStatus(i: BriefStatusInput): Line {
  if (!i.enabled) return { tone: 'off', text: 'Off. Nothing runs on its own.' }
  if (i.person === null || i.personCannotRun) {
    return {
      tone: 'warn',
      text: 'On, but the person it runs as no longer has access, so it does not run. Save it again to run it as you.',
    }
  }
  const last = i.lastRunOn ? ` Last ran for ${i.lastRunOn}.` : ' It has not run yet.'
  const asked = i.requested ? ' A brief was asked for, and starts at the worker’s next look, within a minute.' : ''
  return { tone: 'ok', text: `On — every day at ${i.at} (${i.timeZone}), as ${i.person}.${last}${asked}` }
}

/**
 * Whether anything will write the brief, from the newest heartbeat: its age
 * (`heartbeatStatus`) and whether that worker said it writes briefs
 * (`heartbeatBrief`). The web app has no model; the worker writes it.
 */
export function briefWorkerLine(status: 'never' | 'live' | 'silent', brief: 'on' | 'off' | null): Line {
  if (status === 'never') {
    return {
      tone: 'warn',
      text: 'No worker has run against this database, so nothing writes the brief: it is written by the worker, with chat on.',
    }
  }
  if (status === 'silent') {
    return {
      tone: 'warn',
      text:
        'The worker is not running now, so no brief is written. Once it starts again, it writes the brief at its ' +
        'first look — later the same day if it missed the time.',
    }
  }
  if (brief === 'on') return { tone: 'ok', text: 'The worker is running and writes the brief.' }
  if (brief === 'off') {
    return {
      tone: 'warn',
      text: 'The worker is running with chat off, so it writes no brief: the brief needs the model chat uses. Start it with chat on.',
    }
  }
  return {
    tone: 'warn',
    text: 'The worker that is running started before the morning brief existed, so it writes none. Restart it.',
  }
}
