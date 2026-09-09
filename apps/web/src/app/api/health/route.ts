import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'

/**
 * Liveness + readiness for the web container.
 *
 * Never cached: a health check that reports a stale result is worse than none.
 * `force-dynamic` is still the correct directive in Next 16.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now()
  try {
    await getDb().execute(sql`SELECT 1`)
    return NextResponse.json({
      status: 'ok',
      service: 'web',
      database: 'ok',
      latencyMs: Date.now() - startedAt,
    })
  } catch (err) {
    // The driver error can contain the connection string, so only the class
    // of failure is reported (§2.3).
    return NextResponse.json(
      {
        status: 'degraded',
        service: 'web',
        database: 'unreachable',
        error: err instanceof Error ? err.name : 'UnknownError',
      },
      { status: 503 },
    )
  }
}
