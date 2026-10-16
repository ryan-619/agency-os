/**
 * The worker's view of itself, handed to every turn's tools as
 * `ToolContext.ops` (packages/tools/src/spec.ts) — for the ops tools chat
 * offers in place of a terminal: `worker_status`, `recent_errors`,
 * `queue_status` and `rescan_stale`.
 *
 * Built once in `startWorker`, after the single-worker lock, from what the
 * worker already has: `healthInputs()` — the object `/readyz` and the
 * heartbeat row answer from, so the three cannot disagree about the halt or
 * the lock — the SMS decision made once at boot, the boot instant, the
 * version the heartbeat carries, and the ring of recent warnings and errors.
 * `health()` reads them fresh on every call: they move while the worker runs.
 *
 * Nothing here is a host, a URL, an address or a credential (§2.3).
 */
import { RESCAN_SCAN_TIMEOUTS } from '@agency/db'
import { scanDomain, type FetchOptions } from '@agency/scanner'
import type { IcpDefinition, SiteProfile } from '@agency/core'
import type { OpsContext, OpsHealth, OpsScan } from '@agency/tools'
import type { HealthInputs } from '../health.js'
import type { RecentLog } from './recent-log.js'

/** The scanner as `rescan_stale` may call it: `scanDomain`'s shape, a fake's in a test. */
export type ScanDomain = (
  domain: string,
  definition: IcpDefinition,
  opts: FetchOptions & { readonly company?: string },
) => Promise<{ readonly raw: unknown; readonly profile: SiteProfile }>

/**
 * `scan` bound to the nightly rescan's per-hop timeouts (8 s for the
 * homepage, 6 s for each public path) — tighter than the CLI's, because a
 * chat call has a ceiling and a terminal does not. Spread LAST, so nothing a
 * caller passes can widen them, and `rescanWorstCaseMs` — what `rescan_stale`
 * abandons a scan at — is computed from exactly these.
 */
export function withRescanTimeouts(scan: ScanDomain = scanDomain): OpsScan {
  return (domain, definition, opts) => scan(domain, definition, { ...opts, ...RESCAN_SCAN_TIMEOUTS })
}

export interface OpsContextInput {
  /** `healthInputs()` in worker.ts: what /readyz answers from. */
  readonly health: () => HealthInputs
  /** Decided once at boot (`senderProvidersFrom`). */
  readonly sms: 'on' | 'off'
  /** Stamped after the single-worker lock. */
  readonly bootedAt: Date
  /** `workerVersion()`: the npm package version, or null under `node dist/index.js`. */
  readonly version: string | null
  readonly recentLog: RecentLog
  /** The real scanner unless a test hands in another. */
  readonly scan?: OpsScan
}

export function opsContextFrom(input: OpsContextInput): OpsContext {
  const scan = input.scan ?? withRescanTimeouts()
  return {
    health: (): OpsHealth => {
      const now = input.health()
      return {
        halted: now.halted,
        lockHeld: now.lockHeld,
        outreach: now.outreach,
        sms: input.sms,
        chat: now.chatEnabled ? 'enabled' : 'disabled',
        bootedAt: input.bootedAt,
        version: input.version,
        heartbeatWrittenAt: now.heartbeatAt,
      }
    },
    recentLog: () => input.recentLog.entries(),
    scan,
  }
}
