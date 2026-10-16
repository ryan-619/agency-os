/**
 * What a turn really cost, for the models the worker's CLI does not price
 * (2026-10-15).
 *
 * The chat runs on Claude Sonnet 5.5 and "Think harder" on Claude Opus 5.5,
 * and the Claude Code CLI the Agent SDK bundles (2.1.269) predates both. It
 * sends them valid requests — adaptive thinking, effort `high`, measured
 * against a fake API recording each request — but prices a model it does not
 * know at its Opus 4.x fallback rate, $5 / $25 per million tokens, and says
 * so in the result's `modelUsage` (`costBasis: "unknown"`). Recorded as it
 * came, every Sonnet turn would read about two and a half times its price on
 * Settings → Spend and in `./tools/spend.sh`, and count that much against
 * the thread's budget.
 *
 * So a model listed here is re-priced from its own token counts, and every
 * other entry — one the CLI priced from its own list, or a model nobody
 * listed — keeps the CLI's figure. The CLI's own per-turn cap
 * (`maxBudgetUsd`) still counts the fallback rate, which stops a turn
 * earlier than its real price would: the safe direction.
 *
 * Pure: no I/O. Prices are the Claude API's list prices in US dollars per
 * million tokens; a cache write is priced at the five-minute rate, 1.25 times
 * the input price.
 */

export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const MODEL_PRICES_PER_MTOK: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
})

/** The listed price of a model id, ignoring a context-window suffix such as `[1m]`. */
export function modelPrice(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  return Object.hasOwn(MODEL_PRICES_PER_MTOK, id) ? (MODEL_PRICES_PER_MTOK[id] ?? null) : null
}

interface UsageEntry {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly cacheReadInputTokens?: unknown
  readonly cacheCreationInputTokens?: unknown
  readonly costUSD?: unknown
  readonly costBasis?: unknown
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The SDK result's `total_cost_usd`, with each `modelUsage` entry the CLI did
 * NOT price from its own list (`costBasis` other than `"list"`) re-priced
 * from its tokens, where the model is one `MODEL_PRICES_PER_MTOK` lists. The
 * correction is the difference per entry, so whatever else the total carries
 * (a web search, say) stays in it. Cumulative in, cumulative out — the
 * caller's delta logic is unchanged. A shape it cannot read leaves the total
 * as it came.
 */
export function correctedCostUsd(totalCostUsd: number, modelUsage: unknown): number {
  const total = Number.isFinite(totalCostUsd) && totalCostUsd > 0 ? totalCostUsd : 0
  if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) return total
  let corrected = total
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as UsageEntry
    if (entry.costBasis === 'list') continue
    const price = modelPrice(model)
    if (!price) continue
    const real =
      (count(entry.inputTokens) * price.input +
        count(entry.outputTokens) * price.output +
        count(entry.cacheReadInputTokens) * price.cacheRead +
        count(entry.cacheCreationInputTokens) * price.cacheWrite) /
      1_000_000
    corrected += real - count(entry.costUSD)
  }
  return Math.max(0, corrected)
}
