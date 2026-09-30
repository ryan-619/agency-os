import type { Proposal } from '@agency/core'

/**
 * A proposal as a Markdown file (PROMPT.md §8.6).
 *
 * Pure: the stored document in, a string out. No `env()`, no database, no
 * `server-only` and no `@/` import, because `apps/web/test/proposal-markdown
 * .test.ts` imports it directly.
 *
 * "A proposal is derived, never written" — so this renders the JSON stored
 * when the proposal was generated, never a regeneration from today's scan.
 * What a buyer was sent stays what it was.
 *
 * A Markdown file is the form a proposal is most likely to leave the building
 * in: it is pasted into a mail or a document editor by a person, from their
 * own account. So it carries what the buyer's copy of `<ProposalDocument>`
 * carries and not the team's extras — no score, no tier, no per-item weight;
 * how the pipeline ranks a prospect is the agency's business, not the
 * buyer's. The one thing it keeps from the team's copy is the stale-evidence
 * banner (§2.2): taking that out of a file is a deliberate edit by a person,
 * where leaving it out would be this function deciding the warning did not
 * matter. The route refuses a DRAFT whose evidence is stale outright; the
 * banner is what a `sent` or `accepted` proposal's record carries instead.
 *
 * Only named fields of the document are read. Nothing iterates the stored
 * object, so a field somebody adds to the JSON later is not quoted to a buyer
 * because it happened to be there.
 */

/** Under the Print and Download links on the proposal page. */
export const PROPOSAL_EXPORT_NOTE =
  "The document is the JSON stored when it was generated. Sending it is a person's act, done from their own mail — nothing here sends."

/**
 * The strengths list's framing — the same words `<ProposalDocument>` renders.
 * The ICP's `why` describes the GAP, so the bracketed wording must never read
 * as a strength (CLAUDE.md §2, "The pipeline").
 */
export const IN_PLACE_NOTE =
  'Checked from the outside and not found to be a problem. Out of scope. (The wording in brackets is what the scan looks for, not what it found.)'

/** §2.2: a signal that could not be observed is not assessed, never assumed fine. */
export const NOT_ASSESSED_SENTENCE =
  'These could not be observed from the outside and are excluded from scope — not assumed to be fine.'

/** The 409 the markdown route answers for a draft whose evidence has aged out. */
export function staleDraftRefusal(domain: string): string {
  return (
    `The evidence under this draft has aged out, and stale findings are re-verified before they appear in anything outbound (§2.2). ` +
    `Re-scan ${domain} and generate a fresh proposal; this one is not exported.`
  )
}

/** What the proposal page says instead of a download link that would only 409. */
export const STALE_DRAFT_EXPORT_NOTE =
  'Not downloadable while the evidence under this draft is stale: re-verify before it appears in anything outbound. Re-scan the company and generate a fresh proposal.'

/**
 * Where the evidence came from. Posture review from the outside, in the words
 * every piece of the product's copy must use (CLAUDE.md §1, the scanner).
 */
export function provenanceSentence(domain: string, scannedOn: string): string {
  return (
    `Everything below came from ${domain}'s own public pages, read from the outside on ${scannedOn}. ` +
    'Nothing private was accessed; this is posture review from the outside.'
  )
}

/** The warning a stale proposal carries wherever it goes (§2.2). */
export function staleBannerText(domain: string, scannedOn: string): { lead: string; rest: string } {
  return {
    lead: 'The evidence under this proposal has aged out — re-verify before it appears in anything outbound.',
    rest:
      `It was written from a scan that ran on ${scannedOn}. ` +
      `Re-scan ${domain} and generate a fresh proposal rather than sending this copy.`,
  }
}

/** `YYYY-MM-DD` in UTC, or a phrase that says the date is not known. Never a guess. */
export function isoDate(iso: string | null | undefined): string {
  if (!iso) return 'an unrecorded date'
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'an unrecorded date'
}

/** A download name with nothing in it a header, a shell or a file system could misread. */
export function proposalMarkdownFilename(domain: string, generatedAt: string): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  const ms = Date.parse(generatedAt)
  const date = Number.isFinite(ms) ? `-${new Date(ms).toISOString().slice(0, 10)}` : ''
  return `proposal-${slug || 'company'}${date}.md`
}

export interface ProposalMarkdownInput {
  readonly doc: Proposal
  readonly company: { readonly domain: string; readonly name: string | null }
  readonly agency: { readonly name: string }
  readonly status: string
  /** The scan's `ran_at`, as the caller read it; null when the scan row is gone. */
  readonly evidenceAsOf: string | null
  /** Derived by the caller from `ran_at` with `isStale` (§2.2) — never a stored flag. */
  readonly evidenceStale: boolean
  /** The teammate who generated it, joined at read time; null when nobody is on record. */
  readonly preparedBy?: string | null
}

export function proposalToMarkdown(input: ProposalMarkdownInput): string {
  const { doc, company, agency, status } = input
  const domain = company.domain
  const scannedOn = isoDate(input.evidenceAsOf ?? doc.basedOn.scanRanAt)
  const money = (n: number): string => `${doc.pricing.currency} ${n.toLocaleString('en-US')}`
  const out: string[] = []

  out.push(`# ${text(doc.title)}`, '')
  const by = input.preparedBy ? `${text(input.preparedBy)}, ${text(agency.name)}` : text(agency.name)
  out.push(`Prepared for ${text(company.name ?? domain)} by ${by}.`, '')
  if (status === 'accepted' || status === 'declined' || status === 'withdrawn') {
    out.push(`Status: ${text(status)}.`, '')
  }
  out.push(text(provenanceSentence(domain, scannedOn)), '')

  if (input.evidenceStale) {
    const banner = staleBannerText(domain, scannedOn)
    out.push(`> **${text(banner.lead)}** ${text(banner.rest)}`, '')
  }

  out.push('## Summary', '', text(doc.summary), '', `_Based on the scan of ${isoDate(doc.basedOn.scanRanAt)}._`, '')

  for (const ws of doc.workstreams) {
    out.push(`## ${text(ws.name)} (${ws.effortDays.low}–${ws.effortDays.high} days)`, '', text(ws.summary), '')
    for (const item of ws.items) {
      out.push(`### ${text(item.deliverable)}`, '', `**Why:** ${text(item.why)}`, '')
      if (item.evidence.length === 0) {
        out.push('_No evidence lines were recorded for this item._', '')
      } else {
        out.push('Evidence observed:', '', ...fenced(item.evidence), '')
      }
    }
  }

  out.push(
    '## Pricing',
    '',
    '| | |',
    '| --- | --- |',
    `| Effort | ${doc.pricing.effortDays.low}–${doc.pricing.effortDays.high} days |`,
    `| Day rate | ${doc.pricing.dayRate != null ? text(money(doc.pricing.dayRate)) : 'not set — effort only'} |`,
    `| Total | ${doc.pricing.total ? text(`${money(doc.pricing.total.low)} – ${money(doc.pricing.total.high)}`) : '—'} |`,
    '',
  )

  out.push('## Assumptions', '', ...doc.assumptions.map((a) => `- ${text(a)}`), '')

  if (doc.alreadyInPlace.length > 0) {
    out.push('## Already in place', '', text(IN_PLACE_NOTE), '')
    for (const s of doc.alreadyInPlace) out.push(`- ${code(s.signalKey)} — not the case here (${text(s.why)})`)
    out.push('')
  }

  if (doc.notAssessed.length > 0) {
    out.push('## Not assessed', '', `**${text(NOT_ASSESSED_SENTENCE)}**`, '')
    for (const s of doc.notAssessed) out.push(`- ${code(s.signalKey)} — ${text(s.why)}`)
    out.push('')
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * Inline text, made inert. Every value in the document that did not come from
 * this file — a company's name, an ICP's editable `why` — is somebody else's
 * string, and Markdown turns a stray `*`, `[`, `<` or leading `#` into markup.
 * Newlines fold to spaces and the ends are trimmed, so a value cannot start a
 * heading, a list, a rule or an indented code block of its own. Only the
 * characters that change meaning are escaped, so the file still reads as
 * prose when somebody opens it raw.
 */
function text(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|~#]/g, (c) => `\\${c}`)
    .replace(/&(?=#?[a-z0-9]+;)/gi, '\\&')
    .replace(/^([-+=])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2')
}

/** An inline code span that survives a backtick in its content. */
function code(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ')
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${flat}${pad}${ticks}`
}

/**
 * Evidence, verbatim, in a fence longer than any run of backticks inside it —
 * the scanner quotes a site's own headers and markup back, and a site can
 * serve three backticks as easily as anything else.
 */
function fenced(lines: readonly string[]): string[] {
  const longest = Math.max(0, ...lines.flatMap((l) => l.match(/`{3,}/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}text`, ...lines, fence]
}
