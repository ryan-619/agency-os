import type { NextResponse } from 'next/server'
import { buyerAnswer } from '../answer'

/** The buyer declines a quote through its link, with a reason if they give one (0023). */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await context.params
  return buyerAnswer(request, token, 'declined')
}
