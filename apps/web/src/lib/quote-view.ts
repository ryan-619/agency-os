/**
 * What a quote document shows (0023), as plain data: the print view, the
 * buyer's page behind its link and the editor's preview all render this.
 *
 * Pure and free of `server-only` and `@/` imports, so a test can load it.
 * The UPI QR code is drawn here, as SVG, from the payment link — by a small
 * library with no dependencies and nothing fetched: the code a buyer's phone
 * scans never touches a third party's server.
 */
import qrcode from 'qrcode-generator'
import { QUOTE_UNIT_WORDS, formatMoney, rupeesInWords, upiPaymentUri, type QuoteItem, type QuoteUnit } from '@agency/core'

export interface QuoteSellerView {
  readonly name: string
  readonly legalName: string | null
  readonly address: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly website: string | null
  readonly gstin: string | null
  readonly upiVpa: string | null
  readonly upiPayee: string | null
  readonly brochureUrl: string | null
}

export interface QuoteView {
  readonly number: string
  readonly title: string
  readonly intro: string | null
  readonly status: string
  /** YYYY-MM-DD: the day it was raised, or sent once it was. */
  readonly dated: string
  readonly validUntil: string
  readonly currency: string
  readonly items: readonly QuoteItem[]
  readonly subtotal: number
  readonly taxRate: number
  readonly taxAmount: number
  readonly total: number
  readonly advancePercent: number
  readonly advanceAmount: number
  readonly needs: readonly { readonly label: string; readonly evidence: readonly string[] }[]
  readonly terms: string | null
  readonly seller: QuoteSellerView
  readonly buyer: { readonly company: string; readonly contact: string | null }
}

export const money = (amount: number, currency: string): string => formatMoney(amount, currency)

export function unitWords(unit: QuoteUnit | string): string {
  return Object.prototype.hasOwnProperty.call(QUOTE_UNIT_WORDS, unit) ? QUOTE_UNIT_WORDS[unit as QuoteUnit] : unit
}

/** The amount in words, for rupees only — the way an Indian invoice prints it. */
export function amountInWords(amount: number, currency: string): string | null {
  return currency === 'INR' ? rupeesInWords(amount) : null
}

/** The QR code for a link, as an SVG element's markup. */
export function qrSvg(text: string, cellSize = 4): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true })
}

export interface QuotePayment {
  readonly uri: string
  readonly svg: string
  readonly vpa: string
  readonly payee: string
  readonly amount: number
}

/**
 * How the buyer pays the advance by UPI, or null — no UPI ID on the seller,
 * no advance asked, or not rupees. The note names the quote, so the payment
 * arrives saying what it is for.
 */
export function quotePayment(view: Pick<QuoteView, 'seller' | 'advanceAmount' | 'currency' | 'number'>): QuotePayment | null {
  const vpa = view.seller.upiVpa
  if (!vpa || view.advanceAmount <= 0 || view.currency !== 'INR') return null
  const payee = view.seller.upiPayee || view.seller.legalName || view.seller.name
  const uri = upiPaymentUri({ vpa, payee, amount: view.advanceAmount, note: `Advance ${view.number}` })
  return { uri, svg: qrSvg(uri), vpa, payee, amount: view.advanceAmount }
}

/** What the buyer's page says for a quote that cannot be accepted, or null when it can. */
export function buyerQuoteClosed(status: string, lapsed: boolean): string | null {
  if (status === 'accepted') return 'You accepted this quote. Thank you — we will be in touch about the next steps.'
  if (status === 'declined') return 'This quote was declined.'
  if (status === 'withdrawn' || status === 'draft') return 'This quote is no longer open. Please ask us for an updated one.'
  if (lapsed) return 'This quote’s validity has passed. Please ask us for an updated one.'
  return null
}
