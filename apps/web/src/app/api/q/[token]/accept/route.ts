import type { NextResponse } from 'next/server'
import { buyerAnswer } from '../answer'

/** The buyer accepts a quote through its link, giving their name (0023). Closes the deal won. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await context.params
  return buyerAnswer(request, token, 'accepted')
}
