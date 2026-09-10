import { scoreCompany, type IcpDefinition, type ScoreResult, type SiteProfile } from '@agency/core'
import { capture, type FetchOptions } from './fetch.js'
import { extractProfile } from './extract.js'
import type { RawCapture } from './types.js'

export interface ScanOutcome {
  readonly raw: RawCapture
  readonly profile: SiteProfile
  readonly result: ScoreResult
}

/** Fetch, interpret and score one domain. The whole pipeline for one company. */
export async function scanDomain(
  domain: string,
  icp: IcpDefinition,
  opts: FetchOptions & { readonly company?: string } = {},
): Promise<ScanOutcome> {
  const raw = await capture(domain, opts)
  const profile = extractProfile(raw, opts.company)
  return { raw, profile, result: scoreCompany(profile, icp) }
}
