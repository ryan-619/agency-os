/**
 * The pipeline's numbers: how many deals sit where, how many went on from
 * each stage, how long a stay in a stage lasts, how often a closed deal was
 * won, and how long winning took.
 *
 * Pure arithmetic over rows somebody else read. Two inputs, and they are not
 * equally good:
 *
 *   - `deals` is the table itself. The current stage, `created_at` and
 *     `closed_at` are facts, so the per-stage counts, the win rate and the
 *     velocity are exact.
 *   - `transitions` is the audit log's record of MOVES — a person's
 *     `deal.moved` from the board and `advanceDeal`'s own `deal.created` /
 *     `deal.advanced` rows. It is incomplete by construction: a stage the
 *     agent sets with `update_deal` and a proposal accepted as won are
 *     recorded only inside other audit actions, and so is every automatic
 *     move made before `advanceDeal` wrote its own rows. So conversion and
 *     time-in-stage are counted from what WAS recorded, and every count is a
 *     lower bound. `ANALYTICS_NOTE` says so, and the page prints it.
 *
 * Below `minSample` a figure is `null`, not a small number: "one of one" is
 * a 100% conversion rate and it means nothing. Every figure is returned WITH
 * the count it was computed from, so the page cannot show one without the
 * other (§2.2's rule, applied to arithmetic: never state what was not
 * observed, and a ratio of two is not an observation of a rate).
 */

const MS_PER_DAY = 86_400_000

/** The stage vocabulary, in pipeline order (0003's CHECK). */
const STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'] as const
/** The stages a deal can be IN and leave forward. */
const OPEN_STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal'] as const

/** `won` and `lost` share a rank: both are the end, and neither is past the other. */
const RANK: Readonly<Record<string, number>> = Object.freeze({
  new: 0, contacted: 1, replied: 2, meeting: 3, proposal: 4, won: 5, lost: 5,
})

export const DEFAULT_MIN_SAMPLE = 5

/**
 * The sentence every consumer of these numbers must carry. One source, so
 * the page and the agent's tool say the same thing about the same figures.
 */
export const ANALYTICS_NOTE =
  'Stage counts, win rate and velocity are read from the deals themselves. Conversion and time in ' +
  'stage are read from the moves the audit log recorded: a stage the agent set with update_deal, a ' +
  'proposal accepted as won, and any automatic move made before deals recorded their own moves are ' +
  'written only inside other audit actions, so those counts are lower bounds. A deal still in a stage ' +
  'counts as having entered it and not yet advanced.'

/** What `pipelineMetrics` needs from a deal. A `deals` row satisfies it as it is. */
export interface DealFact {
  readonly id: string
  readonly stage: string
  readonly createdAt: Date
  readonly closedAt: Date | null
  readonly updatedAt: Date | null
}

/** One recorded move. `from` is null when the move created the deal or did not say. */
export interface Transition {
  readonly dealId: string
  readonly from: string | null
  readonly to: string
  readonly at: Date
}

export interface PipelineMetrics {
  /** Deals currently at each stage; `open` excludes the closed ones. */
  readonly perStage: readonly { readonly stage: string; readonly open: number; readonly total: number }[]
  /**
   * For each stage: of the deals known to have entered it, how many are
   * known to have gone on to a later stage (not `lost`). `to` names the next
   * stage; a deal that skipped it — a booking that went straight to
   * `meeting` — still counts as advanced.
   */
  readonly conversion: readonly {
    readonly from: string
    readonly to: string
    readonly entered: number
    readonly advanced: number
    readonly rate: number | null
  }[]
  /**
   * The median length of a stay in each open stage, counted only from stays
   * whose arrival AND departure were both recorded. A stay still going, or
   * one whose other end is missing, is not a sample.
   */
  readonly medianDaysInStage: readonly { readonly stage: string; readonly days: number | null; readonly sample: number }[]
  /** Closed deals only: an open deal has not been won OR lost. */
  readonly winRate: { readonly won: number; readonly closed: number; readonly rate: number | null }
  /** Median days from a won deal's creation to its close. */
  readonly velocityDays: number | null
  /** How many won deals `velocityDays` was computed from. */
  readonly velocitySample: number
  /** The floor below which a figure is null. */
  readonly minSample: number
  /** The moment the deals were read — what "currently" means above. */
  readonly asOf: Date
  readonly note: string
}

/**
 * The pipeline's numbers from the deals and the recorded moves.
 *
 * Deterministic: the same rows give the same answer in any order, and the
 * clock is an argument. `now` is the moment `deals` was read, and it is
 * returned as `asOf` so a figure is never shown without the moment it
 * describes. A deal's current stage is placed after every recorded move —
 * where the present belongs even when some clock was wrong — rather than
 * dropping a move stamped after `now`, which a database clock a second ahead
 * of the app's would otherwise do to the freshest row there is.
 */
export function pipelineMetrics(
  deals: readonly DealFact[],
  transitions: readonly Transition[],
  now: Date,
  { minSample = DEFAULT_MIN_SAMPLE }: { readonly minSample?: number } = {},
): PipelineMetrics {
  const floor = Number.isFinite(minSample) && minSample >= 1 ? Math.floor(minSample) : DEFAULT_MIN_SAMPLE
  const enough = (n: number): boolean => n >= floor

  // A move to the stage it came from is not a move, and a stage outside the
  // vocabulary is not one this module can place. Sorted once, with a total
  // order, so the input's order cannot change the answer.
  const moves = transitions
    .filter((t) => isStage(t.to) && (t.from === null || isStage(t.from)) && t.from !== t.to)
    .filter((t) => Number.isFinite(t.at.getTime()))
    .sort(byTimeThenIdentity)

  const byDeal = new Map<string, Transition[]>()
  for (const t of moves) {
    const list = byDeal.get(t.dealId)
    if (list) list.push(t)
    else byDeal.set(t.dealId, [t])
  }
  const current = new Map<string, DealFact>()
  for (const d of deals) current.set(d.id, d)

  // ---- per stage: the table, exactly -------------------------------------
  const perStage = STAGES.map((stage) => {
    const here = deals.filter((d) => d.stage === stage)
    return { stage, open: here.filter((d) => d.closedAt === null).length, total: here.length }
  })

  // ---- conversion: from each deal's known path ---------------------------
  // A path is every stage the deal is KNOWN to have been at, in order: each
  // move's `from` then its `to`, then the stage it is at now. Deals that
  // appear only in the audit log (a company since deleted) keep their
  // recorded history; deals with no recorded move are known by where they
  // are now.
  const ids = [...new Set([...byDeal.keys(), ...current.keys()])].sort()
  const paths = ids.map((id) => {
    const path: string[] = []
    const push = (stage: string): void => {
      if (path[path.length - 1] !== stage) path.push(stage)
    }
    for (const t of byDeal.get(id) ?? []) {
      if (t.from !== null) push(t.from)
      push(t.to)
    }
    const deal = current.get(id)
    if (deal && isStage(deal.stage)) push(deal.stage)
    return path
  })

  const conversion = OPEN_STAGES.map((from, i) => {
    const to = STAGES[i + 1]!
    let entered = 0
    let advanced = 0
    for (const path of paths) {
      const first = path.indexOf(from)
      if (first === -1) continue
      entered++
      if (path.slice(first + 1).some((s) => s !== 'lost' && RANK[s]! > RANK[from]!)) advanced++
    }
    return { from, to, entered, advanced, rate: enough(entered) ? advanced / entered : null }
  })

  // ---- time in stage: stays with both ends recorded ----------------------
  const stays = new Map<string, number[]>()
  for (const list of byDeal.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const arrived = list[i]!
      const left = list[i + 1]!
      // The departure must name the stage the arrival reached. Anything
      // else means a move in between went unrecorded, and the length of
      // the stay is not known.
      if (left.from !== arrived.to) continue
      const days = (left.at.getTime() - arrived.at.getTime()) / MS_PER_DAY
      const bucket = stays.get(arrived.to)
      if (bucket) bucket.push(days)
      else stays.set(arrived.to, [days])
    }
  }
  const medianDaysInStage = OPEN_STAGES.map((stage) => {
    const sample = stays.get(stage) ?? []
    return { stage, days: enough(sample.length) ? oneDecimal(median(sample)) : null, sample: sample.length }
  })

  // ---- win rate and velocity: the table, exactly -------------------------
  const closed = deals.filter((d) => d.closedAt !== null && (d.stage === 'won' || d.stage === 'lost'))
  const wonDeals = closed.filter((d) => d.stage === 'won')
  const winRate = {
    won: wonDeals.length,
    closed: closed.length,
    rate: enough(closed.length) ? wonDeals.length / closed.length : null,
  }
  const cycle = wonDeals.map((d) => (d.closedAt!.getTime() - d.createdAt.getTime()) / MS_PER_DAY)
    .filter((n) => Number.isFinite(n) && n >= 0)

  return {
    perStage,
    conversion,
    medianDaysInStage,
    winRate,
    velocityDays: enough(cycle.length) ? oneDecimal(median(cycle)) : null,
    velocitySample: cycle.length,
    minSample: floor,
    asOf: now,
    note: ANALYTICS_NOTE,
  }
}

/** An own key of the vocabulary — `'toString' in RANK` is true, and is not a stage. */
function isStage(stage: string): boolean {
  return Object.prototype.hasOwnProperty.call(RANK, stage)
}

/** The middle value; the mean of the two middle values for an even count. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function oneDecimal(n: number): number {
  return Math.round(n * 10) / 10
}

function byTimeThenIdentity(a: Transition, b: Transition): number {
  return (
    a.at.getTime() - b.at.getTime() ||
    (a.dealId < b.dealId ? -1 : a.dealId > b.dealId ? 1 : 0) ||
    // Two moves of one deal in the same millisecond: the one that LEAVES
    // the stage the other reached goes second.
    (a.to === b.from ? -1 : b.to === a.from ? 1 : 0) ||
    RANK[a.to]! - RANK[b.to]! ||
    text(a.to, b.to) ||
    text(a.from ?? '', b.from ?? '')
  )
}

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
