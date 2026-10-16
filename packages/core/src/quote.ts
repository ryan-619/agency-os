/**
 * Quotes: a priced offer of the agency's own services (2026-10-08).
 *
 * The proposal (`proposalFromFindings`) is derived from a security scan and
 * prices remediation by effort; most businesses this agency now reaches need
 * a website, a listing fixed or reviews earned, and there is no scan to
 * derive that from. A quote is the other document: line items a person
 * chooses — prefilled from the services catalogue the business's needs
 * point at (`servicesFor`) — at the catalogue's prices, with GST and an
 * advance payable by UPI.
 *
 * Everything here is arithmetic and wording, pure. Money is whole units of
 * the currency (rupees), as the catalogue stores it: a quote that says
 * ₹15,000 + 18% GST = ₹17,700 must say it exactly, and floating point is
 * how ₹17,699.999 gets printed. Tax is rounded half up to the unit, once,
 * on the subtotal — the way a GST invoice is totalled, and not per line,
 * which compounds.
 */

/** How a line is charged: the catalogue's `price_unit` vocabulary. */
export const QUOTE_UNITS = ['one_off', 'monthly', 'yearly', 'hourly', 'daily'] as const
export type QuoteUnit = (typeof QUOTE_UNITS)[number]

export const QUOTE_UNIT_WORDS: Readonly<Record<QuoteUnit, string>> = {
  one_off: 'one-off',
  monthly: 'per month',
  yearly: 'per year',
  hourly: 'per hour',
  daily: 'per day',
}

export interface QuoteItem {
  /** The catalogue row it came from, or null for a line typed by hand. */
  readonly serviceId: string | null
  readonly name: string
  readonly description: string | null
  /** Whole, at least 1 — months, hours, pages. */
  readonly quantity: number
  readonly unit: QuoteUnit
  /** Whole units of the currency, before tax. */
  readonly unitPrice: number
}

/** Bounds a quote is held to, here and by the database. */
export const QUOTE_LIMITS = {
  items: 30,
  name: 120,
  description: 600,
  quantity: 10_000,
  /** ₹10 crore a line: far past any real line, and inside a safe integer once multiplied. */
  unitPrice: 100_000_000,
  title: 200,
  intro: 4_000,
  terms: 4_000,
} as const

/** Why a line cannot be quoted, or null. Sentences, for the editor and the tools. */
export function quoteItemProblem(item: QuoteItem, index: number): string | null {
  const at = `Line ${index + 1}`
  if (item.name.trim() === '') return `${at} has no name.`
  if ([...item.name].length > QUOTE_LIMITS.name) return `${at}'s name is over ${QUOTE_LIMITS.name} characters.`
  if (item.description !== null && [...item.description].length > QUOTE_LIMITS.description) {
    return `${at}'s description is over ${QUOTE_LIMITS.description} characters.`
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > QUOTE_LIMITS.quantity) {
    return `${at}'s quantity must be a whole number from 1 to ${QUOTE_LIMITS.quantity.toLocaleString('en-IN')}.`
  }
  if (!Number.isInteger(item.unitPrice) || item.unitPrice < 0 || item.unitPrice > QUOTE_LIMITS.unitPrice) {
    return `${at}'s price must be a whole amount from 0 to ${QUOTE_LIMITS.unitPrice.toLocaleString('en-IN')}.`
  }
  if (!(QUOTE_UNITS as readonly string[]).includes(item.unit)) return `${at} has an unknown unit.`
  return null
}

export interface QuoteTotals {
  readonly subtotal: number
  readonly taxAmount: number
  readonly total: number
  readonly advanceAmount: number
}

/**
 * The totals of a quote: the lines summed, tax on the subtotal rounded half
 * up to the unit, and the advance — a percentage of the total, rounded half
 * up — that the buyer is asked to pay to start.
 */
export function quoteTotals(items: readonly QuoteItem[], taxRatePercent: number, advancePercent: number): QuoteTotals {
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0)
  const rate = Number.isFinite(taxRatePercent) && taxRatePercent > 0 ? taxRatePercent : 0
  // Hundredths of a percent, in integers, so 18% of 15,000 is exactly 2,700.
  const basisPoints = Math.round(rate * 100)
  const taxAmount = Math.floor((subtotal * basisPoints + 5_000) / 10_000)
  const total = subtotal + taxAmount
  const advance = Number.isInteger(advancePercent) && advancePercent > 0 ? Math.min(advancePercent, 100) : 0
  const advanceAmount = Math.floor((total * advance + 50) / 100)
  return { subtotal, taxAmount, total, advanceAmount }
}

/** `Q-2026-0007`: the year it was created in and its place in that year's run. */
export function quoteNumber(year: number, sequence: number): string {
  return `Q-${year}-${String(sequence).padStart(4, '0')}`
}

/** The sequence a quote number carries, or null for one this module did not write. */
export function quoteSequence(number: string, year: number): number | null {
  const m = /^Q-(\d{4})-(\d{4,})$/.exec(number)
  if (!m || Number(m[1]) !== year) return null
  return Number(m[2])
}

/**
 * A GSTIN's shape: two digits for the state, the holder's PAN (five letters,
 * four digits, a letter), the entity's number, `Z`, a check character.
 * Shape only: the check character's arithmetic is not verified here, so a
 * well-formed GSTIN with one wrong character passes, and is caught where a
 * GSTIN is checked for real — the buyer's books.
 */
export function gstinValid(raw: string): boolean {
  return /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(raw)
}

/** A UPI ID (VPA): `name@bank`. Not a secret: it is printed on every quote. */
export function vpaValid(raw: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(raw)
}

/**
 * The UPI link for paying an amount, as the NPCI's deep-link spec reads it:
 * `upi://pay?pa=<vpa>&pn=<payee>&am=<amount>&cu=INR&tn=<note>`. Any UPI app
 * opens it, or scans it as a QR code. The amount carries two decimals.
 */
export function upiPaymentUri(input: {
  readonly vpa: string
  readonly payee: string
  readonly amount: number
  readonly note: string
}): string {
  const params = [
    ['pa', input.vpa],
    ['pn', input.payee],
    ['am', input.amount.toFixed(2)],
    ['cu', 'INR'],
    ['tn', input.note.slice(0, 80)],
  ]
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')}`
}

/** `₹1,50,000`: Indian grouping. Another currency is its code and plain grouping. */
export function formatMoney(amount: number, currency: string): string {
  if (currency === 'INR') return `₹${amount.toLocaleString('en-IN')}`
  return `${currency} ${amount.toLocaleString('en')}`
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!
  const t = TENS[Math.floor(n / 10)]!
  return n % 10 === 0 ? t : `${t} ${ONES[n % 10]}`
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  return [h > 0 ? `${ONES[h]} Hundred` : '', rest > 0 ? belowHundred(rest) : ''].filter(Boolean).join(' ')
}

/**
 * An amount in words the way an Indian invoice prints it, in lakh and crore:
 * 1,50,000 is "Rupees One Lakh Fifty Thousand Only". Whole rupees.
 */
export function rupeesInWords(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0) return ''
  if (amount === 0) return 'Rupees Zero Only'
  const parts: string[] = []
  const crore = Math.floor(amount / 10_000_000)
  const lakh = Math.floor((amount % 10_000_000) / 100_000)
  const thousand = Math.floor((amount % 100_000) / 1_000)
  const rest = amount % 1_000
  if (crore > 0) parts.push(`${crore >= 1_000 ? rupeesInWords(crore).replace(/^Rupees |\sOnly$/g, '') : belowThousand(crore)} Crore`)
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`)
  if (rest > 0) parts.push(belowThousand(rest))
  return `Rupees ${parts.join(' ')} Only`
}

/** A catalogue row, as much of one as a line needs. */
export interface QuotableService {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly priceFrom: number | null
  readonly priceTo: number | null
  readonly priceUnit: string
}

/**
 * A line for a catalogue service: its name and description, quantity 1, at
 * the lower end of its price range (the person raising the quote moves it).
 * A service with no price is quoted at 0, which the editor shows as
 * something to fill in rather than a free gift.
 */
export function quoteItemFromService(service: QuotableService): QuoteItem {
  const unit = (QUOTE_UNITS as readonly string[]).includes(service.priceUnit) ? (service.priceUnit as QuoteUnit) : 'one_off'
  return {
    serviceId: service.id,
    name: service.name.slice(0, QUOTE_LIMITS.name),
    description: service.description ? service.description.slice(0, QUOTE_LIMITS.description) : null,
    quantity: 1,
    unit,
    unitPrice: service.priceFrom ?? service.priceTo ?? 0,
  }
}

/** India's calendar date at `now`, YYYY-MM-DD: a quote's validity is a date where the agency is (IST, +05:30, no DST). */
export function quoteDayIn(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)
}

/**
 * The day a quote raised at `now` stops being valid, `validityDays` later
 * counting India's date that day as the first — so a quote raised at 02:00
 * IST, still the day before in UTC, is not a day short.
 */
export function quoteValidUntil(now: Date, validityDays: number): string {
  const d = new Date(`${quoteDayIn(now)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Math.max(1, Math.floor(validityDays)) - 1)
  return d.toISOString().slice(0, 10)
}

/** Whether a quote valid until `validUntil` (a YYYY-MM-DD date) has lapsed by `now`, in India's day. */
export function quoteLapsed(validUntil: string, now: Date): boolean {
  return quoteDayIn(now) > validUntil
}
