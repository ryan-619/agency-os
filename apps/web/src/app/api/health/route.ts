import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import {
  APPLIED_MIGRATION_SQL,
  EXPECTED_MIGRATION,
  compareSchema,
  parseAppliedMigration,
} from '@agency/db/schema-version'
import type { SchemaAgreement } from '@agency/db/schema-version'
import { getDb } from '@/lib/db'

/**
 * Liveness + readiness for the web container.
 *
 * Never cached: a health check that reports a stale result is worse than none.
 * `force-dynamic` is still the correct directive in Next 16.
 *
 * ── Why this reports the schema, and why it does not fail on it ────────────
 *
 * Migrations here are applied by a person, from a terminal, against a
 * connection string no assistant is allowed to hold (§2.3). That is the right
 * boundary and it is staying — but it left a real gap: nobody deploying could
 * confirm that the migration actually landed, and the failure mode of getting
 * it wrong is nasty. Migrations only ADD, so code that is one migration ahead
 * of its database does not fail at boot. It serves every page fine and then
 * throws `column touches.reply_kind does not exist` the first time somebody
 * approves a draft, days later, in a log nobody is reading.
 *
 * So the schema state is now a fact this endpoint reports, which makes it
 * checkable by anyone who can reach the URL, with no credential involved.
 *
 * It is reported, NOT enforced, and the reason is three lines down in
 * `apps/web/Dockerfile`: the container HEALTHCHECK is
 * `fetch(...).then(r => process.exit(r.ok ? 0 : 1))`. Returning 503 for a
 * behind schema would make Docker and every orchestrator kill the container,
 * restart it, and find the schema still behind — a restart loop, during which
 * the app serves nothing at all instead of serving the 95% of itself that
 * works. Liveness ("can this process serve?") and readiness ("does this
 * deployment agree with its database?") are different questions and only the
 * first one should be allowed to stop the process.
 *
 * `?strict=1` asks the second question and answers it with the status code,
 * for a deploy gate or a human. Nothing automated points at it by default.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

interface SchemaReport {
  state: SchemaAgreement
  expected: string
  applied: string | null
  /** Present only when something is worth doing about it. */
  hint?: string
}

const HINTS: Partial<Record<SchemaAgreement, string>> = {
  behind:
    'The database is missing migrations this code needs. Run ./tools/remote-setup.sh ' +
    'before trusting any feature that touches the newer tables.',
  ahead:
    'A newer revision has already migrated this database. Usually just a rollout in ' +
    'progress; only a problem if this deployment is meant to be the current one.',
  unknown:
    'The migration ledger could not be read, so the database has probably never been ' +
    'migrated. Run ./tools/remote-setup.sh.',
}

/**
 * The highest migration the database admits to, or null if it cannot say.
 *
 * The statement and the row-parsing both live in @agency/db/schema-version, so
 * the test suite exercises the same SQL this route runs rather than a
 * paraphrase of it.
 *
 * A missing ledger is an expected answer, not an exception: it is what a
 * database nobody has migrated yet looks like. This runs outside a
 * transaction, so the failed statement poisons nothing.
 */
async function appliedMigration(): Promise<string | null> {
  try {
    const res = await getDb().execute(sql.raw(APPLIED_MIGRATION_SQL))
    return parseAppliedMigration(res.rows)
  } catch {
    // Deliberately swallowed. The caller reports 'unknown', which is the
    // honest answer, and a driver error can carry the DSN (§2.3) so it is not
    // logged either.
    return null
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const startedAt = Date.now()
  const strict = new URL(request.url).searchParams.get('strict') === '1'

  try {
    await getDb().execute(sql`SELECT 1`)

    const applied = await appliedMigration()
    const state = compareSchema(applied)
    const schema: SchemaReport = {
      state,
      expected: EXPECTED_MIGRATION,
      applied,
      ...(HINTS[state] === undefined ? {} : { hint: HINTS[state] }),
    }

    // 'ahead' is not a failure even under strict: additive migrations mean an
    // older deployment against a newer database keeps working, and a rollout
    // passes through this state every time.
    const disagrees = state === 'behind' || state === 'unknown'

    return NextResponse.json(
      {
        status: disagrees ? 'degraded' : 'ok',
        service: 'web',
        database: 'ok',
        schema,
        latencyMs: Date.now() - startedAt,
      },
      { status: strict && disagrees ? 503 : 200 },
    )
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
