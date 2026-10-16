/**
 * What a conversation has shown the agent (2026-10-13) — the evidence behind
 * "true data only".
 *
 * The chat agent stored people it had invented and addresses it had composed
 * from a name and a pattern (`akash@farmley.com` after a search returned only
 * a LinkedIn profile). A sentence in the prompt did not stop it, so the rule
 * moved to where the write happens: an email, a phone, a named person or a
 * website the agent writes must have been SHOWN to it in this conversation —
 * typed by the person it is helping, or returned by a tool — and the tools
 * that write ask this ledger where (`ToolContext.conversation`).
 *
 * What counts as shown, and what never does:
 *
 *  - the PERSON's own messages: added as a turn starts (`addPerson`), and the
 *    session's stored `role = 'user'` rows read once, lazily, on the first
 *    question — so a value typed in an earlier turn, or before the worker
 *    restarted, still counts. The morning brief's prompt is stored as a user
 *    row too and is our own words, so it is never read as the person's;
 *  - a TOOL's result, fed by the gate's PostToolUse hook for the main thread
 *    and helpers alike, before the model sees it: every string inside it, up
 *    to 200,000 characters, tagged with the tool's name as the CLI names it
 *    (`mcp__exa__web_search_exa`). Only a tool that reads from outside the
 *    agency counts — a connector's, or one of the agency's own readers of the
 *    open web, a Google listing or a scan (`READS_FROM_OUTSIDE`). The
 *    agency's other tools replay what the agency itself recorded, the
 *    assistant's own notes, research claims and the people it once invented
 *    among them, so a guess written down and read back would come back as
 *    "seen"; and a helper's answer (`Agent`) is a model's own words;
 *  - never the assistant's words, and never a tool's INPUT. And a value the
 *    model typed into a call cannot come back from that same call as seen: an
 *    echo is stripped first (`stripEchoes`) — every value of the call's input
 *    of four characters or more where it stands as a whole word, as typed and
 *    as a server would decode it (a URL's host, path and query, `%40`, `+`,
 *    an HTML entity); every address in it; every website host in it, so a
 *    page cannot vouch for the domain it was read from; and every phone
 *    number in it however the result writes it.
 *
 * And a tool's answer shows a value only where it stands together: a test
 * must hold within a few hundred characters of it (`LEDGER_NEAR_CHARS`), so a
 * first name in one search result and a surname in another never name a
 * person.
 *
 * Bounded, in memory, per worker process: 2 MB of tool text per session
 * (oldest dropped first), 300 sessions (least recently used dropped), and a
 * session forgotten six hours after anything was last added to it.
 */
import { and, desc, eq } from 'drizzle-orm'
import { findEmailsIn, findPhonesIn } from '@agency/core'
import { schema, type AgencyDb } from '@agency/db'
import type { ConversationLedger, SeenOrigin } from '@agency/tools'

/** `ToolContext.conversation`'s shape (packages/tools spec.ts): `tool` is the full name the CLI gives it. */
export type { ConversationLedger, SeenOrigin }

export interface SessionLedger extends ConversationLedger {
  /** The person's own message, as a turn starts. Never the morning brief's prompt, which is ours. */
  addPerson(text: string): void
  /** A tool's result, with that call's own input stripped out of it first. */
  addToolResult(toolName: string, response: unknown, input: unknown): void
}

/** One tool result is read this far; past it, it is a document, and its start says what it is. */
export const LEDGER_RESULT_MAX_CHARS = 200_000
/** Tool text kept per session; the oldest results go first. */
export const LEDGER_TOOL_TEXT_MAX = 2_000_000
/** The person's own words kept per session; the oldest go first. */
export const LEDGER_PERSON_TEXT_MAX = 1_000_000
export const LEDGER_SESSIONS_MAX = 300
/** A session nothing was added to for this long is forgotten. */
export const LEDGER_IDLE_MS = 6 * 60 * 60_000
/** How many of the session's stored person messages are read, newest first. */
export const LEDGER_STORED_PERSON_MESSAGES = 200
/** A typed value shorter than this is a word, not a value, and is left in a result. */
export const ECHO_MIN_CHARS = 4
/** A call with more typed values than this is not read at all: it could not be stripped cheaply. */
export const ECHO_MAX_VALUES = 1_000
/** Nor one whose values, in every spelling a server might print back, make more to strip than this. */
export const ECHO_MAX_NEEDLES = 2_000

/**
 * The agency's own tools that read from outside the agency — a public page,
 * a Google listing, a scan of a site, PageSpeed — and so may show the agent
 * something true it did not know. Every other agency tool reads the agency's
 * own records, which the assistant itself writes to. A tool added later
 * counts only once it is listed here: left out, it shows nothing, which
 * refuses a write rather than letting a guess through.
 *
 * Two readers that also reach outside are left out on purpose, because their
 * answers print the CRM's own people beside what they read: `check_contacts`
 * names every contact on file at the company, and `get_replies` names the
 * contact a reply was filed under and their company's domain. The people the
 * assistant invented before 2026-10-13 are still on file under those names,
 * and read back through either tool they would come back as "seen".
 */
export const READS_FROM_OUTSIDE: ReadonlySet<string> = new Set([
  'read_page',
  'find_contact_details',
  'find_businesses',
  'scan_company',
  'audit_website',
])

/** Whether a tool's result can show the agent a value: a connector's, or one of the readers above. */
export function resultCountsAsShown(toolName: string): boolean {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return false
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0) return false
  const server = rest.slice(0, cut)
  const tool = rest.slice(cut + 2)
  if (tool === '') return false
  return server !== 'agency' || READS_FROM_OUTSIDE.has(tool)
}

/** The morning brief's prompt opens with these words (`briefHeader`); it is stored as a user row. */
const BRIEF_PROMPT = /^MORNING BRIEF for /

/** Binary content blocks carry no words. */
const BINARY_BLOCK = new Set(['image', 'audio'])

/**
 * Every string inside a tool's response, in order, joined by line breaks and
 * read to `max` characters. MCP results are `{ content: [{ type: 'text',
 * text }] }`, a bare array of such blocks, or a string; anything else is read
 * the same way, string by string. A block's `type` is a label, not words, and
 * an image or audio block is skipped whole, so neither can fill the budget or
 * stand in front of an error's own first line.
 */
export function toolResponseText(value: unknown, max = LEDGER_RESULT_MAX_CHARS): string {
  const parts: string[] = []
  let left = max
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number): void => {
    if (left <= 0) return
    if (typeof v === 'string') {
      if (v === '') return
      const part = v.length > left ? v.slice(0, left) : v
      parts.push(part)
      left -= part.length + 1
      return
    }
    if (depth > 32 || v === null || typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    const rec = v as Record<string, unknown>
    if (typeof rec['type'] === 'string' && BINARY_BLOCK.has(rec['type'])) return
    for (const [key, item] of Object.entries(rec)) {
      if (key === 'type' || key === '_meta' || key === 'mimeType') continue
      walk(item, depth + 1)
    }
  }
  walk(value, 0)
  return parts.join('\n')
}

/**
 * What the model typed into a call: every string value inside its input, and
 * every number (a phone number passed as one is still a phone number), in
 * order; and, apart, every key — a key is read for an address, a number or a
 * host in it, never stripped as a word.
 */
function typedValues(input: unknown): { readonly values: string[]; readonly keys: string[] } {
  const values: string[] = []
  const keys: string[] = []
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number): void => {
    if (values.length + keys.length > ECHO_MAX_VALUES) return
    if (typeof v === 'string') {
      values.push(v)
      return
    }
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint') {
      values.push(String(v))
      return
    }
    if (depth > 32 || v === null || typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(v)) {
      keys.push(key)
      walk(item, depth + 1)
    }
  }
  walk(input, 0)
  return { values, keys }
}

/** What a removed echo is replaced with: a break no word, address or phone number reads across. */
const GAP = ' ¦ '

/**
 * Lower-case without changing the length, so an index into the folded text is
 * an index into the text. `toLowerCase` keeps the length for nearly every
 * text; where it does not (a dotted capital I), each unit is folded alone.
 */
function foldSameLength(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (const c of text) {
    const l = c.toLowerCase()
    out += l.length === c.length ? l : c
  }
  return out
}

const WORD_CHAR = /[\p{L}\p{N}]/u
const isWordChar = (c: string | undefined): boolean => c !== undefined && WORD_CHAR.test(c)

/**
 * Whether the stretch [at, end) of `text` is part of an email address — the
 * local part before an `@`, or the domain after one (or after `%40`). A typed
 * word or host is left standing there: an address in a result the model did
 * not type whole is the result's own, and a whole typed address is stripped
 * by its own needle.
 */
function inAnAddress(text: string, at: number, end: number): boolean {
  return (
    text[at - 1] === '@' ||
    text[end] === '@' ||
    text.slice(Math.max(0, at - 3), at).toLowerCase() === '%40' ||
    text.slice(end, end + 3).toLowerCase() === '%40'
  )
}

type Match = 'word' | 'value' | 'host'

/**
 * The ranges of `text` where `needle` stands.
 *
 *  - `word`: anywhere it stands as a whole word, on any side where it starts
 *    or ends with one — a typed address, which is stripped wherever it is;
 *  - `value`: the same, but never inside an email address (`inAnAddress`) — a
 *    typed word, query or URL piece;
 *  - `host`: a website host, on a host boundary as `textShowsDomain` reads
 *    one (nothing of a host's own letters, digits or dash either side), and
 *    never inside an email address.
 */
function rangesOf(text: string, folded: string, needle: string, how: Match, out: Array<[number, number]>): void {
  const want = foldSameLength(needle)
  if (want.length === 0) return
  const wordStart = isWordChar(needle[0])
  const wordEnd = isWordChar(needle[needle.length - 1])
  let from = 0
  for (;;) {
    const at = folded.indexOf(want, from)
    if (at === -1) return
    const end = at + want.length
    let fits: boolean
    if (how === 'host') {
      fits = !/[a-z0-9-]/i.test(text[at - 1] ?? '') && !/[a-z0-9-]/i.test(text[end] ?? '') && !inAnAddress(text, at, end)
    } else {
      fits = (!wordStart || !isWordChar(text[at - 1])) && (!wordEnd || !isWordChar(text[end]))
      if (fits && how === 'value' && inAnAddress(text, at, end)) fits = false
    }
    if (fits) {
      out.push([at, end])
      from = end
    } else {
      from = at + 1
    }
  }
}

/** Between two digits of a phone number, what a person types: spaces, dots, dashes, brackets, a slash. */
const PHONE_SEPARATOR = '[\\s.\\-\\u2010-\\u2015()/]{0,4}'
/** The tail of a number taken out of a result: enough that no reader can find the whole number left. */
const PHONE_TAIL_DIGITS = 7
/** A run of digits typed as a number might be — with what a person puts between them. */
const TYPED_DIGITS = /\d(?:[\s.\-\u2010-\u2015()/]{0,3}\d){6,}/g

/**
 * A website host: labels, and a top-level label of two or more characters
 * starting with a letter. Tested only whole, on one run of host characters at
 * most 253 long (`hostsIn`), never searched for across a text — searched for,
 * this pattern backtracks quadratically on a run like `a.a.a.…`, and the text
 * is the model's.
 */
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i
/** What a host is made of; anything else ends a run. */
const HOST_RUN = /[a-z0-9.-]+/gi

/** Every website host standing in a text, lower-cased: each run of host characters that is one, in linear time. */
function hostsIn(text: string): string[] {
  const out: string[] = []
  const edge = (c: string | undefined): boolean => c === '.' || c === '-'
  for (const m of text.matchAll(HOST_RUN)) {
    const raw = m[0]
    let from = 0
    let to = raw.length
    while (from < to && edge(raw[from])) from++
    while (to > from && edge(raw[to - 1])) to--
    if (to - from < 4 || to - from > 253) continue
    const run = raw.slice(from, to)
    if (!run.includes('.')) continue
    if (HOST_SHAPE.test(run)) out.push(run.toLowerCase())
  }
  return out
}
/** A URL standing inside a longer typed value. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** A bare host, with or without a path: `127atelier.in/pages/contact`. */
const BARE_HOST_URL = /^[^\s/?#@:]+\.[a-z]{2,}(?:[/?#]|$)/i

/** Percent-escapes decoded where they decode; one that does not is left as it is. */
function percentDecoded(text: string): string {
  if (!text.includes('%')) return text
  try {
    return decodeURIComponent(text)
  } catch {
    return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
  }
}

/** The handful of HTML entities a page would turn back into an address or a host. */
function entityDecoded(text: string): string {
  if (!text.includes('&')) return text
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (m, hex: string) => fromCodePoint(Number.parseInt(hex, 16)) ?? m)
    .replace(/&#(\d{1,7});?/g, (m, dec: string) => fromCodePoint(Number.parseInt(dec, 10)) ?? m)
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/gi, '&')
}

function fromCodePoint(cp: number): string | null {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null
}

/**
 * A typed value as a server might hand it back: as typed, in its compatibility
 * form (a full-width `＠`), percent-decoded (with `+` as a space, as a query
 * is read), and with its HTML entities read.
 */
function spellingsOf(value: string): string[] {
  const out = new Set<string>([value])
  const nfkc = value.normalize('NFKC')
  out.add(nfkc)
  for (const v of [value, nfkc]) {
    const decoded = percentDecoded(v)
    out.add(decoded)
    out.add(percentDecoded(v.replace(/\+/g, ' ')))
    out.add(entityDecoded(v))
    out.add(entityDecoded(decoded))
  }
  return [...out]
}

/**
 * The pieces of a URL a server decodes and may print back: its host, each
 * path segment, each query value and its fragment — and a slug's words
 * (`akash-gupta` as "akash gupta"), as a search page shows them.
 */
function urlPieces(value: string): string[] {
  const candidates = new Set<string>()
  const trimmed = value.trim()
  if (HAS_SCHEME.test(trimmed)) candidates.add(trimmed)
  else if (BARE_HOST_URL.test(trimmed)) candidates.add(`https://${trimmed}`)
  for (const m of value.matchAll(URL_IN_TEXT)) candidates.add(m[0])
  const pieces: string[] = []
  for (const candidate of candidates) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    pieces.push(url.hostname, percentDecoded(url.username), percentDecoded(url.password))
    for (const segment of url.pathname.split('/')) pieces.push(percentDecoded(segment))
    for (const [, v] of url.searchParams) pieces.push(v)
    pieces.push(percentDecoded(url.hash.slice(1)))
  }
  const out: string[] = []
  for (const piece of pieces) {
    if (piece === '') continue
    out.push(piece)
    const words = piece.replace(/[-_+]+/g, ' ')
    if (words !== piece) out.push(words)
  }
  return out
}

/**
 * A tool's result with every echo of its own input taken out, so a value the
 * model typed can never come back from that call as seen. Taken out:
 *
 *  - each value the call was given of `ECHO_MIN_CHARS` or more, where it
 *    stands as a whole word (`auto` is taken out of "type: auto" but not out
 *    of `autodesk.com`), as typed and as a server decodes it — a URL's host,
 *    path, query and fragment, percent-escapes, `+`, an HTML entity, a
 *    full-width character — because a search page prints `?q=akash%40x.com`
 *    back as "akash@x.com", and a page answers a slug in its own words;
 *  - every website host in the input, wherever it stands as a host, so a page
 *    read at a domain the model guessed — or a search for it — cannot vouch
 *    for that domain by naming it (read_page's own first line names the page
 *    it read). Whether a guessed domain is the business's own is for its
 *    homepage to say, in the tool that adds it;
 *  - every address in the input, in any spelling above (and its `%40` form);
 *  - every phone number in the input, however the result writes it — its last
 *    seven digits wherever they stand, which leaves no reader the whole number.
 *
 * A typed word or host is left standing inside an email address the result
 * shows (`farmley` in `info@farmley.com`): that address is the result's own,
 * unless the whole address was typed, and then it goes by its own needle.
 * Answers null when the input has more values than can be stripped cheaply:
 * such a result is not read.
 */
export function stripEchoes(text: string, input: unknown): string | null {
  const { values, keys } = typedValues(input)
  if (values.length + keys.length > ECHO_MAX_VALUES) return null

  const words = new Set<string>()
  const read: string[] = [...keys]
  for (const value of values) {
    for (const spelling of spellingsOf(value)) {
      read.push(spelling)
      const t = spelling.trim()
      if (t.length >= ECHO_MIN_CHARS) words.add(t)
      for (const piece of urlPieces(spelling)) {
        read.push(piece)
        const p = piece.trim()
        if (p.length >= ECHO_MIN_CHARS) words.add(p)
      }
    }
  }
  for (const key of keys) for (const spelling of spellingsOf(key)) read.push(spelling)
  const joined = read.join('\n')

  const emails = new Set<string>()
  for (const email of findEmailsIn(joined)) {
    emails.add(email)
    emails.add(email.replace('@', '%40'))
  }
  const hosts = new Set<string>()
  for (const host of hostsIn(joined)) {
    hosts.add(host)
    if (host.startsWith('www.') && host.length > 4) hosts.add(host.slice(4))
  }
  const tails = new Set<string>()
  for (const e164 of findPhonesIn(joined, { defaultCountry: 'IN' })) {
    const digits = e164.replace(/\D/g, '')
    if (digits.length >= PHONE_TAIL_DIGITS) tails.add(digits.slice(-PHONE_TAIL_DIGITS))
  }
  for (const m of joined.matchAll(TYPED_DIGITS)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= PHONE_TAIL_DIGITS) tails.add(digits.slice(-PHONE_TAIL_DIGITS))
  }
  if (words.size + emails.size + hosts.size + tails.size === 0) return text
  if (words.size + emails.size + hosts.size + tails.size > ECHO_MAX_NEEDLES) return null

  const ranges: Array<[number, number]> = []
  const folded = foldSameLength(text)
  for (const email of emails) rangesOf(text, folded, email, 'word', ranges)
  for (const word of words) rangesOf(text, folded, word, 'value', ranges)
  for (const host of hosts) rangesOf(text, folded, host, 'host', ranges)
  for (const tail of tails) {
    const pattern = new RegExp([...tail].join(PHONE_SEPARATOR), 'g')
    for (const m of text.matchAll(pattern)) {
      if (m.index !== undefined && m[0].length > 0) ranges.push([m.index, m.index + m[0].length])
    }
  }
  if (ranges.length === 0) return text

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let out = ''
  let at = 0
  for (const [start, end] of ranges) {
    if (end <= at) continue
    if (start > at) out += text.slice(at, start)
    out += GAP
    at = Math.max(at, end)
  }
  return out + text.slice(at)
}

/**
 * How near together a tool's answer must show what a test looks for: within a
 * stretch of this many characters. An address, a number or a host is far
 * shorter, so this changes nothing for them; a name is two words, and a
 * search's answer runs to 200,000 characters, in which "Alex" on one result
 * and "Chen" on another would otherwise name an Alex Chen nobody mentioned —
 * the people the assistant invented had names that common.
 */
export const LEDGER_NEAR_CHARS = 300

/**
 * Whether `holds` is true of the text within some stretch of
 * `LEDGER_NEAR_CHARS`: windows twice that long, a half apart, so every stretch
 * of that length lies whole inside one. Asked of the whole text first — a
 * window can cut a word or an address, and a cut that makes a match the whole
 * text does not have is never counted.
 */
function holdsNear(text: string, holds: (text: string) => boolean): boolean {
  if (!holds(text)) return false
  const span = 2 * LEDGER_NEAR_CHARS
  if (text.length <= span) return true
  for (let at = 0; ; at += LEDGER_NEAR_CHARS) {
    if (holds(text.slice(at, at + span))) return true
    if (at + span >= text.length) return false
  }
}

interface ToolEntry {
  readonly tool: string
  readonly text: string
}

export interface LedgerLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void
}

class Session implements SessionLedger {
  private readonly person: string[] = []
  private readonly personSeen = new Set<string>()
  private personChars = 0
  private readonly tools: ToolEntry[] = []
  private toolChars = 0
  private stored: Promise<void> | null = null
  lastWrite: number

  constructor(
    private readonly db: AgencyDb,
    private readonly orgId: string,
    private readonly sessionId: string,
    private readonly now: () => number,
    private readonly log: LedgerLog | undefined,
  ) {
    this.lastWrite = now()
  }

  addPerson(text: string): void {
    if (typeof text !== 'string') return
    this.keepPerson(text)
    this.lastWrite = this.now()
  }

  /** One of the person's messages; an earlier one read from the database goes in front of those added live. */
  private keepPerson(text: string, earlier = false): void {
    const t = text.length > LEDGER_RESULT_MAX_CHARS ? text.slice(0, LEDGER_RESULT_MAX_CHARS) : text
    if (t.trim() === '' || this.personSeen.has(t)) return
    this.personSeen.add(t)
    if (earlier) this.person.unshift(t)
    else this.person.push(t)
    this.personChars += t.length
    while (this.personChars > LEDGER_PERSON_TEXT_MAX && this.person.length > 1) {
      const dropped = this.person.shift()!
      this.personChars -= dropped.length
      this.personSeen.delete(dropped)
    }
  }

  addToolResult(toolName: string, response: unknown, input: unknown): void {
    if (!resultCountsAsShown(toolName)) return
    const raw = toolResponseText(response, LEDGER_RESULT_MAX_CHARS)
    if (raw.trim() === '') return
    const text = stripEchoes(raw, input)
    if (text === null || text.trim() === '') return
    this.tools.push({ tool: toolName, text })
    this.toolChars += text.length
    while (this.toolChars > LEDGER_TOOL_TEXT_MAX && this.tools.length > 1) {
      this.toolChars -= this.tools.shift()!.text.length
    }
    this.lastWrite = this.now()
  }

  /** The person's earlier messages, read once. A read that fails is tried again on the next question. */
  private loadStored(): Promise<void> {
    if (this.stored) return this.stored
    const attempt: Promise<void> = this.readStored().then((read) => {
      // Forgotten only once it is the one remembered, so the next question asks again.
      if (!read && this.stored === attempt) this.stored = null
    })
    this.stored = attempt
    return attempt
  }

  /** Whether the stored messages were read. Never throws. */
  private async readStored(): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ content: schema.chatMessages.content })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.orgId, this.orgId),
            eq(schema.chatMessages.sessionId, this.sessionId),
            eq(schema.chatMessages.role, 'user'),
          ),
        )
        .orderBy(desc(schema.chatMessages.createdAt))
        .limit(LEDGER_STORED_PERSON_MESSAGES)
      // Newest first, each put in front: they end oldest first, ahead of the
      // messages added live, so the bound drops the oldest of all first.
      for (const row of rows) {
        const text = (row.content as { text?: unknown } | null)?.text
        if (typeof text !== 'string' || BRIEF_PROMPT.test(text)) continue
        this.keepPerson(text, true)
      }
      return true
    } catch (err) {
      try {
        this.log?.warn('could not read the conversation’s earlier messages; only this worker’s own record of it counts', {
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      } catch {
        // A logger that throws must not reach the tool asking.
      }
      return false
    }
  }

  async find(test: (text: string) => boolean): Promise<readonly SeenOrigin[]> {
    await this.loadStored()
    const holds = (text: string): boolean => {
      try {
        return test(text) === true
      } catch {
        return false
      }
    }
    const out: SeenOrigin[] = []
    if (this.person.some(holds)) out.push({ kind: 'person' })
    const named = new Set<string>()
    for (const entry of this.tools) {
      if (named.has(entry.tool) || !holdsNear(entry.text, holds)) continue
      named.add(entry.tool)
      out.push({ kind: 'tool', tool: entry.tool })
    }
    return out
  }
}

export interface ConversationLedgersOptions {
  readonly now?: () => Date
  /** Told, by error class only, when a session's stored messages could not be read. */
  readonly log?: LedgerLog
}

/**
 * Every conversation's ledger, one per worker process. `forSession` hands back
 * the same ledger for a session until it is forgotten — six hours after
 * anything was last added to it, or once 300 other sessions have been used
 * since — so a later turn of the same chat finds what an earlier one was shown.
 */
export class ConversationLedgers {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number
  private readonly log: LedgerLog | undefined

  constructor(opts: ConversationLedgersOptions = {}) {
    const clock = opts.now ?? (() => new Date())
    this.now = () => clock().getTime()
    this.log = opts.log
  }

  forSession(args: { readonly db: AgencyDb; readonly orgId: string; readonly sessionId: string }): SessionLedger {
    const key = `${args.orgId}:${args.sessionId}`
    const at = this.now()
    for (const [k, s] of this.sessions) {
      if (at - s.lastWrite > LEDGER_IDLE_MS) this.sessions.delete(k)
    }
    let session = this.sessions.get(key)
    if (session) {
      // Most recently used goes last; the least recently used is dropped first.
      this.sessions.delete(key)
    } else {
      session = new Session(args.db, args.orgId, args.sessionId, this.now, this.log)
    }
    this.sessions.set(key, session)
    while (this.sessions.size > LEDGER_SESSIONS_MAX) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) break
      this.sessions.delete(oldest.value)
    }
    return session
  }

  /** How many sessions are remembered — for tests. */
  get size(): number {
    return this.sessions.size
  }
}
