/**
 * An approval card a person can read (2026-10-09).
 *
 * The chat's card showed the tool's payload as JSON — exact, and the wrong
 * shape for the question it asks, which is "may these words go to this
 * person?". This turns a payload into a title, the message it carries (an
 * email's subject and body, a sequence's steps) and a list of facts, one
 * per key, in words — and the card keeps the whole JSON beside it, because
 * somebody deciding whether a message may leave the building has to be
 * able to see exactly what they are approving, and a reading is not the
 * record.
 *
 * Pure, and every key is shown: an unknown key is labelled by its name and
 * its value printed whole, never dropped. No `server-only`, no `@/` import —
 * `test/approval-card.test.ts` imports it.
 */

export interface ApprovalFact {
  readonly label: string
  readonly value: string
}

export interface ApprovalMessage {
  readonly subject: string | null
  readonly body: string
}

export interface ApprovalReading {
  /** "Send an email to …", "Enrol contacts in a campaign", or the tool's own name. */
  readonly title: string
  /** The words that would reach somebody, shown as a message. */
  readonly message: ApprovalMessage | null
  readonly facts: readonly ApprovalFact[]
}

/** The keys that are a message's words, shown as one rather than as facts. */
const MESSAGE_KEYS = new Set(['subject', 'body'])

const LABELS: Readonly<Record<string, string>> = {
  domain: 'Company',
  channel: 'Channel',
  contactId: 'Contact (id)',
  contactEmail: 'Contact',
  campaignId: 'Campaign (id)',
  draftId: 'Draft (id)',
  pausedFor: 'The pause it lifts',
  status: 'Set the status to',
  statusRead: 'Status when read',
  dailyCap: 'Daily cap',
  quietStart: 'Quiet hours start',
  quietEnd: 'Quiet hours end',
  dryRun: 'Dry run',
  limit: 'At most',
  name: 'Name',
  steps: 'Steps',
  why: 'Why',
  reason: 'Reason',
}

const TITLES: Readonly<Record<string, (p: Record<string, unknown>) => string>> = {
  queue_touch: (p) => `Draft ${article(p.channel)} to ${str(p.domain) ?? 'a company'} for approval`,
  edit_draft: () => 'Rewrite a draft that is waiting to go',
  enrol_contacts: (p) => `Enrol contacts in a campaign${p.dryRun === true ? ' (dry run — drafts nothing)' : ''}`,
  resume_contact: () => 'Resume a paused contact, so campaigns may write to them again',
  update_campaign: (p) => (p.status === 'active' ? 'Set a campaign active — its approved messages go on the next pass' : 'Change a campaign'),
  set_campaign_steps: () => 'Set a campaign’s follow-up steps — words that will reach everyone it wrote to',
  activate_icp: (p) => `Make “${str(p.name) ?? 'a profile'}” the active scoring profile`,
}

function article(channel: unknown): string {
  const c = str(channel)
  if (c === 'email') return 'an email'
  if (c === 'linkedin') return 'a LinkedIn message'
  if (c === 'sms') return 'a text'
  return c ? `a ${c} message` : 'a message'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** A value as a person reads it: a string whole, a flag as yes/no, anything else as JSON. */
export function wordFor(v: unknown): string {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v, null, 2)
}

/** A sequence's steps, one line each, in the shape set_campaign_steps takes. */
function stepsWords(v: unknown): string {
  if (!Array.isArray(v)) return wordFor(v)
  return v
    .map((s, i) => {
      const step = (s ?? {}) as Record<string, unknown>
      const after = typeof step.afterDays === 'number' ? `${step.afterDays} day${step.afterDays === 1 ? '' : 's'} later` : 'later'
      const kind = str(step.kind) ?? 'step'
      const words = str(step.body) ? `: “${String(step.body)}”` : ''
      const subject = str(step.subject) ? ` (subject “${String(step.subject)}”)` : ''
      return `${i + 2}. ${kind}, ${after}${subject}${words}`
    })
    .join('\n')
}

/** A connector's tool, `mcp__<server>__<tool>`, named as "<tool> on <server>". */
function connectorTitle(toolName: string): string | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName)
  return m ? `Run ${m[2]} on the ${m[1]} connector` : null
}

export function describeApproval(toolName: string, payload: unknown): ApprovalReading {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const title = TITLES[toolName]?.(p) ?? connectorTitle(toolName) ?? `Run ${toolName}`
  const body = str(p.body)
  const message: ApprovalMessage | null = body ? { subject: str(p.subject), body } : null
  const facts: ApprovalFact[] = []
  for (const [key, value] of Object.entries(p)) {
    if (message && MESSAGE_KEYS.has(key)) continue
    const label = LABELS[key] ?? key
    facts.push({ label, value: key === 'steps' ? stepsWords(value) : wordFor(value) })
  }
  if (Object.keys(p).length === 0 && payload !== undefined && payload !== null && typeof payload !== 'object') {
    facts.push({ label: 'input', value: wordFor(payload) })
  }
  return { title, message, facts }
}
