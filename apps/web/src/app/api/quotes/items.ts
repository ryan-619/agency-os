import { z } from 'zod'
import { QUOTE_UNITS, type QuoteItem } from '@agency/core'

/** A line as the editor sends it. The rules on each field are core's (`quoteItemProblem`), applied by the db layer. */
export const quoteItemInput = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  name: z.string().max(200),
  description: z.string().max(1000).nullable().optional(),
  quantity: z.number(),
  unit: z.enum(QUOTE_UNITS),
  unitPrice: z.number(),
})

export const quoteItemsInput = z.array(quoteItemInput).max(30)

export function itemsFrom(raw: z.infer<typeof quoteItemsInput>): QuoteItem[] {
  return raw.map((i) => ({
    serviceId: i.serviceId ?? null,
    name: i.name.trim(),
    description: i.description?.trim() ? i.description.trim() : null,
    quantity: i.quantity,
    unit: i.unit,
    unitPrice: i.unitPrice,
  }))
}
