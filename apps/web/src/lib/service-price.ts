/**
 * A service's price in words, for the services page and the company page
 * (0022): "INR 15,000–40,000 one-off", "from INR 8,000 a month", "no price
 * set". Whole units of the currency; Indian grouping for rupees. Pure, and
 * free of `server-only`, so the browser and the server share it.
 */
export const PRICE_UNITS: readonly (readonly [unit: string, words: string])[] = [
  ['one_off', 'one-off'], ['monthly', 'a month'], ['yearly', 'a year'], ['hourly', 'an hour'], ['daily', 'a day'],
]

export function priceLine(s: {
  readonly priceFrom: number | null
  readonly priceTo: number | null
  readonly currency: string
  readonly priceUnit: string
}): string {
  const n = (v: number) => v.toLocaleString(s.currency === 'INR' ? 'en-IN' : 'en')
  const unit = PRICE_UNITS.find(([u]) => u === s.priceUnit)?.[1] ?? s.priceUnit
  if (s.priceFrom !== null && s.priceTo !== null) {
    return s.priceFrom === s.priceTo ? `${s.currency} ${n(s.priceFrom)} ${unit}` : `${s.currency} ${n(s.priceFrom)}–${n(s.priceTo)} ${unit}`
  }
  if (s.priceFrom !== null) return `from ${s.currency} ${n(s.priceFrom)} ${unit}`
  if (s.priceTo !== null) return `up to ${s.currency} ${n(s.priceTo)} ${unit}`
  return 'no price set'
}
