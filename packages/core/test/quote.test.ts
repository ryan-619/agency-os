/**
 * Quotes' arithmetic and words (`src/quote.ts`): a GST invoice's totals,
 * exactly, in whole rupees; the UPI link a phone opens; the amount in words
 * the way an Indian invoice prints it.
 */
import { describe, expect, it } from 'vitest'
import {
  QUOTE_LIMITS, formatMoney, gstinValid, quoteItemFromService, quoteItemProblem, quoteLapsed, quoteNumber,
  quoteSequence, quoteTotals, quoteValidUntil, rupeesInWords, upiPaymentUri, vpaValid, type QuoteItem,
} from '../src/index.js'

const line = (over: Partial<QuoteItem> = {}): QuoteItem => ({
  serviceId: null, name: 'New website', description: null, quantity: 1, unit: 'one_off', unitPrice: 15_000, ...over,
})

describe('quoteTotals', () => {
  it('sums the lines, adds 18% GST on the subtotal, and asks an advance of the total', () => {
    expect(quoteTotals([line(), line({ name: 'Google profile', unitPrice: 5_000, quantity: 2 })], 18, 50)).toEqual({
      subtotal: 25_000, taxAmount: 4_500, total: 29_500, advanceAmount: 14_750,
    })
  })

  it('rounds tax half up to the rupee, once, on the subtotal', () => {
    // 18% of 1,001 is 180.18 → 180; of 1,003 is 180.54 → 181.
    expect(quoteTotals([line({ unitPrice: 1_001 })], 18, 0).taxAmount).toBe(180)
    expect(quoteTotals([line({ unitPrice: 1_003 })], 18, 0).taxAmount).toBe(181)
    // A fractional rate is exact too: 12.5% of 999 is 124.875 → 125.
    expect(quoteTotals([line({ unitPrice: 999 })], 12.5, 0).taxAmount).toBe(125)
  })

  it('charges no tax for a seller who is not registered, and no advance unless asked', () => {
    expect(quoteTotals([line()], 0, 0)).toEqual({ subtotal: 15_000, taxAmount: 0, total: 15_000, advanceAmount: 0 })
    expect(quoteTotals([line()], Number.NaN, -5)).toEqual({ subtotal: 15_000, taxAmount: 0, total: 15_000, advanceAmount: 0 })
  })

  it('never asks more than the total as an advance', () => {
    expect(quoteTotals([line()], 0, 150).advanceAmount).toBe(15_000)
  })

  it('stays exact at the largest lines it allows', () => {
    const big = Array.from({ length: QUOTE_LIMITS.items }, () => line({ unitPrice: QUOTE_LIMITS.unitPrice, quantity: QUOTE_LIMITS.quantity }))
    const t = quoteTotals(big, 18, 50)
    expect(Number.isSafeInteger(t.total)).toBe(true)
    expect(t.total).toBe(t.subtotal + t.taxAmount)
  })
})

describe('quoteItemProblem', () => {
  it('passes a good line and names what is wrong with a bad one, by its position', () => {
    expect(quoteItemProblem(line(), 0)).toBeNull()
    expect(quoteItemProblem(line({ name: '  ' }), 2)).toBe('Line 3 has no name.')
    expect(quoteItemProblem(line({ quantity: 0 }), 0)).toMatch(/quantity/)
    expect(quoteItemProblem(line({ quantity: 1.5 }), 0)).toMatch(/quantity/)
    expect(quoteItemProblem(line({ unitPrice: -1 }), 0)).toMatch(/price/)
    expect(quoteItemProblem(line({ unitPrice: 10.5 }), 0)).toMatch(/price/)
    expect(quoteItemProblem(line({ unit: 'weekly' as never }), 0)).toMatch(/unit/)
    expect(quoteItemProblem(line({ name: 'x'.repeat(QUOTE_LIMITS.name + 1) }), 0)).toMatch(/name/)
  })
})

describe('numbers, IDs and links', () => {
  it('numbers a quote by its year and place, and reads the place back', () => {
    expect(quoteNumber(2026, 7)).toBe('Q-2026-0007')
    expect(quoteNumber(2026, 12_345)).toBe('Q-2026-12345')
    expect(quoteSequence('Q-2026-0007', 2026)).toBe(7)
    expect(quoteSequence('Q-2025-0007', 2026)).toBeNull()
    expect(quoteSequence('INV-7', 2026)).toBeNull()
  })

  it('knows a GSTIN and a UPI ID by their shapes', () => {
    expect(gstinValid('29ABCDE1234F1Z5')).toBe(true)
    expect(gstinValid('29abcde1234f1z5')).toBe(false)
    expect(gstinValid('29ABCDE1234F1X5')).toBe(false)
    expect(gstinValid('')).toBe(false)
    expect(vpaValid('accemy@okhdfcbank')).toBe(true)
    expect(vpaValid('ryan.sharma-1@ybl')).toBe(true)
    expect(vpaValid('accemy')).toBe(false)
    expect(vpaValid('a@b')).toBe(false)
  })

  it('builds the UPI link any UPI app opens, every value encoded', () => {
    expect(upiPaymentUri({ vpa: 'accemy@okhdfcbank', payee: 'Accemy & Co', amount: 14_750, note: 'Advance Q-2026-0007' })).toBe(
      'upi://pay?pa=accemy%40okhdfcbank&pn=Accemy%20%26%20Co&am=14750.00&cu=INR&tn=Advance%20Q-2026-0007',
    )
  })

  it('prints rupees in Indian grouping, and another currency by its code', () => {
    expect(formatMoney(150_000, 'INR')).toBe('₹1,50,000')
    expect(formatMoney(1_234_567, 'USD')).toBe('USD 1,234,567')
  })
})

describe('rupeesInWords', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [7, 'Rupees Seven Only'],
    [15, 'Rupees Fifteen Only'],
    [40, 'Rupees Forty Only'],
    [99, 'Rupees Ninety Nine Only'],
    [100, 'Rupees One Hundred Only'],
    [17_700, 'Rupees Seventeen Thousand Seven Hundred Only'],
    [150_000, 'Rupees One Lakh Fifty Thousand Only'],
    [2_50_00_000, 'Rupees Two Crore Fifty Lakh Only'],
    [12_34_56_789, 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only'],
  ])('%i', (n, words) => {
    expect(rupeesInWords(n)).toBe(words)
  })

  it('says nothing for an amount that is not a whole number of rupees', () => {
    expect(rupeesInWords(10.5)).toBe('')
    expect(rupeesInWords(-1)).toBe('')
  })
})

describe('from the catalogue, and validity', () => {
  it('quotes a service at the low end of its range, once, in its own unit', () => {
    expect(quoteItemFromService({
      id: 's1', name: 'Website care', description: 'Updates and backups', priceFrom: 3_000, priceTo: 6_000, priceUnit: 'monthly',
    })).toEqual({ serviceId: 's1', name: 'Website care', description: 'Updates and backups', quantity: 1, unit: 'monthly', unitPrice: 3_000 })
    expect(quoteItemFromService({ id: 's2', name: 'Logo', description: null, priceFrom: null, priceTo: null, priceUnit: 'odd' }))
      .toMatchObject({ unit: 'one_off', unitPrice: 0 })
  })

  it('is valid for the days asked, counting the day it was raised, and lapses after the last one in India', () => {
    expect(quoteValidUntil(new Date('2026-10-08T07:00:00Z'), 15)).toBe('2026-10-22')
    expect(quoteValidUntil(new Date('2026-10-08T07:00:00Z'), 1)).toBe('2026-10-08')
    // 02:00 IST on 9 October is still 8 October in UTC: the quote counts India's day, so it is not a day short.
    expect(quoteValidUntil(new Date('2026-10-08T20:30:00Z'), 15)).toBe('2026-10-23')
    expect(quoteLapsed('2026-10-08', new Date('2026-10-08T18:29:00Z'))).toBe(false)
    expect(quoteLapsed('2026-10-08', new Date('2026-10-08T18:30:00Z'))).toBe(true)
    // 23:59 IST on the last day is still valid; 00:00 IST the next day is not.
    expect(quoteLapsed('2026-10-22', new Date('2026-10-22T18:29:00Z'))).toBe(false)
    expect(quoteLapsed('2026-10-22', new Date('2026-10-22T18:30:00Z'))).toBe(true)
  })
})
