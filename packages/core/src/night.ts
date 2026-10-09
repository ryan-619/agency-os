/**
 * The night shift's morning list (0025): which of the businesses found
 * overnight are worth a person's morning first. Pure.
 *
 * A business is worth more the more it NEEDS — each need is evidence of work
 * the agency sells, read only from what was observed (`needsOf`) — and more
 * again when it can be called (a phone on its listing) and is established
 * enough to pay for the work (a good rating, many reviews). Reviews count up
 * to 300 and no further, so a famous chain does not outrank a clinic that
 * needs a website.
 */
export interface NightCandidate {
  readonly needs: number
  readonly hasPhone: boolean
  readonly rating: number | null
  readonly reviews: number | null
}

export function nightScore(c: NightCandidate): number {
  const reviews = Math.min(Math.max(c.reviews ?? 0, 0), 300)
  return c.needs * 3 + (c.hasPhone ? 2 : 0) + (c.rating !== null && c.rating >= 4 ? 1 : 0) + reviews / 100
}

/** The best `limit`, best first; ties keep the order they came in. */
export function nightRank<T extends NightCandidate>(candidates: readonly T[], limit: number): T[] {
  return candidates
    .map((c, i) => ({ c, i, s: nightScore(c) }))
    .filter((x) => x.c.needs > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c)
}
