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
 *
 * The gate names a tool in full — `mcp__agency__queue_touch` — and that is
 * what reaches a card, in chat and on /approvals alike. The titles are keyed
 * by the bare name, so the agency's prefix comes off before they are looked
 * up (2026-10-15): until then every agency card fell through to "Run
 * queue_touch on the agency connector", and the tests, which passed bare
 * names, never saw it.
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
  contacts: 'People',
  companies: 'Companies',
  companyId: 'Company (id)',
  meetingId: 'Meeting (id)',
  taskId: 'Task (id)',
  title: 'Title',
}

const TITLES: Readonly<Record<string, (p: Record<string, unknown>) => string>> = {
  queue_touch: (p) => `Draft ${article(p.channel)} to ${str(p.domain) ?? 'a company'} for approval`,
  edit_draft: () => 'Rewrite a draft that is waiting to go',
  enrol_contacts: (p) => `Enrol contacts in a campaign${p.dryRun === true ? ' (dry run — drafts nothing)' : ''}`,
  resume_contact: () => 'Resume a paused contact, so campaigns may write to them again',
  update_campaign: (p) => (p.status === 'active' ? 'Set a campaign active — its approved messages go on the next pass' : 'Change a campaign'),
  set_campaign_steps: () => 'Set a campaign’s follow-up steps — words that will reach everyone it wrote to',
  activate_icp: (p) => `Make “${str(p.name) ?? 'a profile'}” the active scoring profile`,
  // Delete, and what it will not delete (2026-10-15): each says what goes, and that it cannot come back.
  delete_contacts: (p) => `Delete ${countOf(p.contacts, 'contact', 'contacts')} from the CRM — it cannot be undone`,
  delete_companies: (p) => {
    const list = Array.isArray(p.companies) ? p.companies : []
    const only = list.length === 1 ? str((list[0] as Record<string, unknown> | null)?.domain) : null
    const which = only && !only.includes('@') ? `company ${only}` : countOf(list, 'company', 'companies')
    return `Delete ${which} and everything filed under ${list.length === 1 ? 'it' : 'them'} — it cannot be undone`
  },
  delete_meeting: (p) => `Delete a meeting${str(p.domain) && !String(p.domain).includes('@') ? ` with ${String(p.domain)}` : ''} — it cannot be undone`,
  delete_task: (p) => `Delete the task${str(p.title) ? ` “${String(p.title)}”` : ''} — it cannot be undone`,
}

/** "3 contacts", "1 contact" — of a list the model sent, or "the listed contacts" when it sent none. */
function countOf(v: unknown, one: string, many: string): string {
  if (!Array.isArray(v) || v.length === 0) return `the listed ${many}`
  return `${v.length} ${v.length === 1 ? one : many}`
}

/** The agency's own tools reach a card as `mcp__agency__<tool>`; the titles are keyed by `<tool>`. */
const AGENCY_PREFIX = 'mcp__agency__'

function bareName(toolName: string): string {
  return toolName.startsWith(AGENCY_PREFIX) ? toolName.slice(AGENCY_PREFIX.length) : toolName
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

/**
 * Whether every item of a list is an object carrying only the keys a list
 * renderer prints, each of the type it prints — anything else is printed
 * whole by `wordFor`, because a renderer that reads one shape drops what
 * another carries.
 */
function fits(v: unknown, shape: Readonly<Record<string, 'string' | 'number'>>): v is Record<string, unknown>[] {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.entries(item).every(([k, value]) => Object.hasOwn(shape, k) && typeof value === shape[k]),
    )
  )
}

/** A sequence's steps, one line each, in the shape set_campaign_steps takes. */
function stepsWords(v: unknown): string {
  if (!fits(v, { kind: 'string', afterDays: 'number', subject: 'string', body: 'string' })) return wordFor(v)
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

/** The people a delete names, one line each: their name, their email's domain and their id. */
function contactsWords(v: unknown): string {
  if (!fits(v, { contactId: 'string', name: 'string', emailDomain: 'string' })) return wordFor(v)
  return v
    .map((c, i) => {
      const item = (c ?? {}) as Record<string, unknown>
      const parts = [
        str(item.name) ?? '(no name given)',
        str(item.emailDomain) ? `email at ${String(item.emailDomain).replace(/^.*@/, '')}` : null,
        str(item.contactId) ? `id ${String(item.contactId)}` : null,
      ].filter((part): part is string => part !== null)
      return `${i + 1}. ${parts.join(' · ')}`
    })
    .join('\n')
}

/** The companies a delete names, one line each: their domain and their id. */
function companiesWords(v: unknown): string {
  if (!fits(v, { companyId: 'string', domain: 'string' })) return wordFor(v)
  return v
    .map((c, i) => {
      const item = (c ?? {}) as Record<string, unknown>
      const parts = [str(item.domain) ?? '(no domain given)', str(item.companyId) ? `id ${String(item.companyId)}` : null]
      return `${i + 1}. ${parts.filter((part): part is string => part !== null).join(' · ')}`
    })
    .join('\n')
}

/**
 * Lists a person reads one line at a time, by the agency tool that sends
 * them and then the key — never by the key alone (review, 2026-10-15): a
 * connector's `contacts` or `companies` (Apollo, HubSpot, a CRM adding people
 * to a sequence) was read through the delete's renderer, and its emails,
 * names and ids printed as "(no name given)", on the card that decides
 * whether those people are reached. Any other list is printed whole.
 */
const LIST_WORDS: Readonly<Record<string, Readonly<Record<string, (v: unknown) => string>>>> = {
  set_campaign_steps: { steps: stepsWords },
  delete_contacts: { contacts: contactsWords },
  delete_companies: { companies: companiesWords },
}

/** How one key of one tool's payload is read: its tool's renderer for that key, or `wordFor`. */
function readerFor(bare: string, key: string): (v: unknown) => string {
  const byKey = Object.hasOwn(LIST_WORDS, bare) ? LIST_WORDS[bare]! : null
  return byKey && Object.hasOwn(byKey, key) ? byKey[key]! : wordFor
}

/** A connector's tool, `mcp__<server>__<tool>`, named as "<tool> on <server>". */
function connectorTitle(toolName: string): string | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName)
  return m ? `Run ${m[2]} on the ${m[1]} connector` : null
}

export function describeApproval(toolName: string, payload: unknown): ApprovalReading {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const bare = bareName(toolName)
  const agency = bare !== toolName
  // Own keys only: a tool or a key named `constructor` must not find Object's.
  const title = (Object.hasOwn(TITLES, bare) ? TITLES[bare]!(p) : null) ?? (agency ? null : connectorTitle(toolName)) ?? `Run ${bare}`
  const body = str(p.body)
  const message: ApprovalMessage | null = body ? { subject: str(p.subject), body } : null
  const facts: ApprovalFact[] = []
  for (const [key, value] of Object.entries(p)) {
    if (message && MESSAGE_KEYS.has(key)) continue
    const label = Object.hasOwn(LABELS, key) ? LABELS[key]! : key
    facts.push({ label, value: readerFor(bare, key)(value) })
  }
  if (Object.keys(p).length === 0 && payload !== undefined && payload !== null && typeof payload !== 'object') {
    facts.push({ label: 'input', value: wordFor(payload) })
  }
  return { title, message, facts }
}
