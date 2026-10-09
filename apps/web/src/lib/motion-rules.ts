/**
 * The pure half of the motion layer (2026-10-09): which text a counter may
 * count up to, how it writes the numbers on the way, and which click starts
 * the page-loading bar. No DOM and no `@/` import, so `apps/web/test` reads it
 * directly.
 */

/** A counter counts up only to a number written plainly, and ends on exactly the text it found. */
export interface CountPlan {
  readonly to: number
  readonly decimals: number
  /** How the number was grouped: not at all, Indian (1,23,456) or international (123,456). */
  readonly grouping: 'none' | 'en-IN' | 'en-US'
}

/** Above this a count-up is a blur, not a number; such a figure is left as it is. */
export const COUNT_MAX = 10_000_000

export function formatCount(value: number, plan: CountPlan): string {
  const v = Number(value.toFixed(plan.decimals))
  if (plan.grouping === 'none') return v.toFixed(plan.decimals)
  return v.toLocaleString(plan.grouping, { minimumFractionDigits: plan.decimals, maximumFractionDigits: plan.decimals })
}

/**
 * The plan for counting up to `text`, or null when it is not one plain
 * non-negative number — a currency, a unit, a date, a range or a word all
 * stay as they are. A plan is returned only when writing its own target
 * reproduces `text` exactly, so a counter can never end on different text
 * from the text the page was rendered with.
 */
export function countPlan(text: string): CountPlan | null {
  const t = text.trim()
  if (!/^\d[\d,]*(?:\.\d+)?$/.test(t)) return null
  const [whole = '', frac = ''] = t.split('.')
  const to = Number(`${whole.replace(/,/g, '')}${frac ? `.${frac}` : ''}`)
  if (!Number.isFinite(to) || to > COUNT_MAX) return null
  const decimals = frac.length
  const candidates: CountPlan['grouping'][] = whole.includes(',') ? ['en-IN', 'en-US'] : ['none']
  for (const grouping of candidates) {
    const plan: CountPlan = { to, decimals, grouping }
    if (formatCount(to, plan) === t) return plan
  }
  return null
}

/** The parts of an anchor and of the current page the loading bar's decision needs. */
export interface LinkFacts {
  readonly href: string
  readonly target: string
  readonly download: boolean
}

/**
 * Whether following this link loads another page of this app, so the bar at
 * the top should start: same origin, the same tab, not a download, not an
 * API route (a file or a redirect), and not a jump within the page.
 */
export function startsNavigation(link: LinkFacts, here: string): boolean {
  if (link.download || (link.target !== '' && link.target !== '_self')) return false
  let to: URL
  let from: URL
  try {
    from = new URL(here)
    to = new URL(link.href, from)
  } catch {
    return false
  }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return false
  if (to.origin !== from.origin) return false
  if (to.pathname.startsWith('/api/')) return false
  return to.pathname !== from.pathname || to.search !== from.search
}
