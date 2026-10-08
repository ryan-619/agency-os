/**
 * A reply that asks to be contacted LATER (2026-10-08): "call me next month",
 * "busy till Diwali, try after that", "get back to me in two weeks". Read into
 * a day to follow up on, so the reply becomes a task on that day instead of a
 * note somebody has to remember.
 *
 * Pure. It reads the reply's OWN words (the caller passes `ownWords`, never
 * the quoted thread), only a reply that is not an opt-out and not an
 * auto-reply — the opt-out reader runs first, always — and it claims little:
 * a day is produced only from a time phrase in a sentence that also asks to
 * be contacted, or says now is not the time, and that is not negated ("don't
 * call me next week"). The phrase it returns is OURS ("next month",
 * "in 2 weeks"), never the reply's words, so a task title carries nothing the
 * sender wrote. Anything it is unsure of is null: a task nobody needed costs
 * a click, a day misread costs a call on the wrong day, and no reading
 * costs nothing that the reply sitting in /inbox does not already say.
 */

export interface LaterAsk {
  /** Our words for when: "tomorrow", "on Monday", "next week", "in 2 weeks", "next month", "in March", "after Diwali". */
  readonly phrase: string
  /** The day to follow up on, YYYY-MM-DD, in the zone the reader was given; always after today. */
  readonly day: string
}

/** No follow-up is read further ahead than this. */
export const LATER_ASK_MAX_DAYS = 400

/**
 * Diwali, by year — the one festival people in India most often say "after"
 * of. Lakshmi Puja's date, from the published calendars; a year not listed is
 * not read. Follow up a week after.
 */
export const DIWALI: Readonly<Record<number, string>> = { 2026: '2026-11-08', 2027: '2027-10-29', 2028: '2028-10-17' }

const ASK =
  /\b(call|calling|ring|phone|contact|reach out|reach me|reach us|get back|get in touch|ping|follow up|follow-up|check back|check in|try (?:me|us|again|later)|talk|speak|connect|revisit|circle back|touch base|write|email|mail|message|whatsapp|meet|catch up|discuss|revert)\b/
const BUSY =
  /\b(not now|not right now|not at the moment|not a good time|busy|travell?ing|out of (?:town|station|office)|on leave|on vacation|on holiday|maybe|perhaps|later)\b/
const NEGATED = /\b(?:don'?t|do not|never|no need to|stop|not to)\s+(?:\w+\s+){0,2}$/

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const MONTHS: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)'
const COUNT: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, 'a couple of': 2, 'couple of': 2, two: 2, three: 3, four: 4, five: 5, six: 6, 'a few': 3, few: 3,
}

/** YYYY-MM-DD arithmetic in UTC, so a day is a day wherever this runs. */
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const day0 = (s: string) => new Date(`${s}T00:00:00Z`)
const plusDays = (s: string, n: number) => {
  const d = day0(s)
  d.setUTCDate(d.getUTCDate() + n)
  return ymd(d)
}
const firstOf = (year: number, month: number) => ymd(new Date(Date.UTC(year, month - 1, 1)))
const lastOf = (year: number, month: number) => ymd(new Date(Date.UTC(year, month, 0)))
function plusMonths(s: string, n: number): string {
  const d = day0(s)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return ymd(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))))
}
/** The next date that is `month`/`dom` strictly after `today`. */
function nextDate(today: string, month: number, dom: number): string {
  const t = day0(today)
  for (const y of [t.getUTCFullYear(), t.getUTCFullYear() + 1]) {
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate()
    const c = ymd(new Date(Date.UTC(y, month - 1, Math.min(dom, last))))
    if (c > today) return c
  }
  return ymd(new Date(Date.UTC(t.getUTCFullYear() + 1, month - 1, dom)))
}

type Hit = { readonly at: number; readonly phrase: string; readonly day: string | null }

/** Every time phrase in one sentence, with where it starts. */
function timePhrases(s: string, today: string): Hit[] {
  const hits: Hit[] = []
  const t = day0(today)
  const year = t.getUTCFullYear()
  const month = t.getUTCMonth() + 1
  const add = (re: RegExp, f: (m: RegExpExecArray) => { phrase: string; day: string | null } | null) => {
    const g = new RegExp(re.source, 'g')
    for (let m = g.exec(s); m; m = g.exec(s)) {
      const r = f(m)
      if (r) hits.push({ at: m.index, ...r })
    }
  }
  add(/\bday after tomorrow\b/, () => ({ phrase: 'the day after tomorrow', day: plusDays(today, 2) }))
  add(/(?<!after )\btomorrow\b/, () => ({ phrase: 'tomorrow', day: plusDays(today, 1) }))
  add(new RegExp(`\\b(?:on |next |this |coming )?(${WEEKDAYS.join('|')})\\b`), (m) => {
    const want = WEEKDAYS.indexOf(m[1] as (typeof WEEKDAYS)[number])
    const ahead = ((want - t.getUTCDay() + 7) % 7) || 7
    return { phrase: `on ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`, day: plusDays(today, ahead) }
  })
  add(/\bnext week\b/, () => ({ phrase: 'next week', day: plusDays(today, 7) }))
  add(/\b(?:in|after|within) (?:a |one )?fortnight\b/, () => ({ phrase: 'in 2 weeks', day: plusDays(today, 14) }))
  add(/\b(?:in|after|within|for) (a couple of|couple of|a few|few|an|a|one|two|three|four|five|six|\d{1,2}) (day|week|month)s?\b/, (m) => {
    const n = COUNT[m[1]!] ?? Number(m[1])
    if (!Number.isInteger(n) || n < 1) return null
    const unit = m[2] as 'day' | 'week' | 'month'
    if ((unit === 'day' && n > 60) || (unit === 'week' && n > 26) || (unit === 'month' && n > 12)) return null
    const day = unit === 'day' ? plusDays(today, n) : unit === 'week' ? plusDays(today, 7 * n) : plusMonths(today, n)
    return { phrase: `in ${n} ${unit}${n === 1 ? '' : 's'}`, day }
  })
  add(/\bnext month\b/, () => ({ phrase: 'next month', day: month === 12 ? firstOf(year + 1, 1) : firstOf(year, month + 1) }))
  add(/\bafter (?:the |this )month\b/, () => ({ phrase: 'after this month', day: month === 12 ? firstOf(year + 1, 1) : firstOf(year, month + 1) }))
  add(/\b(?:at |by )?(?:the )?end of (?:the|this) month\b/, () => ({ phrase: 'at the end of the month', day: lastOf(year, month) }))
  add(/\bnext quarter\b/, () => {
    const q = Math.floor((month - 1) / 3) + 1
    return { phrase: 'next quarter', day: q === 4 ? firstOf(year + 1, 1) : firstOf(year, q * 3 + 1) }
  })
  add(/\b(?:next year|after (?:the )?new year)\b/, () => ({ phrase: 'after the new year', day: `${year + 1}-01-02` }))
  add(/\bafter (?:the )?christmas\b/, () => ({ phrase: 'after Christmas', day: nextDate(today, 12, 27) }))
  add(/\bafter (?:the )?(?:diwali|deepavali)\b/, () => {
    const d = [DIWALI[year], DIWALI[year + 1]].find((x): x is string => x !== undefined && plusDays(x, 7) > today)
    return d ? { phrase: 'after Diwali', day: plusDays(d, 7) } : null
  })
  // A month needs a word before it, so "you may call" is not May.
  add(new RegExp(`\\b(in|after|from|by|around|early|mid|late|end of|beginning of|start of|till|until) ${MONTH}\\b`), (m) => {
    const want = MONTHS[m[2]!]!
    const lead = m[1]!
    if (want === month && lead !== 'after' && lead !== 'mid' && lead !== 'late' && lead !== 'end of') return null
    const dom = lead === 'mid' ? 15 : lead === 'late' || lead === 'end of' ? 25 : 1
    if (lead === 'after' || lead === 'till' || lead === 'until') {
      const after = want === 12 ? 1 : want + 1
      return { phrase: `${lead === 'after' ? 'after' : 'from'} ${MONTH_NAMES[want - 1]}`, day: nextDate(today, after, 1) }
    }
    const phrase = `${lead === 'mid' ? 'in mid-' : lead === 'late' || lead === 'end of' ? 'in late ' : lead === 'early' ? 'in early ' : 'in '}${MONTH_NAMES[want - 1]}`
    return { phrase, day: nextDate(today, want, dom) }
  })
  // A day of the month needs an ordinal or a month: "after the 15th", "on 20 October".
  add(new RegExp(`\\b(after|till|until|on|by|from) (?:the )?(\\d{1,2})(?:st|nd|rd|th)(?: (?:of )?${MONTH})?\\b`), (m) => {
    const dom = Number(m[2])
    if (dom < 1 || dom > 31) return null
    const want = m[3] ? MONTHS[m[3]]! : null
    const target = want ? nextDate(today, want, dom) : (() => {
      const thisMonth = `${today.slice(0, 8)}${String(dom).padStart(2, '0')}`
      return dom <= new Date(Date.UTC(year, month, 0)).getUTCDate() && thisMonth > today ? thisMonth : nextDate(today, month === 12 ? 1 : month + 1, dom)
    })()
    const freeAfter = m[1] === 'after' || m[1] === 'till' || m[1] === 'until'
    const day = freeAfter ? plusDays(target, 1) : target
    const label = `${dom}${dom % 10 === 1 && dom !== 11 ? 'st' : dom % 10 === 2 && dom !== 12 ? 'nd' : dom % 10 === 3 && dom !== 13 ? 'rd' : 'th'}`
    return { phrase: `${freeAfter ? 'after' : 'on'} the ${label}${want ? ` of ${MONTH_NAMES[want - 1]}` : ''}`, day }
  })
  add(new RegExp(`\\b(after|till|until|on|by|from) (\\d{1,2}) ${MONTH}\\b`), (m) => {
    const dom = Number(m[2])
    const want = MONTHS[m[3]!]!
    if (dom < 1 || dom > 31) return null
    const target = nextDate(today, want, dom)
    const freeAfter = m[1] === 'after' || m[1] === 'till' || m[1] === 'until'
    return { phrase: `${freeAfter ? 'after' : 'on'} ${dom} ${MONTH_NAMES[want - 1]}`, day: freeAfter ? plusDays(target, 1) : target }
  })
  return hits
}

/**
 * The day a reply asks to be contacted on, or null. `today` is the local date
 * where the reply's sender is (YYYY-MM-DD), so "tomorrow" means theirs.
 */
export function laterAsk(ownWords: string, today: string): LaterAsk | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const text = ownWords.slice(0, 1_500).toLowerCase().replace(/[‘’]/g, "'")
  const sentences = text
    .split(/(?<=[.!?;])\s+|\n+|\s+[-–—]\s+|,\s+(?=but\b)/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x !== '')
  for (const sentence of sentences) {
    const ask = ASK.exec(sentence)
    const busy = BUSY.exec(sentence)
    if (!ask && !busy) continue
    // "Don't call me next week" is not a request to be called next week.
    if (ask && NEGATED.test(sentence.slice(0, ask.index))) continue
    // When they say when they are free again ("after", "till", "until"), that wins over a date that
    // starts an absence ("on leave from the 20th to the 5th, call after the 5th"); otherwise the first
    // time named after the ask ("call me tomorrow, I'm away next week"), then the first at all.
    const askAt = ask?.index ?? 0
    const hits = timePhrases(sentence, today)
      .filter((h): h is Hit & { day: string } => h.day !== null && h.day > today && h.day <= plusDays(today, LATER_ASK_MAX_DAYS))
      .sort((a, b) =>
        Number(!a.phrase.startsWith('after')) - Number(!b.phrase.startsWith('after')) ||
        Number(a.at < askAt) - Number(b.at < askAt) ||
        a.at - b.at)
    const first = hits[0]
    if (first) return { phrase: first.phrase, day: first.day }
  }
  return null
}

/**
 * An instant for a wall-clock time on a day in a zone — 10:00 on the day to
 * follow up — through the runtime's own zone tables, corrected twice across a
 * DST change; null for a zone the runtime does not know.
 */
export function instantAtWallClock(day: string, hhmm: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const t = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m || !t) return null
  const wanted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]))
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return null
  }
  const local = (instant: number): number => {
    const p: Record<string, number> = {}
    for (const part of fmt.formatToParts(new Date(instant))) if (part.type !== 'literal') p[part.type] = Number(part.value)
    return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour === 24 ? 0 : p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
  }
  let guess = wanted
  for (let i = 0; i < 2; i += 1) guess -= local(guess) - wanted
  return new Date(guess)
}
