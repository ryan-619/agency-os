import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import {
  APPLIED_MIGRATION_SQL,
  EXPECTED_MIGRATION,
  compareSchema,
  parseAppliedMigration,
} from '@agency/db/schema-version'
import type { SchemaAgreement } from '@agency/db/schema-version'
import { heartbeatReportedStatus, type AgencyDb, type HeartbeatReportedStatus } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { workerStatus, type WorkerStatus } from '@/lib/worker-status'

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
 *
 * ── The worker, reported the same way ──────────────────────────────────────
 *
 * `worker` is the newest heartbeat any worker has written to this database:
 * when, how long ago, and what it said it was doing. It exists because Fly
 * scales a machine to zero and a worker that was scaled away answers its own
 * `/readyz` fine the moment something wakes it — so "is the tick running?"
 * had no answer anywhere except a queue somebody noticed had stopped moving.
 *
 * It never changes this endpoint's status or code, not even under strict.
 * Strict asks whether THIS deployment agrees with its database; whether a
 * different process is alive is a fact to read, and a web container
 * restarted because a worker elsewhere went quiet would serve nothing and
 * fix nothing. A heartbeat that cannot be read — 0018 not applied, most
 * likely, which `schema` above will already be saying — is `worker: null`
 * with the error's class, never a 5xx.
 *
 * Its `status` is the digest's word for the same row (`heartbeatReportedStatus`):
 * `retired`, with `retired: true`, where no worker is configured and the
 * newest heartbeat is more than a week old — a session somebody ran by hand
 * and closed, whose row nothing will ever prune — rather than `silent`, which
 * the daily cron alerts on.
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

/** `WorkerStatus` as JSON: the instant as an ISO string, and the status as the digest says it. */
type WorkerReport = Omit<WorkerStatus, 'lastSeenAt' | 'status'> & {
  lastSeenAt: string | null
  status: HeartbeatReportedStatus
}

/**
 * The worker's heartbeat, or null with the reason's class. Swallowed here and
 * not in the outer handler, because the outer handler's answer is 503 and a
 * missing heartbeat table is not a reason for this process to look dead.
 */
async function workerReport(now: Date): Promise<{ worker: WorkerReport | null; workerError?: string }> {
  try {
    const s = await workerStatus(getDb() as unknown as AgencyDb, now)
    return { worker: { ...s, status: heartbeatReportedStatus(s), lastSeenAt: s.lastSeenAt?.toISOString() ?? null } }
  } catch (err) {
    // The class only: a driver error can carry the DSN (§2.3).
    return { worker: null, workerError: err instanceof Error ? err.name : 'UnknownError' }
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

    const worker = await workerReport(new Date())

    return NextResponse.json(
      {
        status: disagrees ? 'degraded' : 'ok',
        service: 'web',
        database: 'ok',
        schema,
        ...worker,
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
        // Present on every answer, and null is one: with no database there
        // is no heartbeat to read.
        worker: null,
      },
      { status: 503 },
    )
  }
}
