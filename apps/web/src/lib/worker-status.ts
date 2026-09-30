import 'server-only'
import { heartbeatReport, readLatestHeartbeat, type AgencyDb, type HeartbeatReport } from '@agency/db/queries'
import { deployment } from '@/lib/deployment'

/**
 * Is a worker alive, and when was it last heard from (§2.4)?
 *
 * `deployment().worker` answers a different question — whether this web
 * deployment is CONFIGURED to reach a worker — and stays exactly what it is.
 * This is the health half: the newest row any worker has written to this
 * database, how old it is, and what that worker said it was doing. On Fly a
 * worker scaled to zero is invisible from outside; here it is a number that
 * keeps growing.
 *
 * Read only. The writer is exported from `@agency/db`'s root and never from
 * `./queries`, so nothing in this bundle can claim a worker is alive.
 * The decision about what the row and the flag say together is
 * `heartbeatReport` in packages/db, pure and tested there; this file is the
 * two reads that feed it.
 */
export type WorkerStatus = HeartbeatReport

export async function workerStatus(db: AgencyDb, now: Date): Promise<WorkerStatus> {
  const row = await readLatestHeartbeat(db)
  return heartbeatReport(row, deployment().worker, now)
}
